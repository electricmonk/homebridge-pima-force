/**
 * `homeBridge` driver — what the homebridge-config-ui-x HTTP API looks
 * like to a test.
 *
 * The driver wraps the UI's REST surface (`/api/accessories`) so tests
 * speak in domain terms (`partition('E2E Partition').setTarget(AWAY_ARM)`,
 * `siren.on`, `zone('E2E Door').contactState`) rather than in HTTP verbs
 * and characteristic-type strings.
 *
 * Style: state getters return snapshots; tests wrap them in `eventually`
 * to poll. Setters do the HTTP PUT and return after the API responds.
 */

interface AccessoryServiceWire {
  uniqueId: string;
  aid: number;
  iid: number;
  uuid: string;
  type: string;
  serviceName: string;
  serviceCharacteristics: Array<{ type: string; value: unknown }>;
}

export interface AccessorySnapshot extends AccessoryServiceWire {
  values: Record<string, unknown>;
}

export interface HomeBridge {
  /** All accessories the UI currently knows about. */
  listAccessories(): Promise<AccessorySnapshot[]>;
  /** A single accessory by service name (e.g. 'E2E Partition'). Throws if absent. */
  findAccessory(name: string): Promise<AccessorySnapshot>;

  partition(name: string): PartitionDriver;
  zone(name: string): ZoneDriver;
  siren(name: string): SirenDriver;
}

export interface PartitionDriver {
  /** Fetch a fresh snapshot of `SecuritySystemCurrentState`. */
  currentState(): Promise<number>;
  /** Fetch a fresh snapshot of `SecuritySystemTargetState`. */
  targetState(): Promise<number>;
  /** Set `SecuritySystemTargetState` via PUT. Resolves when the UI responds. */
  setTarget(value: number): Promise<void>;
  /** Fetch the list of valid target states the partition exposes. */
  validTargetStates(): Promise<readonly number[]>;
  /** The underlying accessory snapshot — escape hatch. */
  snapshot(): Promise<AccessorySnapshot>;
}

export interface ZoneDriver {
  /** Fetch a fresh `ContactSensorState` / `MotionDetected` / etc. Reads the first sensor-style characteristic. */
  state(): Promise<unknown>;
  /** Fetch a snapshot. */
  snapshot(): Promise<AccessorySnapshot>;
}

export interface SirenDriver {
  /** Fetch a fresh `On` value. */
  on(): Promise<boolean>;
  /** Set `On` via PUT. The plugin rejects ON; OFF de-activates the siren output. */
  setOn(value: boolean): Promise<void>;
  snapshot(): Promise<AccessorySnapshot>;
}

export interface HomeBridgeOptions {
  /** Base URL for the UI, e.g. `http://127.0.0.1:8581`. */
  baseUrl: string;
  /** Bearer token for `/api/*` calls. */
  token: string;
}

export function homeBridge(opts: HomeBridgeOptions): HomeBridge {
  const api = async <T = unknown>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await fetch(`${opts.baseUrl}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${opts.token}`,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`${method} ${path} → ${res.status} ${res.statusText}: ${text}`);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  };

  const listAccessories = async (): Promise<AccessorySnapshot[]> => {
    const list = await api<AccessoryServiceWire[]>('GET', '/api/accessories');
    return list.map((a) => ({
      ...a,
      values: Object.fromEntries(a.serviceCharacteristics.map((c) => [c.type, c.value])),
    }));
  };

  const findAccessory = async (name: string): Promise<AccessorySnapshot> => {
    const list = await listAccessories();
    const acc = list.find((a) => a.serviceName === name);
    if (!acc) {
      throw new Error(`accessory "${name}" not found; saw: ${list.map((a) => a.serviceName).join(', ')}`);
    }
    return acc;
  };

  const setCharacteristic = async (uniqueId: string, type: string, value: unknown): Promise<void> => {
    await api('PUT', `/api/accessories/${uniqueId}`, { characteristicType: type, value });
  };

  const partition = (name: string): PartitionDriver => ({
    async snapshot(): Promise<AccessorySnapshot> {
      return findAccessory(name);
    },
    async currentState(): Promise<number> {
      const acc = await findAccessory(name);
      return Number(acc.values.SecuritySystemCurrentState);
    },
    async targetState(): Promise<number> {
      const acc = await findAccessory(name);
      return Number(acc.values.SecuritySystemTargetState);
    },
    async setTarget(value: number): Promise<void> {
      const acc = await findAccessory(name);
      await setCharacteristic(acc.uniqueId, 'SecuritySystemTargetState', value);
    },
    async validTargetStates(): Promise<readonly number[]> {
      const acc = await findAccessory(name);
      const c = acc.serviceCharacteristics.find((sc) => sc.type === 'SecuritySystemTargetState');
      const validValues = (c as { validValues?: number[] } | undefined)?.validValues;
      return validValues ?? [];
    },
  });

  const zone = (name: string): ZoneDriver => ({
    async snapshot(): Promise<AccessorySnapshot> {
      return findAccessory(name);
    },
    async state(): Promise<unknown> {
      const acc = await findAccessory(name);
      // Surface whichever sensor-style characteristic the zone exposes.
      const sensorTypes = ['ContactSensorState', 'MotionDetected', 'LeakDetected', 'SmokeDetected'];
      for (const t of sensorTypes) {
        if (t in acc.values) return acc.values[t];
      }
      throw new Error(`zone "${name}" has no recognised sensor characteristic; values: ${JSON.stringify(acc.values)}`);
    },
  });

  const siren = (name: string): SirenDriver => ({
    async snapshot(): Promise<AccessorySnapshot> {
      return findAccessory(name);
    },
    async on(): Promise<boolean> {
      const acc = await findAccessory(name);
      return Boolean(acc.values.On);
    },
    async setOn(value: boolean): Promise<void> {
      const acc = await findAccessory(name);
      await setCharacteristic(acc.uniqueId, 'On', value);
    },
  });

  return { listAccessories, findAccessory, partition, zone, siren };
}
