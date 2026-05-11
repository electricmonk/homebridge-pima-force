export interface PartitionConfig {
  id: number;
  userCode: string;
}

/**
 * The HomeKit sensor type a zone should be exposed as. Maps to a specific
 * HAP service + characteristic in the plugin's accessory layer. All types
 * share the same active/inactive panel-side semantics (qualifier 1/3) — the
 * difference is only how HomeKit presents the sensor (icon, automation
 * primitives, voice queries).
 */
export type ZoneType = 'contact' | 'motion' | 'leak' | 'smoke';

export interface PimaDriverConfig {
  port: number;
  account: number;
  partitions: PartitionConfig[];
  /** Starting value for our outgoing OPERATION counter. Default 5000. */
  opCounterStart?: number;
  /**
   * Text encoding the panel uses for non-ASCII string values (zone names,
   * user names, etc.). JSON syntax characters are ASCII either way, so the
   * frame parses regardless; this only affects how we decode string
   * contents. Default `'windows-1255'` (for Israeli FORCE panels with
   * Hebrew names). Override to `'utf-8'` or another encoding if your panel
   * returns ASCII/Latin names.
   *
   * Anything supported by the global `TextDecoder` is accepted —
   * `'utf-8'`, `'windows-1255'`, `'iso-8859-8'`, `'iso-8859-1'`, etc.
   */
  encoding?: string;
  /**
   * When true, reverse the order of code points in every string value
   * returned in DATA responses. Pima FORCE panels often store text in
   * "visual order" (the order of pixels on the LCD, left-to-right) rather
   * than logical order. Modern Unicode systems expect logical order and
   * apply right-to-left rendering via bidi; without this flag, Hebrew zone
   * names appear letter-reversed.
   *
   * Reverses *all* string parameters when enabled — leave off if the panel
   * already returns logical-order strings.
   *
   * @deprecated Will be removed in a future release once we confirm no panels require it.
   */
  reverseStrings?: boolean;
}

/**
 * The set of frame_type values we know about. The wire protocol is
 * loose JSON so unknown values are possible — handled as 'unknown'.
 */
export type FrameType = 'null' | 'event' | 'ACK' | 'NAK' | 'OPERATION';

/** A frame received from the panel, after JSON parse. */
export interface PanelFrame {
  frame_type: string;
  counter?: number;
  account?: string | number;
  type?: number;
  qualifier?: 1 | 3 | number;
  zone?: number;
  partition?: number;
  data?: string;
  [k: string]: unknown;
}

export type ArmEventSource = 'remote' | 'local' | 'unknown';

export interface ArmEvent {
  partition: number;
  source: ArmEventSource;
}

export interface ZoneEvent {
  zone: number;
  partition: number;
  active: boolean;
}

/** Output state change (e.g., siren activated). Output 1 = external siren. */
export interface OutputEvent {
  output: number;
  partition: number;
  active: boolean;
}

/** Burglary alarm: a zone tripped while armed and is sounding the siren. */
export interface AlarmEvent {
  zone: number;
  partition: number;
  /** True = alarm in progress; false = alarm restored. */
  active: boolean;
}

/**
 * Panel rejected one of our requests. The `reason` field carries the panel's
 * free-text NAK data string (Appendix D of the spec), e.g. "invalid password",
 * "JSON frame", "Wrong Account ID".
 */
export interface NakEvent {
  counter?: number;
  account?: string | number;
  reason: string;
}

/**
 * Response to a DATA-REQ. The `parameters` array holds the requested
 * values starting at `startOrder`. `more` is true when the panel had to
 * split the response across multiple frames; the consumer should request
 * the remainder starting at `startOrder + parameters.length`.
 */
export interface DataEvent {
  /** Parameter ID echoed from the request (e.g. 260 = zone names). */
  id: number;
  startOrder: number;
  parameters: string[];
  more: boolean;
}

/**
 * Arm modes recognized by the panel (Appendix B).
 * - `away`    — Full Arm (optype 12)
 * - `home1`-`home4` — Home modes (optype 13-16)
 * - `shabbat` — Shabbat Arm (optype 43)
 */
export type ArmMode = 'away' | 'home1' | 'home2' | 'home3' | 'home4' | 'shabbat';

/**
 * Per-partition toggles for which HomeKit armed states to expose.
 * `away` ↔ Pima Full Arm; `stay` ↔ Pima Home1; `night` ↔ Pima Home2.
 * DISARM is always available (you can always disarm). When all three are
 * `false` the partition can't be armed from HomeKit.
 */
export interface ArmModeToggles {
  away?: boolean;
  stay?: boolean;
  night?: boolean;
}

/**
 * Reported when the panel sends a system/comm status event (e.g. it
 * considers the CMS link restored or troubled). Informational; not a
 * security event.
 */
export interface SystemEvent {
  /** What kind of system event — currently only 'commPath' is observed. */
  kind: 'commPath';
  /** True for restore/healthy, false for trouble. */
  ok: boolean;
  /** Channel/path index the panel is reporting on (Pima-specific). */
  channel: number;
  partition: number;
}

/**
 * Strongly-typed event map for PimaDriver. Allows TypeScript to infer
 * payload types when callers do `driver.on('zone', e => ...)`.
 */
export interface PimaDriverEvents {
  connected: [];
  /** Emitted after the first frame from the panel passes account verification. */
  verified: [];
  disconnected: [];
  arm: [ArmEvent];
  disarm: [ArmEvent];
  zone: [ZoneEvent];
  output: [OutputEvent];
  alarm: [AlarmEvent];
  system: [SystemEvent];
  nak: [NakEvent];
  data: [DataEvent];
  unknown: [PanelFrame];
  error: [Error];
  /** Raw wire-level diagnostics: every parsed frame received from the panel. */
  frameIn: [Record<string, unknown>];
  /** Raw wire-level diagnostics: every frame written to the panel. May contain a `password` field. */
  frameOut: [Record<string, unknown>];
}
