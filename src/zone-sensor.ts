import type { PlatformAccessory, Service } from 'homebridge';
import type { PimaForcePlatform } from './platform.js';
import type { ZoneType } from './types.js';

export interface ZoneAccessoryContext {
  kind: 'zone';
  zone: number;
  name: string;
  type: ZoneType;
}

interface SensorBinding {
  // HAP service/characteristic constructors are concrete subclasses with
  // varying signatures; treat them as opaque here. The `any` is contained
  // to this binding shape and the construction site below.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  serviceCtor: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  characteristic: any;
  activeValue: number | boolean;
  inactiveValue: number | boolean;
}

function bindingsFor(platform: PimaForcePlatform): Record<ZoneType, SensorBinding> {
  const { Service: HapService, Characteristic } = platform.api.hap;
  return {
    contact: {
      serviceCtor: HapService.ContactSensor,
      characteristic: Characteristic.ContactSensorState,
      // ContactSensorState: 0 = CONTACT_DETECTED (closed), 1 = CONTACT_NOT_DETECTED (open).
      activeValue: Characteristic.ContactSensorState.CONTACT_NOT_DETECTED,
      inactiveValue: Characteristic.ContactSensorState.CONTACT_DETECTED,
    },
    motion: {
      serviceCtor: HapService.MotionSensor,
      characteristic: Characteristic.MotionDetected,
      activeValue: true,
      inactiveValue: false,
    },
    leak: {
      serviceCtor: HapService.LeakSensor,
      characteristic: Characteristic.LeakDetected,
      activeValue: Characteristic.LeakDetected.LEAK_DETECTED,
      inactiveValue: Characteristic.LeakDetected.LEAK_NOT_DETECTED,
    },
    smoke: {
      serviceCtor: HapService.SmokeSensor,
      characteristic: Characteristic.SmokeDetected,
      activeValue: Characteristic.SmokeDetected.SMOKE_DETECTED,
      inactiveValue: Characteristic.SmokeDetected.SMOKE_NOT_DETECTED,
    },
  };
}

/**
 * Sensor accessory for a zone. The HomeKit service type is selected from
 * config (`contact` | `motion` | `leak` | `smoke`) and dispatched at
 * construction time to the matching HAP service + characteristic.
 *
 * The same panel event semantics (qualifier 1 = active / qualifier 3 =
 * restored) apply to every type; only the HomeKit presentation differs.
 *
 * Type changes on an existing zone are handled idempotently: any
 * non-matching sensor service we recognize is removed before the matching
 * one is added, so toggling the dropdown in config doesn't leave stray
 * services on the cached accessory.
 */
export class ZoneSensor {
  private readonly service: Service;
  private readonly binding: SensorBinding;
  private active = false;

  constructor(
    private readonly platform: PimaForcePlatform,
    private readonly accessory: PlatformAccessory<ZoneAccessoryContext>,
  ) {
    const { Characteristic, Service: HapService } = platform.api.hap;
    const { zone, type } = accessory.context;
    const allBindings = bindingsFor(platform);
    this.binding = allBindings[type] ?? allBindings.contact;

    accessory
      .getService(HapService.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'Pima')
      .setCharacteristic(Characteristic.Model, `FORCE Zone (${type})`)
      .setCharacteristic(Characteristic.SerialNumber, `zone-${zone}`);

    // Remove any sibling sensor service from a previous type so we don't
    // leave a stale ContactSensor next to a fresh MotionSensor when the
    // user changes the dropdown.
    for (const other of Object.values(allBindings)) {
      if (other.serviceCtor.UUID === this.binding.serviceCtor.UUID) continue;
      const existing = accessory.getService(other.serviceCtor);
      if (existing) accessory.removeService(existing);
    }

    this.service =
      accessory.getService(this.binding.serviceCtor) ??
      accessory.addService(this.binding.serviceCtor, accessory.context.name);
    this.service.setCharacteristic(Characteristic.Name, accessory.context.name);

    this.service
      .getCharacteristic(this.binding.characteristic)
      .onGet(() => this.value());
  }

  /** Update from a panel zone event. */
  setActive(active: boolean): void {
    if (this.active === active) return;
    this.active = active;
    this.service.updateCharacteristic(this.binding.characteristic, this.value());
  }

  private value(): number | boolean {
    return this.active ? this.binding.activeValue : this.binding.inactiveValue;
  }
}
