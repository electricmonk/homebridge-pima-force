import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';
import type { PimaForcePlatform } from './platform.js';
import { OUTPUT_EXTERNAL_SIREN } from './protocol.js';

export interface SirenAccessoryContext {
  kind: 'siren';
  /** Output number on the panel (1 = external siren, 2 = internal). */
  output: number;
  name: string;
}

/**
 * Switch accessory representing the panel's external siren.
 *
 * - **On = siren currently sounding**. Off = silent.
 * - The user can only turn it OFF (mute) — turning it ON from HomeKit is
 *   rejected (the plugin won't sound the siren on demand). Turning OFF
 *   while sounding sends a de-activate-output OPERATION.
 * - State is driven by panel `type=770` output events. `qualifier=1` (zone
 *   field carries the output number) flips us to On; `qualifier=3` flips
 *   back to Off.
 */
export class SirenSwitch {
  private readonly service: Service;
  private active = false;

  constructor(
    private readonly platform: PimaForcePlatform,
    private readonly accessory: PlatformAccessory<SirenAccessoryContext>,
  ) {
    const { Characteristic, Service: HapService } = platform.api.hap;

    accessory
      .getService(HapService.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'Pima')
      .setCharacteristic(Characteristic.Model, 'FORCE Siren')
      .setCharacteristic(Characteristic.SerialNumber, `siren-${accessory.context.output}`);

    // Strip any pre-v0.2 Speaker service from a cached accessory so we don't
    // expose two services on the same tile after upgrading.
    const speaker = accessory.getService(HapService.Speaker);
    if (speaker) accessory.removeService(speaker);

    this.service =
      accessory.getService(HapService.Switch) ??
      accessory.addService(HapService.Switch, accessory.context.name);
    this.service.setCharacteristic(Characteristic.Name, accessory.context.name);

    this.service
      .getCharacteristic(Characteristic.On)
      .onGet(() => this.active)
      .onSet((v) => this.handleSet(v));
  }

  /** Update from a panel output event. `sounding` = siren is currently on. */
  setSounding(sounding: boolean): void {
    if (this.active === sounding) return;
    this.active = sounding;
    this.service.updateCharacteristic(this.platform.api.hap.Characteristic.On, sounding);
  }

  private async handleSet(value: CharacteristicValue): Promise<void> {
    const target = Boolean(value);
    if (target === this.active) return;

    if (target) {
      // User tried to turn the siren ON from HomeKit. The plugin won't
      // activate the external siren on demand — it sounds only in response
      // to alarm conditions on the panel. Snap the toggle back to OFF.
      this.platform.log.warn(
        `siren can only be muted from HomeKit; not activated. Output ${this.accessory.context.output} stays inactive.`,
      );
      // Schedule a deferred update so HomeKit accepts our SET first, then
      // sees the corrected value moments later.
      setTimeout(() => {
        this.service.updateCharacteristic(this.platform.api.hap.Characteristic.On, this.active);
      }, 50);
      return;
    }

    // User toggled OFF while the siren was sounding → mute it.
    try {
      await this.platform.driver.setOutput(this.accessory.context.output, false);
      // Optimistic flip; the panel will confirm via type=770 q=3 (which
      // calls setSounding(false) and is a no-op since we're already off).
      this.active = false;
      this.service.updateCharacteristic(this.platform.api.hap.Characteristic.On, false);
      this.platform.log.info(
        `requested mute of output ${this.accessory.context.output} (de-activate-output sent to panel)`,
      );
    } catch (err) {
      this.platform.log.error(`siren mute failed: ${(err as Error).message}`);
      throw new this.platform.api.hap.HapStatusError(
        this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      );
    }
  }
}

/** Re-exported for convenience: the canonical "external siren" output. */
export const EXTERNAL_SIREN_OUTPUT = OUTPUT_EXTERNAL_SIREN;
