import type { PanelFrame } from './types.js';

/**
 * Pima FORCE local CMS protocol primitives. Pure functions, no I/O.
 *
 * Frames on the wire are ASCII JSON over TCP. The panel pads `null`
 * heartbeats to 250 bytes with 0x00; everything else is natural length.
 * Outbound frames (ACK, OPERATION) we send are always natural length.
 */

const HEARTBEAT_FRAME_SIZE = 250;

/**
 * Parse a buffer that may contain one frame (and trailing 0x00 padding,
 * for `null` heartbeats). Returns null if the buffer doesn't contain
 * valid JSON. For chunks that may contain multiple frames (TCP can
 * coalesce back-to-back writes into one segment), use parseFrames.
 */
export function parseFrame(buf: Buffer): PanelFrame | null {
  const text = buf.toString('utf8').replace(/\x00+/g, '').trim();
  if (!text) return null;
  try {
    const obj = JSON.parse(text);
    if (typeof obj !== 'object' || obj === null) return null;
    return obj as PanelFrame;
  } catch {
    return null;
  }
}

/**
 * Parse a buffer that may contain zero, one, or many JSON frames glued
 * together (TCP segment coalescing) plus 0x00 padding from heartbeats.
 * Returns the frames in order; ignores anything that doesn't parse.
 */
export function parseFrames(buf: Buffer): PanelFrame[] {
  // Strip null padding so heartbeats and back-to-back frames both work.
  const text = buf.toString('utf8').replace(/\x00+/g, '');
  if (!text.trim()) return [];
  // Split where '}' is immediately followed by '{' — the only place this
  // sequence appears in our protocol is between two adjacent JSON objects.
  const parts = text.split(/(?<=\})(?=\{)/);
  const frames: PanelFrame[] = [];
  for (const p of parts) {
    const trimmed = p.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (typeof obj === 'object' && obj !== null) frames.push(obj as PanelFrame);
    } catch {
      // Skip unparseable fragment (could be a partial frame split across
      // TCP segments — we don't currently buffer across data events).
    }
  }
  return frames;
}

/**
 * Build the application-level ACK we must send back for every panel frame
 * (other than NAK and ACK themselves) to keep the connection healthy.
 *
 * Wire shape — exact field order matches the Chowmain C4 driver capture:
 *   {"account":<N>,"counter":<N>,"frame_type":"ACK","kc":1}
 *
 * `account` MUST be a number, even though the panel sends it as a string.
 * Panel will respond with NAK ("JSON frame") and then go silent for 60s
 * if any field is wrong.
 */
export function buildAck(received: PanelFrame): Buffer {
  const ack = {
    account: Number(received.account ?? 0),
    counter: received.counter ?? 0,
    frame_type: 'ACK',
    kc: 1,
  };
  return Buffer.from(JSON.stringify(ack), 'utf8');
}

/**
 * Whether a received frame should be ACKed by the receiver.
 * NAKs and ACKs are control frames and must NOT be ACKed (would loop).
 */
export function shouldAck(frame: PanelFrame): boolean {
  const t = frame.frame_type;
  return t !== 'NAK' && t !== 'ACK';
}

export interface OperationParams {
  account: number;
  counter: number;
  optype: number;
  partition: number;
  password: string;
  /** Operation class. Always 1 for arm/disarm. */
  opclass?: number;
  order?: number;
}

/**
 * Build an OPERATION frame to send to the panel (e.g. arm/disarm).
 *
 * Wire shape — exact field order matches the Chowmain C4 driver capture:
 *   {"account":<N>,"counter":<N>,"frame_type":"OPERATION","opclass":1,
 *    "optype":<N>,"order":0,"partition":<N>,"password":"<CODE>"}
 *
 * Known optypes (more may exist for arm modes Home 1-4, Shabbat):
 *   12 = ARM (full arm)
 *   17 = DISARM
 */
export function buildOperation(p: OperationParams): Buffer {
  const op = {
    account: p.account,
    counter: p.counter,
    frame_type: 'OPERATION',
    opclass: p.opclass ?? 1,
    optype: p.optype,
    order: p.order ?? 0,
    partition: p.partition,
    password: p.password,
  };
  return Buffer.from(JSON.stringify(op), 'utf8');
}

export const OPTYPE_ARM = 12;
export const OPTYPE_DISARM = 17;

/**
 * Contact ID-style event type codes seen on this panel.
 * type=760 with qualifier 1/3 is the common "zone open/restore" event.
 * type=407 fires when arming/disarming was triggered remotely (via CMS).
 * type=401 fires when arming/disarming was done locally at the keypad.
 * type=350 fires when the panel reports CMS comm path status — qualifier
 *   3 = restore (path healthy), qualifier 1 = trouble (path failing).
 *   The `zone` field carries the channel/path index (Pima-specific).
 */
export const EVENT_TYPE_ZONE = 760;
export const EVENT_TYPE_REMOTE_ARM = 407;
export const EVENT_TYPE_LOCAL_ARM = 401;
export const EVENT_TYPE_COMM = 350;

/** Qualifier 1 = new event (zone open / disarm). Qualifier 3 = restore (zone close / arm). */
export const QUALIFIER_NEW = 1;
export const QUALIFIER_RESTORE = 3;
