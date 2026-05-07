export interface PartitionConfig {
  id: number;
  userCode: string;
}

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
  system: [SystemEvent];
  unknown: [PanelFrame];
  error: [Error];
}
