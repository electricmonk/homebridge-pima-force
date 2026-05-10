import { promises as fsp } from 'node:fs';
import type {
  API,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
} from 'homebridge';
import { PimaDriver } from './driver.js';
import { PartitionSecuritySystem, type PartitionAccessoryContext } from './partition-security-system.js';
import { OUTPUT_EXTERNAL_SIREN, PARAM_ID_NUMBER_OF_INSTALLED_ZONES, PARAM_ID_ZONE_NAMES } from './protocol.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import { SirenSwitch, type SirenAccessoryContext } from './siren-switch.js';
import type { ZoneType } from './types.js';
import { ZoneSensor, type ZoneAccessoryContext } from './zone-sensor.js';

interface ZoneConfig {
  zone: number;
  name: string;
  type?: ZoneType;
}

const DEFAULT_ZONE_TYPE: ZoneType = 'contact';
const DEFAULT_SIREN_NAME = 'Alarm Siren';
const ZONE_DISCOVERY_TIMEOUT_MS = 5000;
const ZONE_NAMES_PAGE_SIZE = 16;

interface PartitionConfigEntry {
  id: number;
  name: string;
  userCode: string;
  /** Legacy: zones used to be nested under partitions. Migrated at startup. */
  zones?: ZoneConfig[];
  /** Optional checkboxes for which HomeKit armed states to expose. */
  armModes?: { away?: boolean; stay?: boolean; night?: boolean };
}

interface SirenConfig {
  enabled?: boolean;
  name?: string;
}

interface PimaForcePlatformConfig extends PlatformConfig {
  port?: number;
  account?: number;
  partitions?: PartitionConfigEntry[];
  /** Top-level zones (current schema). */
  zones?: ZoneConfig[];
  siren?: SirenConfig;
  /** Panel text encoding for non-ASCII names. Default 'windows-1255' (Israeli FORCE). */
  encoding?: string;
  /** When true, log every frame in/out at info level (passwords redacted). */
  debug?: boolean;
}

type AnyContext = PartitionAccessoryContext | ZoneAccessoryContext | SirenAccessoryContext;

/** Strip the `password` field from a frame before logging. */
function redactPassword(frame: Record<string, unknown>): Record<string, unknown> {
  if (frame.password === undefined) return frame;
  return { ...frame, password: '***' };
}

export class PimaForcePlatform implements DynamicPlatformPlugin {
  public readonly driver: PimaDriver;

  /** Accessories restored from the cache by Homebridge between launches. */
  private readonly cachedAccessories = new Map<string, PlatformAccessory<AnyContext>>();
  private readonly partitions = new Map<number, PartitionSecuritySystem>();
  private readonly zones = new Map<number, ZoneSensor>();
  /** Output number → accessory (e.g., 1 = external siren). */
  private readonly sirens = new Map<number, SirenSwitch>();
  /** Track ids we've already info-logged so we don't spam on every event. */
  private readonly seenUnknownPartitions = new Set<number>();
  private readonly seenUnknownZones = new Set<number>();
  private readonly seenUnknownOutputs = new Set<number>();
  /** Auto-discovery runs at most once per process — successful or not. */
  private autoDiscoveryAttempted = false;

  constructor(
    public readonly log: Logger,
    public readonly config: PimaForcePlatformConfig,
    public readonly api: API,
  ) {
    const partitions = config.partitions ?? [];
    if (partitions.length === 0) {
      log.warn('No partitions configured; plugin will register no accessories. Open the plugin settings to add partitions and zones.');
    }

    this.driver = new PimaDriver({
      port: config.port ?? 7780,
      account: config.account ?? 1234,
      partitions: partitions.map((p) => ({ id: p.id, userCode: p.userCode })),
      encoding: config.encoding ?? 'windows-1255',
    });

    this.driver.on('connected', () => log.info('alarm panel connected'));
    this.driver.on('disconnected', () => log.info('alarm panel disconnected'));
    // Trigger zone discovery on the first frame we receive from the panel,
    // not on raw TCP `connected`. Real panels start emitting `null`
    // heartbeats immediately; transient probes (a port check that connects
    // and immediately destroys the socket) never send a frame and so won't
    // race the discovery against a closing socket.
    this.driver.on('frameIn', () => {
      if (this.autoDiscoveryAttempted) return;
      void this.maybeDiscoverNewZones();
    });
    this.driver.on('error', (err) => log.error(`driver error: ${err.message}`));

    this.driver.on('arm', ({ partition, source }) => {
      const acc = this.partitions.get(partition);
      if (acc) {
        log.info(`partition ${partition} ARMED (source: ${source})`);
        acc.setArmedFromPanel(true);
      } else {
        this.noteUnknownPartition(partition, `arm (source: ${source})`);
      }
    });
    this.driver.on('disarm', ({ partition, source }) => {
      const acc = this.partitions.get(partition);
      if (acc) {
        log.info(`partition ${partition} DISARMED (source: ${source})`);
        acc.setArmedFromPanel(false);
      } else {
        this.noteUnknownPartition(partition, `disarm (source: ${source})`);
      }
    });
    this.driver.on('zone', ({ zone, partition, active }) => {
      const acc = this.zones.get(zone);
      if (acc) {
        log.debug(`zone ${zone} (partition ${partition}) → ${active ? 'active' : 'restored'}`);
        acc.setActive(active);
      } else {
        this.noteUnknownZone(zone, partition, active);
      }
    });
    this.driver.on('output', ({ output, partition, active }) => {
      const acc = this.sirens.get(output);
      if (acc) {
        log.info(`output ${output} (partition ${partition}) → ${active ? 'ACTIVE' : 'inactive'}`);
        acc.setSounding(active);
      } else {
        this.noteUnknownOutput(output, partition, active);
      }
    });
    this.driver.on('alarm', ({ zone, partition, active }) => {
      const acc = this.partitions.get(partition);
      if (acc) {
        log.warn(`partition ${partition} ${active ? 'ALARM TRIGGERED' : 'alarm restored'} (zone ${zone})`);
        acc.setAlarmTriggered(active);
      } else {
        this.noteUnknownPartition(partition, `alarm zone ${zone} ${active ? 'triggered' : 'restored'}`);
      }
    });
    this.driver.on('system', ({ kind, ok, channel, partition }) => {
      log.debug(`system ${kind} channel ${channel} partition ${partition} → ${ok ? 'restored' : 'trouble'}`);
    });
    this.driver.on('nak', ({ counter, account, reason }) => {
      // The panel rejected an OPERATION/ACK we sent. Log loudly so the user
      // can see why a command (e.g. siren mute) silently didn't take effect.
      log.warn(`panel NAK (counter=${counter}, account=${account}): ${reason}`);
    });
    this.driver.on('unknown', (frame) => {
      log.warn(`unknown panel frame: ${JSON.stringify(frame)}`);
    });

    // Optional verbose mode: log every wire frame in both directions.
    // Off by default; enable via `"debug": true` in plugin config.
    if (config.debug) {
      log.info('debug logging enabled — every frame in/out will be logged');
      this.driver.on('frameIn', (frame) => {
        log.info(`<< ${JSON.stringify(frame)}`);
      });
      this.driver.on('frameOut', (frame) => {
        log.info(`>> ${JSON.stringify(redactPassword(frame))}`);
      });
    }

    api.on('didFinishLaunching', () => this.discoverDevices());
    api.on('shutdown', () => {
      void this.driver.stop();
    });
  }

  configureAccessory(accessory: PlatformAccessory<AnyContext>): void {
    this.cachedAccessories.set(accessory.UUID, accessory);
  }

  private noteUnknownPartition(id: number, what: string): void {
    if (this.seenUnknownPartitions.has(id)) {
      this.log.debug(`${what} for unconfigured partition ${id}`);
      return;
    }
    this.seenUnknownPartitions.add(id);
    this.log.info(`received ${what} for unconfigured partition ${id} — add it to plugin config to expose as a HomeKit security system`);
  }

  private noteUnknownZone(zone: number, partition: number, active: boolean): void {
    const state = active ? 'active' : 'restored';
    if (this.seenUnknownZones.has(zone)) {
      this.log.debug(`zone ${zone} (partition ${partition}) → ${state}; unconfigured`);
      return;
    }
    this.seenUnknownZones.add(zone);
    this.log.info(`received zone event ${zone} (partition ${partition}) → ${state} for unconfigured zone — add it to plugin config to expose as a HomeKit sensor`);
  }

  private noteUnknownOutput(output: number, partition: number, active: boolean): void {
    const state = active ? 'active' : 'inactive';
    if (this.seenUnknownOutputs.has(output)) {
      this.log.debug(`output ${output} (partition ${partition}) → ${state}; unconfigured`);
      return;
    }
    this.seenUnknownOutputs.add(output);
    this.log.info(`received output event ${output} (partition ${partition}) → ${state}; no HomeKit accessory exposed for this output`);
  }

  /**
   * Read configured zones from both the current top-level shape and the
   * legacy nested-under-partitions shape, deduped by zone number. Top-level
   * entries win on collision so user customizations to the new schema aren't
   * clobbered by stale nested ones.
   */
  private resolveConfiguredZones(): { zones: ZoneConfig[]; migrated: number } {
    const zones = [...(this.config.zones ?? [])];
    const seen = new Set(zones.map((z) => z.zone));
    let migrated = 0;
    for (const p of this.config.partitions ?? []) {
      for (const z of p.zones ?? []) {
        if (seen.has(z.zone)) continue;
        zones.push({ zone: z.zone, name: z.name, type: z.type });
        seen.add(z.zone);
        migrated++;
      }
    }
    return { zones, migrated };
  }

  private discoverDevices(): void {
    const partitions = this.config.partitions ?? [];
    const desiredUuids = new Set<string>();

    const { zones: flatZones, migrated } = this.resolveConfiguredZones();
    if (migrated > 0) {
      this.log.info(`migrated ${migrated} zone(s) from legacy nested partition.zones to flat top-level config — accessories preserved (UUIDs unchanged). Move them to a top-level "zones" array in config.json to silence this message.`);
    }

    for (const partConfig of partitions) {
      desiredUuids.add(this.registerPartition(partConfig));
    }
    for (const zoneConfig of flatZones) {
      desiredUuids.add(this.registerZone(zoneConfig));
    }

    // Optional global siren accessory (single instance, output 1 by default).
    const sirenCfg = this.config.siren ?? {};
    const sirenEnabled = sirenCfg.enabled !== false; // default on
    if (sirenEnabled && partitions.length > 0) {
      desiredUuids.add(this.registerSiren(sirenCfg.name ?? DEFAULT_SIREN_NAME));
    }

    // Unregister any cached accessories no longer in config.
    const stale: PlatformAccessory<AnyContext>[] = [];
    for (const [uuid, acc] of this.cachedAccessories) {
      if (!desiredUuids.has(uuid)) stale.push(acc);
    }
    if (stale.length > 0) {
      this.log.info(`removing ${stale.length} stale accessory(ies): ${stale.map(a => a.displayName).join(', ')}`);
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
      for (const acc of stale) this.cachedAccessories.delete(acc.UUID);
    }

    this.driver.start().catch((err) => {
      this.log.error(`failed to start driver: ${(err as Error).message}`);
    });
  }

  private registerPartition(p: PartitionConfigEntry): string {
    // UUID prefix changed from `pima-force:partition` (Switch) to
    // `pima-force:security-system:` to ensure HomeKit treats this as a new
    // accessory after the v0.1 → v0.2 migration. The old Switch accessory
    // becomes stale and is removed by the cleanup pass.
    const uuid = this.api.hap.uuid.generate(`pima-force:security-system:${p.id}`);
    const ctx: PartitionAccessoryContext = {
      kind: 'partition',
      id: p.id,
      name: p.name,
      armModes: p.armModes,
    };
    let accessory = this.cachedAccessories.get(uuid) as
      | PlatformAccessory<PartitionAccessoryContext>
      | undefined;
    if (accessory) {
      accessory.context = ctx;
      accessory.displayName = p.name;
    } else {
      accessory = new this.api.platformAccessory<PartitionAccessoryContext>(p.name, uuid);
      accessory.context = ctx;
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.cachedAccessories.set(uuid, accessory as PlatformAccessory<AnyContext>);
      this.log.info(`registered partition security system: ${p.name} (id ${p.id})`);
    }
    this.partitions.set(p.id, new PartitionSecuritySystem(this, accessory));
    return uuid;
  }

  private registerZone(z: ZoneConfig): string {
    const uuid = this.api.hap.uuid.generate(`pima-force:zone:${z.zone}`);
    const ctx: ZoneAccessoryContext = {
      kind: 'zone',
      zone: z.zone,
      name: z.name,
      type: z.type ?? DEFAULT_ZONE_TYPE,
    };
    let accessory = this.cachedAccessories.get(uuid) as
      | PlatformAccessory<ZoneAccessoryContext>
      | undefined;
    if (accessory) {
      accessory.context = ctx;
      accessory.displayName = z.name;
    } else {
      accessory = new this.api.platformAccessory<ZoneAccessoryContext>(z.name, uuid);
      accessory.context = ctx;
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.cachedAccessories.set(uuid, accessory as PlatformAccessory<AnyContext>);
      this.log.info(`registered zone sensor: ${z.name} (zone ${z.zone})`);
    }
    this.zones.set(z.zone, new ZoneSensor(this, accessory));
    return uuid;
  }

  /**
   * On every panel connect, query the panel for its zone names (param 260)
   * and append any zones not already in config.json. Append-only — never
   * touches existing entries (preserves user-set type/name overrides) and
   * never deletes entries the panel doesn't currently report (a zone might
   * be temporarily absent; user-defined entries are sacred).
   *
   * No-op when the panel reports no new zones — the file is only written
   * when there's an actual delta to persist.
   */
  private async maybeDiscoverNewZones(): Promise<void> {
    if (this.autoDiscoveryAttempted) return;
    if (!this.config.partitions || this.config.partitions.length === 0) return;
    this.autoDiscoveryAttempted = true;
    try {
      const count = await this.queryZoneCount();
      if (!count) return;
      const names = await this.queryZoneNames(count);

      const known = new Set<number>();
      for (const z of this.config.zones ?? []) known.add(z.zone);
      for (const p of this.config.partitions ?? []) {
        for (const z of p.zones ?? []) known.add(z.zone);
      }

      const newZones: ZoneConfig[] = [];
      for (const [zone, name] of names) {
        const trimmed = name.trim();
        if (!trimmed) continue;
        if (known.has(zone)) continue;
        newZones.push({ zone, name: trimmed, type: DEFAULT_ZONE_TYPE });
      }

      if (newZones.length === 0) {
        this.log.debug('zone discovery: no new zones to add');
        return;
      }

      this.log.info(`zone discovery: appending ${newZones.length} new zone(s) to config.json: ${newZones.map((z) => `${z.zone} "${z.name}"`).join(', ')}`);
      await this.appendZonesToConfig(newZones);
      // Also register the accessories in-process so they appear in HomeKit
      // immediately. homebridge-config-ui-x reflects the config.json change
      // in its form but does NOT trigger a Homebridge restart on its own —
      // without this in-process registration, the accessories wouldn't show
      // up until the user manually restarted Homebridge.
      for (const z of newZones) {
        this.registerZone(z);
      }
      this.log.info(`zone discovery: ${newZones.length} new HomeKit sensor(s) registered (default type "${DEFAULT_ZONE_TYPE}"). Edit each zone's type in the plugin settings; type changes take effect on the next Homebridge restart.`);
    } catch (err) {
      this.log.warn(`zone discovery skipped: ${(err as Error).message}`);
    }
  }

  private queryZoneCount(): Promise<number> {
    return this.requestParameter(PARAM_ID_NUMBER_OF_INSTALLED_ZONES, 1, 1).then((p) => Number(p[0] ?? 0));
  }

  private async queryZoneNames(count: number): Promise<Map<number, string>> {
    const names = new Map<number, string>();
    let cursor = 1;
    while (cursor <= count) {
      const stop = Math.min(cursor + ZONE_NAMES_PAGE_SIZE - 1, count);
      const params = await this.requestParameter(PARAM_ID_ZONE_NAMES, cursor, stop);
      params.forEach((name, i) => names.set(cursor + i, name));
      cursor = stop + 1;
    }
    return names;
  }

  /**
   * Issue a DATA-REQ and resolve with the matching DATA event's parameters.
   * Rejects on any NAK in the meantime (panel emits counter=0 NAKs that we
   * can't match precisely — treating any in-flight NAK as ours is good enough
   * here because discovery is the only thing we run on connect).
   */
  private requestParameter(id: number, startOrder: number, stopOrder: number): Promise<string[]> {
    return new Promise((resolve, reject) => {
      const cleanup = (): void => {
        clearTimeout(timer);
        this.driver.off('data', dataHandler);
        this.driver.off('nak', nakHandler);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`timeout waiting for DATA id=${id} start=${startOrder}`));
      }, ZONE_DISCOVERY_TIMEOUT_MS);
      const dataHandler = (msg: { id: number; startOrder: number; parameters: string[] }): void => {
        if (msg.id === id && msg.startOrder === startOrder) {
          cleanup();
          resolve(msg.parameters);
        }
      };
      const nakHandler = ({ counter, reason }: { counter?: number; reason: string }): void => {
        cleanup();
        reject(new Error(`panel NAK: ${reason} (counter=${counter ?? '?'})`));
      };
      this.driver.on('data', dataHandler);
      this.driver.on('nak', nakHandler);
      this.driver.requestData({ id, startOrder, stopOrder }).catch((err) => {
        cleanup();
        reject(err);
      });
    });
  }

  /**
   * Atomically append new zones to our slice of config.json. Writes to a
   * sibling temp file and renames into place to prevent leaving config.json
   * partially written if the process dies mid-write. homebridge-config-ui-x
   * watches config.json and reloads automatically.
   */
  private async appendZonesToConfig(newZones: ZoneConfig[]): Promise<void> {
    const path = this.api.user.configPath();
    const text = await fsp.readFile(path, 'utf8');
    const json = JSON.parse(text) as { platforms?: Array<Record<string, unknown>> };
    const platforms = Array.isArray(json.platforms) ? json.platforms : [];
    const myEntry = platforms.find((p) => p.platform === PLATFORM_NAME);
    if (!myEntry) {
      this.log.warn(`zone discovery: could not find platform "${PLATFORM_NAME}" in config.json; skipping write`);
      return;
    }
    const existing = Array.isArray(myEntry.zones) ? (myEntry.zones as ZoneConfig[]) : [];
    myEntry.zones = [...existing, ...newZones];

    const tmp = `${path}.pima-force.tmp.${process.pid}`;
    await fsp.writeFile(tmp, JSON.stringify(json, null, 4));
    await fsp.rename(tmp, path);
  }

  private registerSiren(name: string): string {
    const output = OUTPUT_EXTERNAL_SIREN;
    const uuid = this.api.hap.uuid.generate(`pima-force:siren:${output}`);
    const ctx: SirenAccessoryContext = { kind: 'siren', output, name };
    let accessory = this.cachedAccessories.get(uuid) as
      | PlatformAccessory<SirenAccessoryContext>
      | undefined;
    if (accessory) {
      accessory.context = ctx;
      accessory.displayName = name;
    } else {
      accessory = new this.api.platformAccessory<SirenAccessoryContext>(name, uuid);
      accessory.context = ctx;
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.cachedAccessories.set(uuid, accessory as PlatformAccessory<AnyContext>);
      this.log.info(`registered siren speaker: ${name} (output ${output})`);
    }
    this.sirens.set(output, new SirenSwitch(this, accessory));
    return uuid;
  }
}
