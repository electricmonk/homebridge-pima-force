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
 * Arm modes recognized by the panel (Appendix B).
 * - `away`    — Full Arm (optype 12)
 * - `home1`-`home4` — Home modes (optype 13-16)
 * - `shabbat` — Shabbat Arm (optype 43)
 */
export type ArmMode = 'away' | 'home1' | 'home2' | 'home3' | 'home4' | 'shabbat';

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
  disconnected: [];
  arm: [ArmEvent];
  disarm: [ArmEvent];
  zone: [ZoneEvent];
  output: [OutputEvent];
  alarm: [AlarmEvent];
  system: [SystemEvent];
  unknown: [PanelFrame];
  error: [Error];
}
