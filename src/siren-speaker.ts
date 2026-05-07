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
 * Speaker accessory representing the panel's external siren. The Mute
 * characteristic mirrors siren state (Mute=true ⟺ silent) and lets the
 * user silence an active siren by toggling Mute on.
 *
 * Caveats:
 * - Toggling Mute=false (unmute) has no panel-side action — the siren only
 *   sounds in response to alarm conditions; this plugin won't activate it
 *   manually. We accept the toggle and snap state back to mirror reality.
 * - Detection of siren state relies on panel `type=770` output events. If
 *   the panel doesn't emit them for the external siren, the displayed
 *   state may lag reality; the mute action itself still works.
 */
export class SirenSpeaker {
  private readonly service: Service;
  private muted = true; // siren idle = effectively muted

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

    this.service =
      accessory.getService(HapService.Speaker) ??
      accessory.addService(HapService.Speaker, accessory.context.name);
    this.service.setCharacteristic(Characteristic.Name, accessory.context.name);

    this.service
      .getCharacteristic(Characteristic.Mute)
      .onGet(() => this.muted)
      .onSet((v) => this.handleSetMute(v));
  }

  /** Update from a panel output event. `sounding` true = siren is on. */
  setSounding(sounding: boolean): void {
    const muted = !sounding;
    if (this.muted === muted) return;
    this.muted = muted;
    this.service.updateCharacteristic(this.platform.api.hap.Characteristic.Mute, muted);
  }

  private async handleSetMute(value: CharacteristicValue): Promise<void> {
    const requestedMute = Boolean(value);
    if (requestedMute === this.muted) return;

    if (requestedMute) {
      try {
        await this.platform.driver.setOutput(this.accessory.context.output, false);
        this.muted = true;
        // Confirmation will arrive via type=770 q=3 → setSounding(false), but
        // mirror state immediately so HomeKit doesn't show an in-progress toggle.
        this.service.updateCharacteristic(this.platform.api.hap.Characteristic.Mute, true);
      } catch (err) {
        this.platform.log.error(`siren mute failed: ${(err as Error).message}`);
        throw new this.platform.api.hap.HapStatusError(
          this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
        );
      }
      return;
    }

    // Mute=false (unmute): the plugin won't sound the siren on demand. Snap
    // the toggle back so HomeKit reflects panel reality. Only `output 1` is
    // intended for the external siren — manual activation here would be a
    // safety footgun.
    if (this.accessory.context.output === OUTPUT_EXTERNAL_SIREN) {
      this.platform.log.warn(
        'Siren cannot be unmuted manually; it sounds only during an alarm condition.',
      );
      // Schedule the snap-back asynchronously so HomeKit accepts our SET
      // first, then sees the corrected value.
      setTimeout(() => {
        this.service.updateCharacteristic(this.platform.api.hap.Characteristic.Mute, true);
      }, 50);
      return;
    }

    // Other outputs (controlled outputs etc.) might legitimately be activated.
    try {
      await this.platform.driver.setOutput(this.accessory.context.output, true);
      this.muted = false;
    } catch (err) {
      this.platform.log.error(`output activate failed: ${(err as Error).message}`);
      throw new this.platform.api.hap.HapStatusError(
        this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      );
    }
  }
}
