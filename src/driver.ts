import { EventEmitter } from 'node:events';
import {
  EVENT_TYPE_BURGLARY,
  EVENT_TYPE_COMM,
  EVENT_TYPE_LOCAL_ARM,
  EVENT_TYPE_OUTPUT,
  EVENT_TYPE_REMOTE_ARM,
  EVENT_TYPE_ZONE,
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
  QUALIFIER_NEW,
  QUALIFIER_RESTORE,
} from './protocol.js';
import { PimaTransport } from './transport.js';
import type {
  ArmEventSource,
  ArmMode,
  DataResponse,
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
 * Domain layer for the Pima FORCE local CMS protocol. Translates HomeKit-
 * level operations (arm/disarm, output toggles, parameter queries) into
 * the wire-protocol `OutboundRequest` shapes the transport understands, and
 * translates inbound panel-originated frames into typed driver events.
 *
 * Owns no socket / counter / wire-queue state — that lives in `PimaTransport`.
 * The driver simply re-emits the transport's lifecycle/debug events and
 * dispatches `panelFrame` into the typed event surface used by the platform.
 */
export class PimaDriver extends EventEmitter<PimaDriverEvents> {
  private readonly config: PimaDriverConfig;
  private readonly partitionByCode: Map<number, PartitionConfig>;
  private readonly transport: PimaTransport;

  constructor(config: PimaDriverConfig) {
    super();
    this.config = config;
    this.partitionByCode = new Map(config.partitions.map((p) => [p.id, p]));
    this.transport = new PimaTransport({
      port: config.port,
      account: config.account,
      encoding: config.encoding,
      opCounterStart: config.opCounterStart,
      requestTimeoutMs: config.requestTimeoutMs,
    });

    // Lifecycle + debug events pass through unchanged.
    this.transport.on('connected', () => this.emit('connected'));
    this.transport.on('verified', () => this.emit('verified'));
    this.transport.on('disconnected', () => this.emit('disconnected'));
    this.transport.on('error', (err) => this.emit('error', err));
    this.transport.on('frameIn', (f) => this.emit('frameIn', f));
    this.transport.on('frameOut', (f) => this.emit('frameOut', f));

    // Inbound panel frames not claimed by an in-flight `send` come here.
    this.transport.on('panelFrame', (frame) => this.dispatchPanelFrame(frame));
  }

  start(): Promise<void> {
    return this.transport.start();
  }

  stop(): Promise<void> {
    return this.transport.stop();
  }

  isConnected(): boolean {
    return this.transport.isConnected();
  }

  /** Address the TCP server is bound to. Null when not started. Mainly for tests. */
  address(): import('node:net').AddressInfo | null {
    return this.transport.address();
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
  setOutput(output: number, active: boolean): Promise<void> {
    const part = this.config.partitions[0];
    if (!part) {
      return Promise.reject(new Error('no partition configured to derive a user code for output operation'));
    }
    return this.transport.send({
      kind: 'operation',
      account: this.config.account,
      password: part.userCode,
      optype: active ? OPTYPE_ACTIVATE_OUTPUT : OPTYPE_DEACTIVATE_OUTPUT,
      partition: 0,
      order: output,
    }).then(() => undefined);
  }

  /**
   * Request a configuration/status parameter from the panel. Resolves with
   * the matching DATA frame's contents. Authorization uses the first
   * configured partition's user code unless `params.password` is provided.
   *
   * Pagination is not handled here — when `more` is true, the caller is
   * responsible for issuing the follow-up request.
   */
  requestData(params: { id: number; startOrder: number; stopOrder?: number; password?: string }): Promise<DataResponse> {
    const part = this.config.partitions[0];
    if (!part && !params.password) {
      return Promise.reject(new Error('no partition configured to derive a user code for DATA-REQ'));
    }
    return this.transport.send({
      kind: 'data-req',
      account: this.config.account,
      password: params.password ?? part!.userCode,
      id: params.id,
      startOrder: params.startOrder,
      stopOrder: params.stopOrder,
    }).then((frame) => this.toDataResponse(frame));
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
   * authenticating with that partition's own user code.
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

  private sendOperation(optype: number, partition: number): Promise<void> {
    const part = this.partitionByCode.get(partition);
    if (!part) {
      return Promise.reject(new Error(`partition ${partition} not configured`));
    }
    return this.transport.send({
      kind: 'operation',
      account: this.config.account,
      password: part.userCode,
      optype,
      partition,
    }).then(() => undefined);
  }

  private toDataResponse(frame: PanelFrame): DataResponse {
    let params = Array.isArray(frame.parameters)
      ? (frame.parameters as unknown[]).map(String)
      : [];
    if (this.config.reverseStrings) {
      // Spread iterates by code point so non-BMP characters (e.g. emoji)
      // wouldn't get split mid-surrogate; for Hebrew this is just code
      // unit reversal anyway since it's BMP.
      params = params.map((s) => [...s].reverse().join(''));
    }
    const more = (frame as { more?: string }).more === 'yes';
    return { parameters: params, more };
  }

  private dispatchPanelFrame(frame: PanelFrame): void {
    const t = frame.frame_type;

    if (t === 'NAK') {
      // Unmatched NAKs (counter doesn't match an in-flight, or counter=0 from
      // a panel-side JSON parse error). Surface so the platform can log it.
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

    // Stray DATA frames (shouldn't normally happen — every DATA should match
    // an in-flight `send`) and any unrecognized frame types end up here.
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
