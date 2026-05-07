import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';
import type { PimaForcePlatform } from './platform.js';
import type { ArmMode } from './types.js';

export interface PartitionAccessoryContext {
  kind: 'partition';
  id: number;
  name: string;
}

/**
 * SecuritySystem accessory for a partition. Maps HomeKit's three armed
 * target states to specific Pima arm modes:
 *   AWAY_ARM  → Full Arm   (optype 12)
 *   STAY_ARM  → Home1 Arm  (optype 13)
 *   NIGHT_ARM → Home2 Arm  (optype 14)
 *   DISARM    → Disarm     (optype 17)
 *
 * Tracks alarm-triggered state separately. When a burglary alarm fires
 * (panel event type=130 q=1), the platform calls `setAlarmTriggered()`
 * and HomeKit's CurrentState becomes ALARM_TRIGGERED. On alarm restore
 * we revert to whatever armed state the system is in.
 */
export class PartitionSecuritySystem {
  private readonly service: Service;
  // We track our HomeKit state locally. HomeKit's enums for SecuritySystem
  // happen to align between Target and Current for STAY/AWAY/NIGHT/DISARMED
  // (0/1/2/3); ALARM_TRIGGERED (4) only exists on Current.
  private targetState = 3;  // DISARM
  private currentState = 3; // DISARMED
  /** Last non-alarm armed state, restored when an alarm clears. */
  private lastArmedState: number | null = null;
  private alarmActive = false;

  /** HomeKit target → Pima arm mode. Hardcoded for v1. */
  private static readonly TARGET_TO_MODE: Record<number, ArmMode> = {
    0: 'home1', // STAY_ARM
    1: 'away',  // AWAY_ARM
    2: 'home2', // NIGHT_ARM
  };

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
      accessory.getService(HapService.SecuritySystem) ??
      accessory.addService(HapService.SecuritySystem, accessory.context.name);
    this.service.setCharacteristic(Characteristic.Name, accessory.context.name);

    this.targetState = Characteristic.SecuritySystemTargetState.DISARM;
    this.currentState = Characteristic.SecuritySystemCurrentState.DISARMED;

    this.service
      .getCharacteristic(Characteristic.SecuritySystemTargetState)
      .onGet(() => this.targetState)
      .onSet((v) => this.handleSetTarget(v));

    this.service
      .getCharacteristic(Characteristic.SecuritySystemCurrentState)
      .onGet(() => this.currentState);
  }

  /**
   * Reflect a state change that originated outside HomeKit (panel/keypad
   * /C4). We don't know which arm mode the user picked at the keypad —
   * default to AWAY when armed.
   */
  setArmedFromPanel(armed: boolean): void {
    const C = this.platform.api.hap.Characteristic;
    if (armed) {
      // If we sent the arm command ourselves, our `targetState` is already
      // correct; mirror it. Otherwise fall back to AWAY.
      const target = (this.targetState !== C.SecuritySystemTargetState.DISARM)
        ? this.targetState
        : C.SecuritySystemTargetState.AWAY_ARM;
      this.targetState = target;
      this.lastArmedState = target;
      if (!this.alarmActive) {
        this.currentState = target;
      }
    } else {
      this.targetState = C.SecuritySystemTargetState.DISARM;
      this.lastArmedState = null;
      if (!this.alarmActive) {
        this.currentState = C.SecuritySystemCurrentState.DISARMED;
      }
    }
    this.pushState();
  }

  setAlarmTriggered(triggered: boolean): void {
    const C = this.platform.api.hap.Characteristic;
    this.alarmActive = triggered;
    if (triggered) {
      this.currentState = C.SecuritySystemCurrentState.ALARM_TRIGGERED;
    } else {
      // Restore the armed-or-disarmed state we held before the alarm fired.
      this.currentState = this.lastArmedState ?? C.SecuritySystemCurrentState.DISARMED;
    }
    this.pushState();
  }

  private pushState(): void {
    const C = this.platform.api.hap.Characteristic;
    this.service.updateCharacteristic(C.SecuritySystemCurrentState, this.currentState);
    this.service.updateCharacteristic(C.SecuritySystemTargetState, this.targetState);
  }

  private async handleSetTarget(value: CharacteristicValue): Promise<void> {
    const C = this.platform.api.hap.Characteristic;
    const target = Number(value);
    if (target === this.targetState) return;
    try {
      if (target === C.SecuritySystemTargetState.DISARM) {
        await this.platform.driver.disarm(this.accessory.context.id);
      } else {
        const mode = PartitionSecuritySystem.TARGET_TO_MODE[target];
        if (!mode) throw new Error(`unsupported HomeKit target state: ${target}`);
        await this.platform.driver.arm(this.accessory.context.id, mode);
      }
      this.targetState = target;
      // Optimistic CurrentState update — the panel will confirm via its arm/disarm event.
      this.currentState = (target === C.SecuritySystemTargetState.DISARM)
        ? C.SecuritySystemCurrentState.DISARMED
        : target;
      if (target !== C.SecuritySystemTargetState.DISARM) this.lastArmedState = target;
      this.service.updateCharacteristic(C.SecuritySystemCurrentState, this.currentState);
    } catch (err) {
      this.platform.log.error(
        `partition ${this.accessory.context.id} target=${target} failed: ${(err as Error).message}`,
      );
      throw new this.platform.api.hap.HapStatusError(
        this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      );
    }
  }
}
