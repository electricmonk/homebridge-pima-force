import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';
import type { PimaForcePlatform } from './platform.js';

export interface ZoneBypassAccessoryContext {
  kind: 'zone-bypass';
  /** Panel zone number being bypassed. */
  zone: number;
  name: string;
  /**
   * Partition whose user code authorises writes for this zone. DATA is
   * privilege-filtered, so the wrong code simply can't see or set the zone.
   *
   * Deliberately stores the partition *id*, never the code itself —
   * `accessory.context` is serialised into Homebridge's accessory cache on
   * disk, and user PINs must not end up there. The code is fetched from the
   * live config at call time.
   */
  partition?: number;
  /** Minutes before an active bypass clears itself. 0 disables the timer. */
  autoClearMinutes: number;
}

/** Default safety net: a forgotten bypass clears itself after this long. */
export const DEFAULT_AUTO_CLEAR_MINUTES = 30;

/**
 * Switch accessory that bypasses a single zone (panel parameter 2150).
 *
 * **On = bypassed** (the zone will not alarm), matching the panel's own
 * encoding where `"1"` is bypass. Off = the zone is live.
 *
 * Bypass is the only per-zone suppression the panel offers, and the only
 * thing that quiets a **24-hour** zone. Smoke and flood zones keep the Armed
 * bit in parameter 2149 no matter what their partition is doing, so
 * disarming the partition they sit on does nothing for them — measured on a
 * live panel 2026-08-18.
 *
 * State is driven by the panel's CID 570 event, never by the frame ACK. The
 * panel acknowledges receipt of a write, not its effect; the same mistake on
 * the siren's output de-activate is what left that switch showing Off while
 * the siren was still sounding. The panel emits 570 for keypad bypasses too,
 * so this stays correct when the suppression didn't come from HomeKit.
 */
export class ZoneBypassSwitch {
  private readonly service: Service;
  private bypassed = false;
  private autoClearTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly platform: PimaForcePlatform,
    private readonly accessory: PlatformAccessory<ZoneBypassAccessoryContext>,
  ) {
    const { Characteristic, Service: HapService } = platform.api.hap;
    const { zone, name } = accessory.context;

    accessory
      .getService(HapService.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'Pima')
      .setCharacteristic(Characteristic.Model, 'FORCE Zone Bypass')
      .setCharacteristic(Characteristic.SerialNumber, `zone-bypass-${zone}`);

    this.service =
      accessory.getService(HapService.Switch) ??
      accessory.addService(HapService.Switch, name);
    this.service.setCharacteristic(Characteristic.Name, name);

    this.service
      .getCharacteristic(Characteristic.On)
      .onGet(() => this.bypassed)
      .onSet((v) => this.handleSet(v));
  }

  /** The zone this switch suppresses. */
  get zone(): number {
    return this.accessory.context.zone;
  }

  /**
   * Update from the panel's CID 570 event — the authoritative signal that a
   * bypass took effect, wherever it came from.
   */
  setBypassed(bypassed: boolean): void {
    if (this.bypassed !== bypassed) {
      this.bypassed = bypassed;
      this.service.updateCharacteristic(this.platform.api.hap.Characteristic.On, bypassed);
    }
    // (Re)arm or cancel the safety timer even when the value didn't change —
    // a repeated 570 for an already-bypassed zone should extend the window,
    // not leave a stale timer running.
    if (bypassed) this.armAutoClear();
    else this.cancelAutoClear();
  }

  /** Cancel any pending auto-clear. Called on shutdown. */
  dispose(): void {
    this.cancelAutoClear();
  }

  private armAutoClear(): void {
    this.cancelAutoClear();
    const minutes = this.accessory.context.autoClearMinutes;
    if (!minutes || minutes <= 0) return;
    const { zone, name } = this.accessory.context;
    this.autoClearTimer = setTimeout(() => {
      this.autoClearTimer = null;
      this.platform.log.info(`${name}: auto-clearing bypass on zone ${zone} after ${minutes} minute(s)`);
      void this.send(false).catch((err) => {
        // Loud: the zone is still suppressed and the user thinks it isn't.
        this.platform.log.error(
          `${name}: FAILED to auto-clear bypass on zone ${zone} — it is still bypassed and will not alarm: ${(err as Error).message}`,
        );
      });
    }, minutes * 60_000);
    // Don't keep the event loop alive just for this.
    this.autoClearTimer.unref?.();
  }

  private cancelAutoClear(): void {
    if (!this.autoClearTimer) return;
    clearTimeout(this.autoClearTimer);
    this.autoClearTimer = null;
  }

  private send(bypassed: boolean): Promise<void> {
    const { zone, partition } = this.accessory.context;
    return this.platform.driver.setZoneBypass(zone, bypassed, {
      password: this.platform.userCodeForPartition(partition),
    });
  }

  private async handleSet(value: CharacteristicValue): Promise<void> {
    const target = Boolean(value);
    const { zone, name } = this.accessory.context;

    try {
      await this.send(target);
      if (target) {
        this.platform.log.warn(
          `${name}: zone ${zone} BYPASS requested — it will not alarm until cleared`
          + `${this.accessory.context.autoClearMinutes > 0 ? ` (auto-clears in ${this.accessory.context.autoClearMinutes} min)` : ''}`,
        );
      } else {
        this.platform.log.info(`${name}: clearing bypass on zone ${zone}`);
      }
      // Deliberately not flipping `bypassed` here — the panel ACKs the frame,
      // not the effect. `setBypassed()` runs when CID 570 arrives. Re-assert
      // the current value so HomeKit doesn't sit on an unconfirmed one.
      setTimeout(() => {
        this.service.updateCharacteristic(this.platform.api.hap.Characteristic.On, this.bypassed);
      }, 50);
    } catch (err) {
      this.platform.log.error(`${name}: bypass ${target ? 'set' : 'clear'} failed on zone ${zone}: ${(err as Error).message}`);
      throw new this.platform.api.hap.HapStatusError(
        this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      );
    }
  }
}
