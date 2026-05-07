import type { PlatformAccessory, Service } from 'homebridge';
import type { PimaForcePlatform } from './platform.js';

export interface ZoneAccessoryContext {
  kind: 'zone';
  zone: number;
  partition: number;
  name: string;
}

/**
 * ContactSensor accessory for a zone. Open = active (zone tripped — door
 * open / motion / leak / smoke); Closed = inactive/restored.
 *
 * Same accessory type for all physical sensor types per the v2 spec.
 */
export class ZoneSensor {
  private readonly service: Service;
  private active = false;

  constructor(
    private readonly platform: PimaForcePlatform,
    private readonly accessory: PlatformAccessory<ZoneAccessoryContext>,
  ) {
    const { Characteristic, Service: HapService } = platform.api.hap;
    const { zone, partition } = accessory.context;

    accessory
      .getService(HapService.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'Pima')
      .setCharacteristic(Characteristic.Model, 'FORCE Zone')
      .setCharacteristic(Characteristic.SerialNumber, `partition-${partition}-zone-${zone}`);

    this.service =
      accessory.getService(HapService.ContactSensor) ??
      accessory.addService(HapService.ContactSensor, accessory.context.name);
    this.service.setCharacteristic(Characteristic.Name, accessory.context.name);

    this.service
      .getCharacteristic(Characteristic.ContactSensorState)
      .onGet(() => this.contactValue());
  }

  /** Update from a panel zone event. */
  setActive(active: boolean): void {
    if (this.active === active) return;
    this.active = active;
    this.service.updateCharacteristic(
      this.platform.api.hap.Characteristic.ContactSensorState,
      this.contactValue(),
    );
  }

  private contactValue(): number {
    // HomeKit ContactSensorState: 0 = CONTACT_DETECTED (closed),
    //                             1 = CONTACT_NOT_DETECTED (open).
    const C = this.platform.api.hap.Characteristic.ContactSensorState;
    return this.active ? C.CONTACT_NOT_DETECTED : C.CONTACT_DETECTED;
  }
}
