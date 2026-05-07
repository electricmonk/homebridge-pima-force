import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';
import type { PimaForcePlatform } from './platform.js';

export interface PartitionAccessoryContext {
  kind: 'partition';
  id: number;
  name: string;
}

/**
 * Switch accessory for a partition. ON = armed, OFF = disarmed.
 *
 * State source of truth: this class's `armed` field, which is updated
 * either by HomeKit user action (-> driver.arm/disarm) or by inbound
 * panel events forwarded from the platform via `setArmedFromPanel`.
 */
export class PartitionSwitch {
  private readonly service: Service;
  private armed = false;

  constructor(
    private readonly platform: PimaForcePlatform,
    private readonly accessory: PlatformAccessory<PartitionAccessoryContext>,
  ) {
    const { Characteristic, Service: HapService } = platform.api.hap;
    accessory
      .getService(HapService.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'Pima')
      .setCharacteristic(Characteristic.Model, 'FORCE Partition')
      .setCharacteristic(Characteristic.SerialNumber, `partition-${accessory.context.id}`);

    this.service =
      accessory.getService(HapService.Switch) ??
      accessory.addService(HapService.Switch, accessory.context.name);
    this.service.setCharacteristic(Characteristic.Name, accessory.context.name);

    this.service
      .getCharacteristic(Characteristic.On)
      .onGet(() => this.armed)
      .onSet((v) => this.handleSet(v));
  }

  /** Reflect a state change that originated outside HomeKit (panel/keypad/C4). */
  setArmedFromPanel(armed: boolean): void {
    if (this.armed === armed) return;
    this.armed = armed;
    this.service.updateCharacteristic(this.platform.api.hap.Characteristic.On, armed);
  }

  private async handleSet(value: CharacteristicValue): Promise<void> {
    const target = Boolean(value);
    if (target === this.armed) return;
    try {
      if (target) {
        await this.platform.driver.arm(this.accessory.context.id);
      } else {
        await this.platform.driver.disarm(this.accessory.context.id);
      }
      // The panel will emit a confirming arm/disarm event; we mirror state
      // optimistically here so HomeKit reflects the toggle immediately.
      this.armed = target;
    } catch (err) {
      this.platform.log.error(
        `partition ${this.accessory.context.id} ${target ? 'arm' : 'disarm'} failed: ${(err as Error).message}`,
      );
      // Throwing here surfaces to HomeKit as a "device unreachable" state and
      // the toggle in the Home app will revert.
      throw new this.platform.api.hap.HapStatusError(
        this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      );
    }
  }
}
