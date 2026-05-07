import type {
  API,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
} from 'homebridge';
import { PimaDriver } from './driver.js';
import { PartitionSwitch, type PartitionAccessoryContext } from './partition-switch.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import { ZoneSensor, type ZoneAccessoryContext } from './zone-sensor.js';
import type { ZoneType } from './types.js';

interface ZoneConfig {
  zone: number;
  name: string;
  type?: ZoneType;
}

const DEFAULT_ZONE_TYPE: ZoneType = 'contact';

interface PartitionConfigEntry {
  id: number;
  name: string;
  userCode: string;
  zones?: ZoneConfig[];
}

interface PimaForcePlatformConfig extends PlatformConfig {
  port?: number;
  account?: number;
  partitions?: PartitionConfigEntry[];
}

type AnyContext = PartitionAccessoryContext | ZoneAccessoryContext;

export class PimaForcePlatform implements DynamicPlatformPlugin {
  public readonly driver: PimaDriver;

  /** Accessories restored from the cache by Homebridge between launches. */
  private readonly cachedAccessories = new Map<string, PlatformAccessory<AnyContext>>();
  private readonly partitions = new Map<number, PartitionSwitch>();
  private readonly zones = new Map<number, ZoneSensor>();
  /** Track ids we've already info-logged so we don't spam on every event. */
  private readonly seenUnknownPartitions = new Set<number>();
  private readonly seenUnknownZones = new Set<number>();

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
    });

    this.driver.on('connected',    () => log.info('alarm panel connected'));
    this.driver.on('disconnected', () => log.info('alarm panel disconnected'));
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
    this.driver.on('system', ({ kind, ok, channel, partition }) => {
      log.debug(`system ${kind} channel ${channel} partition ${partition} → ${ok ? 'restored' : 'trouble'}`);
    });
    this.driver.on('unknown', (frame) => {
      log.warn(`unknown panel frame: ${JSON.stringify(frame)}`);
    });

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
    this.log.info(`received ${what} for unconfigured partition ${id} — add it to plugin config to expose as a HomeKit switch`);
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

  private discoverDevices(): void {
    const partitions = this.config.partitions ?? [];
    const desiredUuids = new Set<string>();

    for (const partConfig of partitions) {
      desiredUuids.add(this.registerPartition(partConfig));
      for (const zoneConfig of partConfig.zones ?? []) {
        desiredUuids.add(this.registerZone(partConfig.id, zoneConfig));
      }
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
    const uuid = this.api.hap.uuid.generate(`pima-force:partition:${p.id}`);
    const ctx: PartitionAccessoryContext = { kind: 'partition', id: p.id, name: p.name };
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
      this.log.info(`registered partition switch: ${p.name} (id ${p.id})`);
    }
    this.partitions.set(p.id, new PartitionSwitch(this, accessory));
    return uuid;
  }

  private registerZone(partitionId: number, z: ZoneConfig): string {
    const uuid = this.api.hap.uuid.generate(`pima-force:zone:${z.zone}`);
    const ctx: ZoneAccessoryContext = {
      kind: 'zone',
      zone: z.zone,
      partition: partitionId,
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
      this.log.info(`registered zone sensor: ${z.name} (zone ${z.zone}, partition ${partitionId})`);
    }
    this.zones.set(z.zone, new ZoneSensor(this, accessory));
    return uuid;
  }
}
