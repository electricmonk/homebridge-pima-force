/**
 * Frame builders — ubiquitous-language factories that hide the wire shape.
 *
 * Tests speak in `zoneOpened({zone:4, partition:2})`, not in `type:760
 * qualifier:1 frame_type:event`. The `alarmSystem` driver knows how to
 * serialise a blueprint into a wire frame (it fills in `counter`, `account`,
 * `frame_type`), so blueprints carry only the fields a story-level reader
 * cares about.
 *
 * Built on `ts-byob` (`builderFor<T>(defaults)`): pass `{...overrides}` to
 * customise, leave the rest at sensible defaults.
 */
import { builderFor } from 'ts-byob';
import {
  EVENT_TYPE_BURGLARY,
  EVENT_TYPE_COMM,
  EVENT_TYPE_LOCAL_ARM,
  EVENT_TYPE_OUTPUT,
  EVENT_TYPE_REMOTE_ARM,
  EVENT_TYPE_ZONE,
  OUTPUT_EXTERNAL_SIREN,
  PARTITION_DISARMED,
  PARAM_ID_NUMBER_OF_INSTALLED_ZONES,
  PARAM_ID_SYSTEM_KEY_STATUS,
  PARAM_ID_ZONE_NAMES,
  QUALIFIER_NEW,
  QUALIFIER_RESTORE,
} from './constants.js';

// ---------------------------------------------------------------------------
// Reports (panel → us) — the `alarmSystem` driver wraps these in
//   { frame_type: 'event', counter, account, ...blueprint }
// ---------------------------------------------------------------------------

/** Blueprint for an `EVENT` frame: type + qualifier + zone + partition. */
export interface EventBlueprint {
  type: number;
  qualifier: number;
  zone: number;
  partition: number;
}

const event = (overrides: Partial<EventBlueprint> & Pick<EventBlueprint, 'type' | 'qualifier'>): EventBlueprint =>
  builderFor<EventBlueprint>(() => ({
    type: overrides.type,
    qualifier: overrides.qualifier,
    zone: 0,
    partition: 1,
  }))(overrides);

/** Zone open (CID 760, qualifier 1). */
export const zoneOpened = (o: { zone: number; partition: number }): EventBlueprint =>
  event({ type: EVENT_TYPE_ZONE, qualifier: QUALIFIER_NEW, ...o });

/** Zone restore to closed (CID 760, qualifier 3). */
export const zoneClosed = (o: { zone: number; partition: number }): EventBlueprint =>
  event({ type: EVENT_TYPE_ZONE, qualifier: QUALIFIER_RESTORE, ...o });

/**
 * Remote arm (CID 407 qualifier 3) — CMS-initiated arming. Qualifier=3
 * means "restore" which the panel uses for arm-closed.
 */
export const armedFromRemote = (o: { partition: number; user?: number }): EventBlueprint =>
  event({ type: EVENT_TYPE_REMOTE_ARM, qualifier: QUALIFIER_RESTORE, partition: o.partition, zone: o.user ?? 0 });

/** Remote disarm (CID 407 qualifier 1). */
export const disarmedFromRemote = (o: { partition: number; user?: number }): EventBlueprint =>
  event({ type: EVENT_TYPE_REMOTE_ARM, qualifier: QUALIFIER_NEW, partition: o.partition, zone: o.user ?? 0 });

/** Local arm (keypad / app, CID 401 qualifier 3). */
export const armedLocally = (o: { partition: number; user?: number }): EventBlueprint =>
  event({ type: EVENT_TYPE_LOCAL_ARM, qualifier: QUALIFIER_RESTORE, partition: o.partition, zone: o.user ?? 0 });

/** Local disarm (CID 401 qualifier 1). */
export const disarmedLocally = (o: { partition: number; user?: number }): EventBlueprint =>
  event({ type: EVENT_TYPE_LOCAL_ARM, qualifier: QUALIFIER_NEW, partition: o.partition, zone: o.user ?? 0 });

/** Burglary alarm sounding (CID 130 qualifier 1). */
export const burglaryAlarm = (o: { zone: number; partition: number }): EventBlueprint =>
  event({ type: EVENT_TYPE_BURGLARY, qualifier: QUALIFIER_NEW, ...o });

/** Burglary alarm restored (CID 130 qualifier 3). */
export const alarmRestored = (o: { zone: number; partition: number }): EventBlueprint =>
  event({ type: EVENT_TYPE_BURGLARY, qualifier: QUALIFIER_RESTORE, ...o });

/** External siren activated (CID 770 qualifier 1, zone field carries the output number). */
export const sirenActivated = (o: { partition: number; output?: number } = { partition: 1 }): EventBlueprint =>
  event({
    type: EVENT_TYPE_OUTPUT,
    qualifier: QUALIFIER_NEW,
    partition: o.partition,
    zone: o.output ?? OUTPUT_EXTERNAL_SIREN,
  });

/** External siren de-activated (CID 770 qualifier 3). */
export const sirenDeactivated = (o: { partition: number; output?: number } = { partition: 1 }): EventBlueprint =>
  event({
    type: EVENT_TYPE_OUTPUT,
    qualifier: QUALIFIER_RESTORE,
    partition: o.partition,
    zone: o.output ?? OUTPUT_EXTERNAL_SIREN,
  });

/** CMS comm path restored (CID 350 qualifier 3). */
export const commPathOk = (o: { partition: number; channel?: number }): EventBlueprint =>
  event({ type: EVENT_TYPE_COMM, qualifier: QUALIFIER_RESTORE, partition: o.partition, zone: o.channel ?? 0 });

/** CMS comm path trouble (CID 350 qualifier 1). */
export const commPathTrouble = (o: { partition: number; channel?: number }): EventBlueprint =>
  event({ type: EVENT_TYPE_COMM, qualifier: QUALIFIER_NEW, partition: o.partition, zone: o.channel ?? 0 });

// ---------------------------------------------------------------------------
// DATA responses (panel → us, in reply to a DATA-REQ) — the `alarmSystem`
// driver wraps these in:
//   { frame_type:'DATA', counter:<query.counter>, account, id:<query.id>,
//     start_order:<query.start_order>, ...payload }
// ---------------------------------------------------------------------------

export interface DataPayload {
  parameters: string[];
  more: boolean;
}

const aDataPayload = builderFor<DataPayload>(() => ({
  parameters: [],
  more: false,
}));

/** A single partition's System Key Status (id=2310). */
export const partitionStatus = (o: { status: number }): DataPayload =>
  aDataPayload({ parameters: [String(o.status)] });

/** Whole-system System Key Status: one entry per partition. */
export const partitionStatuses = (statuses: number[]): DataPayload =>
  aDataPayload({ parameters: statuses.map(String) });

/** Installed zone count (id=2148). */
export const zoneCount = (o: { count: number }): DataPayload =>
  aDataPayload({ parameters: [String(o.count)] });

/** Zone names (id=260). `more:true` triggers another page. */
export const zoneNames = (o: { names: string[]; more?: boolean }): DataPayload =>
  aDataPayload({ parameters: [...o.names], more: o.more ?? false });

/** Raw DATA payload escape hatch — for cases the named builders don't cover. */
export const aData = aDataPayload;

// ---------------------------------------------------------------------------
// NAK responses (panel → us). The `alarmSystem` driver wraps these in:
//   { frame_type:'NAK', counter:<query.counter or 0>, account, data:<reason> }
// ---------------------------------------------------------------------------

export interface NakPayload {
  /** Reason string (Appendix D of the spec). */
  data: string;
  /** If set, overrides counter — use 0 for "Invalid JSON frame"-style parse errors. */
  counter?: number;
}

export const nakWrongUserCode = (): NakPayload => ({ data: 'Wrong User Code' });
export const nakInvalidJsonFrame = (): NakPayload => ({ data: 'Invalid JSON frame', counter: 0 });
export const nakWrongAccountID = (): NakPayload => ({ data: 'Wrong Account ID' });
export const nakWithReason = (data: string): NakPayload => ({ data });

// ---------------------------------------------------------------------------
// Convenience re-exports of constants that read better at the call site
// ---------------------------------------------------------------------------

export const aPartitionState = {
  notExist: PARTITION_DISARMED, // 1 — guard against picking this by accident
};

// Sane defaults map for status that surfaces in tests
export {
  PARTITION_DISARMED,
  PARAM_ID_SYSTEM_KEY_STATUS,
  PARAM_ID_NUMBER_OF_INSTALLED_ZONES,
  PARAM_ID_ZONE_NAMES,
};
