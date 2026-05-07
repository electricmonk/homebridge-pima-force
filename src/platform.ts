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

interface ZoneConfig {
  zone: number;
  name: string;
}

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
  /** Partition number → set of zone numbers belonging to it (used to scope arm-state pushes if ever needed). */

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
      log.info(`partition ${partition} ARMED (source: ${source})`);
      this.partitions.get(partition)?.setArmedFromPanel(true);
    });
    this.driver.on('disarm', ({ partition, source }) => {
      log.info(`partition ${partition} DISARMED (source: ${source})`);
      this.partitions.get(partition)?.setArmedFromPanel(false);
    });
    this.driver.on('zone', ({ zone, partition, active }) => {
      log.debug(`zone ${zone} (partition ${partition}) → ${active ? 'active' : 'restored'}`);
      this.zones.get(zone)?.setActive(active);
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
