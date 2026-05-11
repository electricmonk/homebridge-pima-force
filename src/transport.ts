import { EventEmitter } from 'node:events';
import net from 'node:net';
import {
  ackFrame,
  buildAck,
  buildDataReq,
  buildOperation,
  dataReqFrame,
  type DataReqParams,
  operationFrame,
  type OperationParams,
  parseFrames,
  shouldAck,
} from './protocol.js';
import type { PanelFrame } from './types.js';

/**
 * Default per-request timeout. The panel typically responds within tens of
 * milliseconds on a LAN; 5 s leaves headroom for slow / loaded panels while
 * still failing fast enough that a wedged request doesn't stall the queue.
 */
const DEFAULT_REQUEST_TIMEOUT_MS = 5000;

export interface PimaTransportConfig {
  port: number;
  account: number;
  /** Text encoding for inbound string fields. Defaults to `utf-8`. */
  encoding?: string;
  /** Starting value for our outgoing counter (HA→AS). Defaults to 5000. */
  opCounterStart?: number;
  /** Default per-request timeout in ms. Defaults to 5000. */
  requestTimeoutMs?: number;
}

/**
 * A request the driver wants to send. The transport allocates the counter,
 * serialises the frame, writes it, and waits for the matching response.
 * Callers never see the counter — it's allocated inside the wire queue.
 */
export type OutboundRequest =
  | ({ kind: 'operation' } & Omit<OperationParams, 'counter'>)
  | ({ kind: 'data-req'  } & Omit<DataReqParams,  'counter'>);

export interface PimaTransportEvents {
  connected: [];
  /** Emitted after the first frame from the panel passes account verification. */
  verified: [];
  disconnected: [];
  error: [Error];
  /**
   * Inbound frame that wasn't claimed by an in-flight `send`. The transport
   * has already handled framing-level concerns (verification + auto-ACKing
   * reports/heartbeats). Includes panel events, unmatched NAKs, and
   * (anomalously) stray DATA frames.
   */
  panelFrame: [PanelFrame];
  /** Raw wire-level diagnostics: every parsed frame received from the panel. */
  frameIn: [Record<string, unknown>];
  /** Raw wire-level diagnostics: every frame written to the panel. May contain a `password` field. */
  frameOut: [Record<string, unknown>];
}

interface Inflight {
  counter: number;
  /** Returns true if this inbound frame is the matching response. */
  match: (frame: PanelFrame) => boolean;
  resolve: (frame: PanelFrame) => void;
  reject: (err: Error) => void;
}

/**
 * Wire-layer for the Pima FORCE local CMS protocol. Owns the TCP socket,
 * the outbound counter, and the strict one-request-at-a-time send queue.
 *
 * The driver above this layer handles domain semantics (arm modes, partition
 * codes, event decoding); the transport handles framing, ACKing, panel
 * identity verification, and request/response correlation.
 *
 * Request/response model:
 *   OPERATION → ACK with our counter echoed.
 *   DATA-REQ  → DATA with id + start_order echoed.
 *   Either may be NAKed by counter (rejection).
 *
 * Calls are serialised: a second `send()` will not write to the socket
 * until the first has settled (resolved, rejected on NAK, timed out, or
 * been failed by a disconnect). Mirrors the panel's own one-in-flight
 * constraint — the panel NAKs (counter=0 "Invalid JSON frame") and/or
 * silently drops racing commands.
 *
 * Outbound ACKs we send back for inbound reports are NOT queued — ACKing
 * is a TCP-level acknowledgement and must be fast (the panel retries on
 * un-ACKed reports). The AS and HA counter namespaces are independent
 * (spec §4.4) so an interleaved ACK does not interfere with our in-flight
 * counter correlation.
 */
export class PimaTransport extends EventEmitter<PimaTransportEvents> {
  private server: net.Server | null = null;
  private activeSocket: net.Socket | null = null;
  private readonly opCounterStart: number;
  private opCounter: number;
  private panelVerified = false;
  /**
   * Tail of the serialised wire chain. Every `send()` chains its actual
   * send-and-await on top, so only one outbound command is in flight at a
   * time. The promise here is always "settled" (resolved or rejected); we
   * `.catch(() => undefined)` on the tail to keep the chain alive across
   * individual failures.
   */
  private wireQueueTail: Promise<unknown> = Promise.resolve();
  private inflight: Inflight | null = null;

  constructor(private readonly config: PimaTransportConfig) {
    super();
    this.opCounterStart = config.opCounterStart ?? 5000;
    this.opCounter = this.opCounterStart;
  }

  start(): Promise<void> {
    if (this.server) throw new Error('transport already started');
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

  /** Address the TCP server is bound to. Null when not started. Mainly for tests. */
  address(): net.AddressInfo | null {
    return this.server ? (this.server.address() as net.AddressInfo | null) : null;
  }

  /**
   * Send a request and resolve with the matching inbound response frame.
   * See class docstring for queueing + correlation semantics.
   */
  send(request: OutboundRequest, options?: { timeoutMs?: number }): Promise<PanelFrame> {
    const run = (): Promise<PanelFrame> => this.sendAndAwait(request, options);
    // Chain regardless of prior settlement. Both .then arms call `run` so a
    // prior rejection does not propagate down the chain.
    const next: Promise<PanelFrame> = this.wireQueueTail.then(run, run);
    this.wireQueueTail = next.catch(() => undefined);
    return next;
  }

  private sendAndAwait(
    request: OutboundRequest,
    options: { timeoutMs?: number } = {},
  ): Promise<PanelFrame> {
    return new Promise<PanelFrame>((resolve, reject) => {
      const sock = this.activeSocket;
      if (!sock || sock.destroyed) {
        return reject(new Error('no active panel connection'));
      }
      if (!this.panelVerified) {
        return reject(new Error('panel identity not yet verified; retry after verified event'));
      }

      // Allocate the counter INSIDE the queued task — never before. This is
      // the structural guarantee that counters and wire writes stay in lock
      // step: only one send-and-await runs at a time, and only this code
      // path assigns counters.
      const counter = this.opCounter++;
      const { frameObj, bytes, match } = this.buildRequest(request, counter);

      const timeoutMs = options.timeoutMs ?? this.config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
      const cleanup = (): void => {
        clearTimeout(timer);
        this.off('disconnected', onDisconnected);
      };
      const timer = setTimeout(() => {
        this.clearInflightIfMine(counter);
        cleanup();
        reject(new Error(`timeout waiting for response to ${request.kind} (counter=${counter})`));
      }, timeoutMs);
      const onDisconnected = (): void => {
        this.clearInflightIfMine(counter);
        cleanup();
        reject(new Error('panel disconnected before response'));
      };
      this.on('disconnected', onDisconnected);

      this.inflight = {
        counter,
        match,
        resolve: (frame) => {
          cleanup();
          resolve(frame);
        },
        reject: (err) => {
          cleanup();
          reject(err);
        },
      };

      this.emit('frameOut', frameObj);
      sock.write(bytes, (err) => {
        if (err) {
          const mine = this.clearInflightIfMine(counter);
          if (mine) {
            cleanup();
            reject(err);
          }
        }
      });
    });
  }

  private buildRequest(
    request: OutboundRequest,
    counter: number,
  ): {
    frameObj: Record<string, unknown>;
    bytes: Buffer;
    match: (frame: PanelFrame) => boolean;
  } {
    if (request.kind === 'operation') {
      const params: OperationParams = {
        account: request.account,
        counter,
        optype: request.optype,
        partition: request.partition,
        password: request.password,
        opclass: request.opclass,
        order: request.order,
      };
      return {
        frameObj: operationFrame(params),
        bytes: buildOperation(params),
        match: (f) => f.frame_type === 'ACK' && Number(f.counter) === counter,
      };
    }
    const params: DataReqParams = {
      account: request.account,
      counter,
      password: request.password,
      id: request.id,
      startOrder: request.startOrder,
      stopOrder: request.stopOrder,
    };
    const expectedId = request.id;
    const expectedStart = request.startOrder;
    return {
      frameObj: dataReqFrame(params),
      bytes: buildDataReq(params),
      // DATA-REQ is correlated by (id, start_order) rather than counter:
      // the panel echoes those fields and may split the response across
      // frames (more:"yes"), each carrying the same id+start_order of the
      // page we asked for. Single-frame responses match exactly.
      match: (f) =>
        f.frame_type === 'DATA' &&
        Number(f.id) === expectedId &&
        Number(f.start_order) === expectedStart,
    };
  }

  private clearInflightIfMine(counter: number): boolean {
    if (this.inflight && this.inflight.counter === counter) {
      this.inflight = null;
      return true;
    }
    return false;
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
        // Reset wire state so the next connection starts from a clean slate.
        // Pending in-flight `send`s reject via the 'disconnected' listener
        // they installed on themselves; new sends queued during the gap
        // will fail at the socket check inside sendAndAwait.
        this.opCounter = this.opCounterStart;
        this.wireQueueTail = Promise.resolve();
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

      // ACK FIRST — the panel retries un-ACKed reports, and we don't want our
      // listeners (downstream of `panelFrame`) gating wire-level acknowledgement.
      // ACK uses the panel's counter namespace (AS→HA), which is independent of
      // ours (HA→AS), so this never collides with an in-flight `send` counter.
      if (shouldAck(frame)) {
        const ack = ackFrame(frame);
        this.emit('frameOut', ack);
        sock.write(buildAck(frame));
      }

      this.routeInbound(frame);
    }
  }

  private routeInbound(frame: PanelFrame): void {
    const t = frame.frame_type;
    if (t === 'null') return; // heartbeat — already ACKed; nothing else to do.

    if (this.inflight) {
      const counter = typeof frame.counter === 'number' ? frame.counter : undefined;
      // A NAK whose counter matches our in-flight rejects it. We deliberately
      // don't match counter=0 NAKs to in-flight: with strict serialization,
      // a counter=0 NAK indicates the panel couldn't parse our JSON, which is
      // a programmer error worth surfacing distinctly (it'll arrive as a
      // panelFrame; the in-flight will time out).
      if (t === 'NAK' && counter !== undefined && counter !== 0 && counter === this.inflight.counter) {
        const reason = typeof frame.data === 'string' ? frame.data : 'unknown';
        const inflight = this.inflight;
        this.inflight = null;
        inflight.reject(new Error(`panel NAK: ${reason} (counter=${counter})`));
        return;
      }
      if (this.inflight.match(frame)) {
        const inflight = this.inflight;
        this.inflight = null;
        inflight.resolve(frame);
        return;
      }
    }

    // Not for the in-flight — forward upstream for the driver to interpret.
    this.emit('panelFrame', frame);
  }
}
