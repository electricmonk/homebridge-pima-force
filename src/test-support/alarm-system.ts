/**
 * `alarmSystem` driver — what a Pima FORCE panel looks like to a test.
 *
 * The driver wraps a TCP client socket pointed at a `PimaTransport` (in
 * driver-level tests) or at the homebridge subprocess's listener (in e2e
 * tests). It speaks the wire protocol in both directions, exposes domain
 * verbs to the test (report a zone open, respond to a partition-state
 * query, etc.), and mirrors enough real-panel behaviour to catch the
 * back-pressure bugs we've hit in production.
 *
 * Mirrored real-panel behaviour (toggleable per test):
 *   - **autoAck.operations** — ACK every OPERATION we receive with the
 *     matching counter (spec §4.6.2). Tests that need to model NAKs or
 *     timeouts flip this off.
 *   - **autoReject.racingDataReqs** — when a DATA-REQ arrives while the
 *     previous one hasn't been responded to yet, NAK it with counter=0
 *     "JSON frame" (the production-observed back-pressure response).
 *
 * Counter management: tests never pick counters. Outbound reports get an
 * auto-incrementing counter starting at 1; DATA / NAK responses echo the
 * triggering query's counter automatically.
 */
import net from 'node:net';
import { eventually } from './eventually.js';
import type { DataPayload, EventBlueprint, NakPayload } from './frames.js';

/** A DATA-REQ frame as observed by the test. */
export interface AlarmQuery extends Record<string, unknown> {
  frame_type: 'DATA-REQ';
  counter: number;
  account: string | number;
  id: number;
  start_order: number;
  stop_order?: number;
  password?: string;
}

/** An OPERATION frame as observed by the test. */
export interface AlarmOperation extends Record<string, unknown> {
  frame_type: 'OPERATION';
  counter: number;
  account: string | number;
  optype: number;
  partition: number;
  order?: number;
  password?: string;
}

export interface AlarmSystemOptions {
  host?: string;
  port: number;
  account: number;
  /** Initial value for outbound report counters (AS→HA). Default 1. */
  reportCounterStart?: number;
}

export interface AlarmSystem {
  connect(): Promise<void>;
  close(): void;
  /** Send a `null` heartbeat with the matching account, flipping the driver's `panelVerified` flag. */
  verify(): Promise<void>;
  /** Send a report (`frame_type:'event'`). The counter is allocated automatically. */
  report(blueprint: EventBlueprint): Promise<void>;
  /** Resolve with the next DATA-REQ matching `match`, after this call. */
  nextQuery(match?: { id?: number; startOrder?: number }, opts?: { timeoutMs?: number }): Promise<AlarmQuery>;
  /** Resolve with the next OPERATION matching `match`, after this call. */
  nextOperation(match?: { optype?: number; partition?: number; order?: number }, opts?: { timeoutMs?: number }): Promise<AlarmOperation>;
  /** Reply to a query with a DATA payload (counter/id/start_order echoed from `query`). */
  respond(query: AlarmQuery, payload: DataPayload): void;
  /** Reply to a query with a NAK (counter echoed from `query` unless overridden by payload.counter). */
  reject(query: AlarmQuery, payload: NakPayload): void;
  /** All frames from the driver in order (DATA-REQ and OPERATION included). */
  readonly received: ReadonlyArray<Record<string, unknown>>;
  /** Subset of `received`: just DATA-REQ frames. */
  readonly dataReqs: ReadonlyArray<AlarmQuery>;
  /** Subset of `received`: just OPERATION frames. */
  readonly operations: ReadonlyArray<AlarmOperation>;
  /** Toggle auto-ACK of OPERATIONs (default true — mirrors the real panel). */
  readonly autoAck: { operations: boolean };
  /** Toggle auto-NAK of racing DATA-REQs (default true — mirrors the real panel). */
  readonly autoReject: { racingDataReqs: boolean };
  /** Send a raw frame — escape hatch for tests that need to bypass the builders. */
  sendRaw(frame: Record<string, unknown>): void;
}

export function anAlarmSystem(opts: AlarmSystemOptions): AlarmSystem {
  const host = opts.host ?? '127.0.0.1';
  const accountString = String(opts.account);

  const sock = new net.Socket();
  const received: Array<Record<string, unknown>> = [];
  const dataReqs: AlarmQuery[] = [];
  const operations: AlarmOperation[] = [];
  /** Counter of the DATA-REQ whose response we haven't sent yet (null = no in-flight). */
  let inflightQueryCounter: number | null = null;
  let reportCounter = opts.reportCounterStart ?? 1;
  let connected = false;

  const autoAck = { operations: true };
  const autoReject = { racingDataReqs: true };

  const write = (frame: Record<string, unknown>): void => {
    sock.write(JSON.stringify(frame));
  };

  const onSocketData = (buf: Buffer): void => {
    for (const part of buf.toString('utf8').split(/(?<=\})(?=\{)/)) {
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(part);
      } catch {
        continue;
      }
      received.push(frame);

      if (frame.frame_type === 'DATA-REQ') {
        if (inflightQueryCounter !== null && autoReject.racingDataReqs) {
          // Mirror real-panel back-pressure: NAK counter=0 "JSON frame".
          write({
            frame_type: 'NAK',
            counter: 0,
            account: accountString,
            data: 'Invalid JSON frame',
          });
          continue;
        }
        inflightQueryCounter = Number(frame.counter);
        dataReqs.push(frame as AlarmQuery);
        continue;
      }
      if (frame.frame_type === 'OPERATION') {
        operations.push(frame as AlarmOperation);
        if (autoAck.operations) {
          write({
            frame_type: 'ACK',
            counter: frame.counter,
            account: accountString,
          });
        }
        continue;
      }
      // ACK from the driver for one of our reports — nothing to do.
    }
  };

  const connect = (): Promise<void> =>
    new Promise((resolve, reject) => {
      const onConnect = (): void => {
        connected = true;
        sock.off('error', onError);
        resolve();
      };
      const onError = (err: Error): void => {
        sock.off('connect', onConnect);
        reject(err);
      };
      sock.once('connect', onConnect);
      sock.once('error', onError);
      sock.on('data', onSocketData);
      sock.connect({ host, port: opts.port });
    });

  const close = (): void => {
    connected = false;
    sock.destroy();
  };

  const verify = async (): Promise<void> => {
    if (!connected) throw new Error('anAlarmSystem.verify: connect() first');
    const before = received.length;
    write({
      frame_type: 'null',
      counter: reportCounter++,
      account: accountString,
    });
    // The driver responds with an ACK of our heartbeat. Wait for it so the
    // caller knows verification has completed.
    await eventually(() => {
      const ack = received.slice(before).find((f) => f.frame_type === 'ACK');
      if (!ack) throw new Error('alarm system: heartbeat not acknowledged yet');
      return ack;
    }, { timeoutMs: 2000, message: 'awaiting driver ACK to heartbeat' });
  };

  const report = (blueprint: EventBlueprint): Promise<void> =>
    new Promise((resolve, reject) => {
      const counter = reportCounter++;
      const frame = {
        frame_type: 'event',
        counter,
        account: accountString,
        ...blueprint,
      };
      sock.write(JSON.stringify(frame), (err) => (err ? reject(err) : resolve()));
    });

  const matchQuery = (q: AlarmQuery, match: { id?: number; startOrder?: number }): boolean => {
    if (match.id !== undefined && Number(q.id) !== match.id) return false;
    if (match.startOrder !== undefined && Number(q.start_order) !== match.startOrder) return false;
    return true;
  };

  const matchOperation = (op: AlarmOperation, match: { optype?: number; partition?: number; order?: number }): boolean => {
    if (match.optype !== undefined && Number(op.optype) !== match.optype) return false;
    if (match.partition !== undefined && Number(op.partition) !== match.partition) return false;
    if (match.order !== undefined && Number(op.order) !== match.order) return false;
    return true;
  };

  /**
   * Return the first DATA-REQ matching `match`, polling until one arrives.
   * Doesn't track consumption — calling twice with the same filter returns
   * the same query. Use a more specific filter (id+startOrder) when you
   * need to distinguish multiple queries.
   */
  const nextQuery = (
    match: { id?: number; startOrder?: number } = {},
    pollOpts: { timeoutMs?: number } = {},
  ): Promise<AlarmQuery> =>
    eventually(() => {
      const found = dataReqs.find((q) => matchQuery(q, match));
      if (found) return found;
      throw new Error(`no DATA-REQ matching ${JSON.stringify(match)}; seen ${dataReqs.length}: ${JSON.stringify(dataReqs)}`);
    }, { timeoutMs: pollOpts.timeoutMs ?? 2000, message: `awaiting DATA-REQ ${JSON.stringify(match)}` });

  /**
   * Return the first OPERATION matching `match`, polling until one arrives.
   * Same don't-track-consumption semantics as `nextQuery`.
   */
  const nextOperation = (
    match: { optype?: number; partition?: number; order?: number } = {},
    pollOpts: { timeoutMs?: number } = {},
  ): Promise<AlarmOperation> =>
    eventually(() => {
      const found = operations.find((op) => matchOperation(op, match));
      if (found) return found;
      throw new Error(`no OPERATION matching ${JSON.stringify(match)}; seen ${operations.length}: ${JSON.stringify(operations)}`);
    }, { timeoutMs: pollOpts.timeoutMs ?? 2000, message: `awaiting OPERATION ${JSON.stringify(match)}` });

  const respond = (query: AlarmQuery, payload: DataPayload): void => {
    if (inflightQueryCounter === Number(query.counter)) {
      inflightQueryCounter = null;
    }
    write({
      frame_type: 'DATA',
      counter: query.counter,
      account: accountString,
      id: query.id,
      start_order: query.start_order,
      parameters: payload.parameters,
      more: payload.more ? 'yes' : 'no',
    });
  };

  const reject_ = (query: AlarmQuery, payload: NakPayload): void => {
    const counter = payload.counter ?? Number(query.counter);
    if (inflightQueryCounter === Number(query.counter)) {
      inflightQueryCounter = null;
    }
    write({
      frame_type: 'NAK',
      counter,
      account: accountString,
      data: payload.data,
    });
  };

  const sendRaw = (frame: Record<string, unknown>): void => {
    write(frame);
  };

  return {
    connect,
    close,
    verify,
    report,
    nextQuery,
    nextOperation,
    respond,
    reject: reject_,
    received,
    dataReqs,
    operations,
    autoAck,
    autoReject,
    sendRaw,
  };
}
