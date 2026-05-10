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
  PanelFrame,
  PartitionConfig,
  PimaDriverConfig,
  PimaDriverEvents,
} from './types.js';

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
   * Request a configuration/status parameter from the panel (DATA-REQ).
   * The response arrives asynchronously as a `data` event (or a `nak` if
   * the panel rejects). Authorization uses the first configured partition's
   * user code, same as output operations.
   */
  requestData(params: { id: number; startOrder: number; stopOrder?: number }): Promise<void> {
    const part = this.config.partitions[0];
    if (!part) {
      return Promise.reject(new Error('no partition configured to derive a user code for DATA-REQ'));
    }
    return new Promise((resolve, reject) => {
      const sock = this.activeSocket;
      if (!sock || sock.destroyed) {
        return reject(new Error('no active panel connection'));
      }
      const reqParams = {
        account: this.config.account,
        counter: this.opCounter++,
        password: part.userCode,
        id: params.id,
        startOrder: params.startOrder,
        stopOrder: params.stopOrder,
      };
      this.emit('frameOut', dataReqFrame(reqParams));
      sock.write(buildDataReq(reqParams), (err) => (err ? reject(err) : resolve()));
    });
  }

  /** Convenience: request the panel's zone names (parameter id 260). */
  getZoneNames(startOrder = 1, stopOrder?: number): Promise<void> {
    return this.requestData({ id: PARAM_ID_ZONE_NAMES, startOrder, stopOrder });
  }

  /** Convenience: request the count of installed zones (parameter id 2148). */
  getZoneCount(): Promise<void> {
    return this.requestData({ id: PARAM_ID_NUMBER_OF_INSTALLED_ZONES, startOrder: 1, stopOrder: 1 });
  }

  /**
   * Query the System Key Status (parameter id 2310) for a single partition,
   * authenticating with that partition's own user code.
   * The response arrives as a `data` event with id=2310 and startOrder=partitionId.
   */
  getSystemKeyStatus(partitionId: number): Promise<void> {
    const part = this.partitionByCode.get(partitionId);
    if (!part) {
      return Promise.reject(new Error(`partition ${partitionId} not configured`));
    }
    return new Promise((resolve, reject) => {
      const sock = this.activeSocket;
      if (!sock || sock.destroyed) {
        return reject(new Error('no active panel connection'));
      }
      const reqParams = {
        account: this.config.account,
        counter: this.opCounter++,
        password: part.userCode,
        id: PARAM_ID_SYSTEM_KEY_STATUS,
        startOrder: partitionId,
        stopOrder: partitionId,
      };
      this.emit('frameOut', dataReqFrame(reqParams));
      sock.write(buildDataReq(reqParams), (err) => (err ? reject(err) : resolve()));
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
      const params = Array.isArray(frame.parameters)
        ? frame.parameters.map(String)
        : [];
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
