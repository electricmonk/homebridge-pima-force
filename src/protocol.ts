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
 * Decode a TCP buffer as text in the given encoding. Default `utf-8`.
 * Use `windows-1255` for Israeli FORCE panels with Hebrew zone/user names —
 * Hebrew bytes (0xE0–0xFA) aren't valid UTF-8 continuations and would
 * otherwise become U+FFFD replacement characters ('?'). JSON syntax chars
 * are ASCII either way, so the frame parses fine in either encoding.
 */
function decodeBuffer(buf: Buffer, encoding = 'utf-8'): string {
  return new TextDecoder(encoding).decode(buf);
}

/**
 * Parse a buffer that may contain one frame (and trailing 0x00 padding,
 * for `null` heartbeats). Returns null if the buffer doesn't contain
 * valid JSON. For chunks that may contain multiple frames (TCP can
 * coalesce back-to-back writes into one segment), use parseFrames.
 */
export function parseFrame(buf: Buffer, encoding?: string): PanelFrame | null {
  const text = decodeBuffer(buf, encoding).replace(/\x00+/g, '').trim();
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
export function parseFrames(buf: Buffer, encoding?: string): PanelFrame[] {
  // Strip null padding so heartbeats and back-to-back frames both work.
  const text = decodeBuffer(buf, encoding).replace(/\x00+/g, '');
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
/** Object form of the ACK we'd build for `received`. Useful for logging. */
export function ackFrame(received: PanelFrame): Record<string, unknown> {
  return {
    account: Number(received.account ?? 0),
    counter: received.counter ?? 0,
    frame_type: 'ACK',
    kc: 1,
  };
}

export function buildAck(received: PanelFrame): Buffer {
  return Buffer.from(JSON.stringify(ackFrame(received)), 'utf8');
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
/** Object form of an OPERATION frame. Carries `password` — redact when logging. */
export function operationFrame(p: OperationParams): Record<string, unknown> {
  return {
    account: p.account,
    counter: p.counter,
    frame_type: 'OPERATION',
    opclass: p.opclass ?? 1,
    optype: p.optype,
    order: p.order ?? 0,
    partition: p.partition,
    password: p.password,
  };
}

export function buildOperation(p: OperationParams): Buffer {
  return Buffer.from(JSON.stringify(operationFrame(p)), 'utf8');
}

/**
 * Operation types per Appendix B of the Force JSON spec.
 */
export const OPTYPE_ARM_AWAY = 12;     // Full Arm
export const OPTYPE_ARM_HOME1 = 13;
export const OPTYPE_ARM_HOME2 = 14;
export const OPTYPE_ARM_HOME3 = 15;
export const OPTYPE_ARM_HOME4 = 16;
export const OPTYPE_DISARM = 17;
export const OPTYPE_ARM_SHABBAT = 43;
export const OPTYPE_ACTIVATE_OUTPUT = 35;
export const OPTYPE_DEACTIVATE_OUTPUT = 36;

/** Backward-compatible alias — kept for existing callers. */
export const OPTYPE_ARM = OPTYPE_ARM_AWAY;

/** Output orders (per Appendix B) used with OPTYPE_ACTIVATE_OUTPUT/DEACTIVATE_OUTPUT. */
export const OUTPUT_EXTERNAL_SIREN = 1;
export const OUTPUT_INTERNAL_SIREN = 2;

/**
 * Parameter IDs queried via DATA-REQ frames (Appendix C of the spec).
 * Used as the `id` field on outbound DATA-REQ; AS responds with a DATA frame
 * carrying `parameters` (and possibly `more:"yes"` if paginated).
 */
export const PARAM_ID_ZONE_NAMES = 260;
export const PARAM_ID_USER_NAMES = 411;
export const PARAM_ID_NUMBER_OF_INSTALLED_ZONES = 2148;
export const PARAM_ID_ZONE_STATUS = 2149;
export const PARAM_ID_BYPASSED_ZONES = 2150;
export const PARAM_ID_FAULTS = 2250;
export const PARAM_ID_OUTPUT_STATUS = 2301;
export const PARAM_ID_SYSTEM_KEY_STATUS = 2310;

export interface DataReqParams {
  account: number;
  counter: number;
  password: string;
  /** Parameter ID to query (PARAM_ID_*). */
  id: number;
  startOrder: number;
  /** When omitted, the panel returns from `startOrder` to the end of the parameter array. */
  stopOrder?: number;
}

/** Object form of a DATA-REQ frame. Carries `password` — redact when logging. */
export function dataReqFrame(p: DataReqParams): Record<string, unknown> {
  const obj: Record<string, unknown> = {
    frame_type: 'DATA-REQ',
    counter: p.counter,
    account: p.account,
    password: p.password,
    id: p.id,
    start_order: p.startOrder,
  };
  if (p.stopOrder !== undefined) obj.stop_order = p.stopOrder;
  return obj;
}

export function buildDataReq(p: DataReqParams): Buffer {
  return Buffer.from(JSON.stringify(dataReqFrame(p)), 'utf8');
}

/**
 * Contact ID-style event type codes per Appendix A of the spec.
 * - 760: zone open/closed (qualifier 1 = open, 3 = closed)
 * - 770: output activated/de-activated (zone field carries the output #)
 * - 407: remote arm/disarm via CMS (qualifier 3 = arm, 1 = disarm)
 * - 401: local user arm/disarm (qualifier 3 = arm, 1 = disarm)
 * - 350: CMS communication path status (qualifier 3 = restore, 1 = trouble)
 *   — the `zone` field carries the channel/path index (Pima-specific).
 * - 130: burglary alarm (qualifier 1 = alarm, 3 = restore)
 */
export const EVENT_TYPE_ZONE = 760;
export const EVENT_TYPE_OUTPUT = 770;
export const EVENT_TYPE_REMOTE_ARM = 407;
export const EVENT_TYPE_LOCAL_ARM = 401;
export const EVENT_TYPE_COMM = 350;
export const EVENT_TYPE_BURGLARY = 130;

/** Qualifier 1 = new event (zone open / disarm). Qualifier 3 = restore (zone close / arm). */
export const QUALIFIER_NEW = 1;
export const QUALIFIER_RESTORE = 3;
