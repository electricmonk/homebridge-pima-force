import { EventEmitter } from 'node:events';
import net from 'node:net';
import {
  ackFrame,
  buildAck,
  buildDataReq,
  buildOperation,
  dataReqFrame,
  EVENT_TYPE_BURGLARY,
  EVENT_TYPE_COMM,
  EVENT_TYPE_LOCAL_ARM,
  EVENT_TYPE_OUTPUT,
  EVENT_TYPE_REMOTE_ARM,
  EVENT_TYPE_ZONE,
  operationFrame,
  OPTYPE_ACTIVATE_OUTPUT,
  OPTYPE_ARM_AWAY,
  OPTYPE_ARM_HOME1,
  OPTYPE_ARM_HOME2,
  OPTYPE_ARM_HOME3,
  OPTYPE_ARM_HOME4,
  OPTYPE_ARM_SHABBAT,
  OPTYPE_DEACTIVATE_OUTPUT,
  OPTYPE_DISARM,
  PARAM_ID_NUMBER_OF_INSTALLED_ZONES,
  PARAM_ID_SYSTEM_KEY_STATUS,
  PARAM_ID_ZONE_NAMES,
  parseFrames,
  QUALIFIER_NEW,
  QUALIFIER_RESTORE,
  shouldAck,
} from './protocol.js';
import type {
  ArmEventSource,
  ArmMode,
  DataResponse,
  PanelFrame,
  PartitionConfig,
  PimaDriverConfig,
  PimaDriverEvents,
} from './types.js';

/**
 * Per-request timeout for `requestData`. The real panel typically responds
 * in well under a second on a LAN; 5s leaves headroom for slow / loaded
 * panels while still failing fast enough that a wedged request doesn't
 * stall serialized work for too long.
 */
const REQUEST_DATA_TIMEOUT_MS = 5000;

const ARM_MODE_TO_OPTYPE: Record<ArmMode, number> = {
  away:    OPTYPE_ARM_AWAY,
  home1:   OPTYPE_ARM_HOME1,
  home2:   OPTYPE_ARM_HOME2,
  home3:   OPTYPE_ARM_HOME3,
  home4:   OPTYPE_ARM_HOME4,
  shabbat: OPTYPE_ARM_SHABBAT,
};

/**
 * Driver for the Pima FORCE alarm panel local CMS protocol.
 *
 * Architecturally inverted: the panel is the TCP client and dials *out*
 * to us. We act as the CMS receiver. We can issue OPERATION commands
 * (arm/disarm) only while a panel-initiated connection is live.
 */
export class PimaDriver extends EventEmitter<PimaDriverEvents> {
  private readonly config: PimaDriverConfig;
  private readonly partitionByCode: Map<number, PartitionConfig>;
  private server: net.Server | null = null;
  private activeSocket: net.Socket | null = null;
  private opCounter: number;
  /** True once the panel has sent a frame with a matching account number. */
  private panelVerified = false;
  /**
   * Tail of the serialized DATA-REQ chain. Every requestData() call chains
   * its actual send-and-await on top, so only one DATA-REQ is in flight at
   * a time. The real panel rejects (NAK counter=0 "JSON frame") and/or
   * silently drops racing DATA-REQs, so serializing here is a wire-protocol
   * requirement, not a stylistic choice.
   */
  private requestQueueTail: Promise<unknown> = Promise.resolve();

  constructor(config: PimaDriverConfig) {
    super();
    this.config = config;
    this.partitionByCode = new Map(config.partitions.map((p) => [p.id, p]));
    this.opCounter = config.opCounterStart ?? 5000;
  }

  start(): Promise<void> {
    if (this.server) throw new Error('driver already started');
    return new Promise((resolve, reject) => {
      const server = net.createServer((sock) => this.handleConnection(sock));
      server.once('error', reject);
      server.listen(this.config.port, () => {
        server.removeListener('error', reject);
        this.server = server;
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      this.activeSocket?.destroy();
      this.activeSocket = null;
      if (!this.server) return resolve();
      this.server.close(() => {
        this.server = null;
        resolve();
      });
    });
  }

  isConnected(): boolean {
    return this.activeSocket !== null && !this.activeSocket.destroyed;
  }

  /**
   * Arm a partition. Defaults to AWAY (full arm). Panel-recognized modes
   * are mapped per Appendix B of the Force JSON spec.
   */
  arm(partition: number, mode: ArmMode = 'away'): Promise<void> {
    const optype = ARM_MODE_TO_OPTYPE[mode];
    if (optype === undefined) {
      return Promise.reject(new Error(`unknown arm mode: ${mode}`));
    }
    return this.sendOperation(optype, partition);
  }

  disarm(partition: number): Promise<void> {
    return this.sendOperation(OPTYPE_DISARM, partition);
  }

  /**
   * Activate or de-activate a panel output. Output 1 = external siren,
   * 2 = internal siren, 34-41 = controlled outputs 1-8 (Appendix B).
   *
   * The OPERATION partition field is 0 (panel-wide). The user code from
   * the first configured partition is used to authorize.
   */
  /**
   * Request a configuration/status parameter from the panel (DATA-REQ) and
   * resolve with the matching DATA frame's contents.
   *
   * Calls are serialized internally: a second call won't write anything to
   * the wire until the first has settled (resolved on DATA, rejected on NAK,
   * or timed out). This mirrors the panel's own one-request-at-a-time
   * behaviour — issuing concurrent DATA-REQs causes the panel to NAK or
   * drop racing requests.
   *
   * Authorization uses the first configured partition's user code unless
   * `params.password` is provided.
   *
   * Pagination is not handled here: when `more: true`, the caller is
   * responsible for issuing the follow-up request.
   */
  requestData(params: { id: number; startOrder: number; stopOrder?: number; password?: string }): Promise<DataResponse> {
    const part = this.config.partitions[0];
    if (!part && !params.password) {
      return Promise.reject(new Error('no partition configured to derive a user code for DATA-REQ'));
    }
    const run = (): Promise<DataResponse> => this.sendAndAwaitData(params);
    // Chain regardless of how the previous request settled. We use `.then`
    // with both arms so a prior rejection does NOT propagate down the chain.
    const next: Promise<DataResponse> = this.requestQueueTail.then(run, run);
    // Keep the chain alive across rejections by swallowing them on the tail
    // (callers still see their own rejections via `next`).
    this.requestQueueTail = next.catch(() => undefined);
    return next;
  }

  private sendAndAwaitData(
    params: { id: number; startOrder: number; stopOrder?: number; password?: string },
  ): Promise<DataResponse> {
    const part = this.config.partitions[0];
    return new Promise<DataResponse>((resolve, reject) => {
      const sock = this.activeSocket;
      if (!sock || sock.destroyed) {
        return reject(new Error('no active panel connection'));
      }
      if (!this.panelVerified) {
        return reject(new Error('panel identity not yet verified; retry after verified event'));
      }
      const counter = this.opCounter++;
      const reqParams = {
        account: this.config.account,
        counter,
        password: params.password ?? part!.userCode,
        id: params.id,
        startOrder: params.startOrder,
        stopOrder: params.stopOrder,
      };

      const cleanup = (): void => {
        clearTimeout(timer);
        this.off('data', onData);
        this.off('nak', onNak);
        this.off('disconnected', onDisconnected);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`timeout waiting for DATA id=${params.id} startOrder=${params.startOrder}`));
      }, REQUEST_DATA_TIMEOUT_MS);
      const onData = (msg: { id: number; startOrder: number; parameters: string[]; more: boolean }): void => {
        if (msg.id !== params.id || msg.startOrder !== params.startOrder) return;
        cleanup();
        resolve({ parameters: msg.parameters, more: msg.more });
      };
      const onNak = ({ counter: nakCounter, reason }: { counter?: number; reason: string }): void => {
        // Match by counter when present. The panel uses counter=0 for parse-
        // level rejections ("JSON frame"); since we serialize, an in-flight
        // counter=0 NAK is for our request. Other non-zero counters that
        // don't match ours belong to a concurrent OPERATION (arm/disarm/
        // siren) and must be ignored here.
        if (nakCounter !== undefined && nakCounter !== 0 && nakCounter !== counter) return;
        cleanup();
        reject(new Error(`panel NAK: ${reason} (counter=${nakCounter ?? '?'})`));
      };
      const onDisconnected = (): void => {
        cleanup();
        reject(new Error('panel disconnected before DATA response'));
      };
      this.on('data', onData);
      this.on('nak', onNak);
      this.on('disconnected', onDisconnected);

      this.emit('frameOut', dataReqFrame(reqParams));
      sock.write(buildDataReq(reqParams), (err) => {
        if (err) {
          cleanup();
          reject(err);
        }
      });
    });
  }

  /** Convenience: request the panel's zone names (parameter id 260). */
  getZoneNames(startOrder = 1, stopOrder?: number): Promise<DataResponse> {
    return this.requestData({ id: PARAM_ID_ZONE_NAMES, startOrder, stopOrder });
  }

  /** Convenience: request the count of installed zones (parameter id 2148). */
  getZoneCount(): Promise<DataResponse> {
    return this.requestData({ id: PARAM_ID_NUMBER_OF_INSTALLED_ZONES, startOrder: 1, stopOrder: 1 });
  }

  /**
   * Query the System Key Status (parameter id 2310) for a single partition,
   * authenticating with that partition's own user code. Resolves with the
   * raw DATA response — the `data` event also fires, so platform-level
   * HomeKit state updates continue to flow through their existing handler.
   */
  getSystemKeyStatus(partitionId: number): Promise<DataResponse> {
    const part = this.partitionByCode.get(partitionId);
    if (!part) {
      return Promise.reject(new Error(`partition ${partitionId} not configured`));
    }
    return this.requestData({
      id: PARAM_ID_SYSTEM_KEY_STATUS,
      startOrder: partitionId,
      stopOrder: partitionId,
      password: part.userCode,
    });
  }

  setOutput(output: number, active: boolean): Promise<void> {
    const part = this.config.partitions[0];
    if (!part) {
      return Promise.reject(new Error('no partition configured to derive a user code for output operation'));
    }
    return new Promise((resolve, reject) => {
      const sock = this.activeSocket;
      if (!sock || sock.destroyed) {
        return reject(new Error('no active panel connection'));
      }
      if (!this.panelVerified) {
        return reject(new Error('panel identity not yet verified; retry after verified event'));
      }
      const params = {
        account: this.config.account,
        counter: this.opCounter++,
        optype: active ? OPTYPE_ACTIVATE_OUTPUT : OPTYPE_DEACTIVATE_OUTPUT,
        partition: 0,
        order: output,
        password: part.userCode,
      };
      this.emit('frameOut', operationFrame(params));
      sock.write(buildOperation(params), (err) => (err ? reject(err) : resolve()));
    });
  }

  private sendOperation(optype: number, partition: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = this.activeSocket;
      if (!sock || sock.destroyed) {
        return reject(new Error('no active panel connection'));
      }
      if (!this.panelVerified) {
        return reject(new Error('panel identity not yet verified; retry after verified event'));
      }
      const part = this.partitionByCode.get(partition);
      if (!part) {
        return reject(new Error(`partition ${partition} not configured`));
      }
      const params = {
        account: this.config.account,
        counter: this.opCounter++,
        optype,
        partition,
        password: part.userCode,
      };
      this.emit('frameOut', operationFrame(params));
      sock.write(buildOperation(params), (err) => (err ? reject(err) : resolve()));
    });
  }

  private handleConnection(sock: net.Socket): void {
    // The panel only opens one connection at a time per CMS path. If a new
    // one arrives while we still have an old socket reference, drop the old.
    if (this.activeSocket && !this.activeSocket.destroyed) {
      this.activeSocket.destroy();
    }
    this.activeSocket = sock;
    this.panelVerified = false;
    this.emit('connected');

    sock.on('data', (buf) => this.handleData(sock, buf));
    sock.on('error', (err) => this.emit('error', err));
    sock.on('close', () => {
      if (this.activeSocket === sock) {
        this.activeSocket = null;
        this.emit('disconnected');
      }
    });
  }

  private handleData(sock: net.Socket, buf: Buffer): void {
    // TCP can coalesce back-to-back writes into one data event, so handle
    // multiple frames per chunk. We don't currently buffer across chunks
    // (a frame split across two TCP segments would be lost) — this hasn't
    // been observed in practice on a LAN with the panel.
    for (const frame of parseFrames(buf, this.config.encoding)) {
      this.emit('frameIn', frame as unknown as Record<string, unknown>);

      // Verify the connecting client is our panel by checking its account number
      // on the first frame. Reject and close if it doesn't match — prevents a
      // rogue TCP client from triggering DATA-REQ frames that carry user codes.
      if (!this.panelVerified) {
        const rawAccount = frame.account;
        const accountOk =
          typeof rawAccount === 'string' &&
          /^\d+$/.test(rawAccount) &&
          Number(rawAccount) === this.config.account;
        if (!accountOk) {
          this.emit('error', new Error(
            `rejected connection: account=${frame.account} does not match expected ${this.config.account}`,
          ));
          sock.destroy();
          return;
        }
        this.panelVerified = true;
        this.emit('verified');
      }

      if (shouldAck(frame)) {
        const ack = ackFrame(frame);
        this.emit('frameOut', ack);
        sock.write(buildAck(frame));
      }
      this.dispatch(frame);
    }
  }

  private dispatch(frame: PanelFrame): void {
    const t = frame.frame_type;
    if (t === 'null' || t === 'ACK') return; // bookkeeping; nothing to surface

    if (t === 'NAK') {
      // Panel rejected something we sent. Surface it so callers can log the
      // reason. We still don't ACK NAKs (would create a feedback storm).
      this.emit('nak', {
        counter: typeof frame.counter === 'number' ? frame.counter : undefined,
        account: frame.account,
        reason: typeof frame.data === 'string' ? frame.data : 'unknown',
      });
      return;
    }

    if (t === 'event') {
      this.dispatchEvent(frame);
      return;
    }

    if (t === 'DATA') {
      // Response to a DATA-REQ we sent. Parameters are always strings per
      // spec section 4.6.5; the consumer interprets them.
      const id = Number(frame.id ?? 0);
      const startOrder = Number(frame.start_order ?? 0);
      let params = Array.isArray(frame.parameters)
        ? frame.parameters.map(String)
        : [];
      if (this.config.reverseStrings) {
        // Spread iterates by code point so non-BMP characters (e.g. emoji)
        // wouldn't get split mid-surrogate; for Hebrew this is just code
        // unit reversal anyway since it's BMP.
        params = params.map((s) => [...s].reverse().join(''));
      }
      const more = frame.more === 'yes';
      this.emit('data', { id, startOrder, parameters: params, more });
      return;
    }

    this.emit('unknown', frame);
  }

  private dispatchEvent(frame: PanelFrame): void {
    const partition = Number(frame.partition ?? 0);
    if (!partition) {
      this.emit('unknown', frame);
      return;
    }

    const type = Number(frame.type ?? 0);
    const qualifier = Number(frame.qualifier ?? 0);

    if (type === EVENT_TYPE_ZONE) {
      const zone = Number(frame.zone ?? 0);
      if (!zone) {
        this.emit('unknown', frame);
        return;
      }
      this.emit('zone', {
        zone,
        partition,
        active: qualifier === QUALIFIER_NEW,
      });
      return;
    }

    if (type === EVENT_TYPE_REMOTE_ARM || type === EVENT_TYPE_LOCAL_ARM) {
      const source: ArmEventSource =
        type === EVENT_TYPE_REMOTE_ARM ? 'remote' : 'local';
      // qualifier 3 = restore = ARMED (closed); qualifier 1 = new event = DISARMED (opened)
      if (qualifier === QUALIFIER_RESTORE) {
        this.emit('arm', { partition, source });
      } else if (qualifier === QUALIFIER_NEW) {
        this.emit('disarm', { partition, source });
      } else {
        this.emit('unknown', frame);
      }
      return;
    }

    if (type === EVENT_TYPE_COMM) {
      this.emit('system', {
        kind: 'commPath',
        ok: qualifier === QUALIFIER_RESTORE,
        channel: Number(frame.zone ?? 0),
        partition,
      });
      return;
    }

    if (type === EVENT_TYPE_OUTPUT) {
      // For type 770 the `zone` field carries the output number (Appendix A).
      const output = Number(frame.zone ?? 0);
      if (!output) {
        this.emit('unknown', frame);
        return;
      }
      this.emit('output', { output, partition, active: qualifier === QUALIFIER_NEW });
      return;
    }

    if (type === EVENT_TYPE_BURGLARY) {
      const zone = Number(frame.zone ?? 0);
      this.emit('alarm', { zone, partition, active: qualifier === QUALIFIER_NEW });
      return;
    }

    this.emit('unknown', frame);
  }
}
