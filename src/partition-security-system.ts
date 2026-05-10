import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';
import type { PimaForcePlatform } from './platform.js';
import type { ArmMode, ArmModeToggles } from './types.js';

export interface PartitionAccessoryContext {
  kind: 'partition';
  id: number;
  name: string;
  /** Which HomeKit armed states to expose for this partition. */
  armModes?: ArmModeToggles;
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

  /** Set of HomeKit target states allowed for this partition. */
  private readonly allowedTargets: Set<number>;

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

    // Build the set of HomeKit target states this partition allows. DISARM
    // is always allowed; the three armed states are toggled per partition
    // via config (default: all enabled).
    const toggles = accessory.context.armModes ?? {};
    this.allowedTargets = new Set<number>([Characteristic.SecuritySystemTargetState.DISARM]);
    if (toggles.stay !== false)  this.allowedTargets.add(Characteristic.SecuritySystemTargetState.STAY_ARM);
    if (toggles.away !== false)  this.allowedTargets.add(Characteristic.SecuritySystemTargetState.AWAY_ARM);
    if (toggles.night !== false) this.allowedTargets.add(Characteristic.SecuritySystemTargetState.NIGHT_ARM);
    if (this.allowedTargets.size === 1) {
      // Only DISARM enabled — partition can't be armed from HomeKit.
      this.platform.log.warn(
        `partition ${accessory.context.id} (${accessory.context.name}): all armed modes disabled in config; only DISARM is available`,
      );
    }

    this.service
      .getCharacteristic(Characteristic.SecuritySystemTargetState)
      // Restrict the picker in the Home app to enabled modes; HAP will
      // also reject SET requests for values outside this list.
      .setProps({ validValues: [...this.allowedTargets].sort((a, b) => a - b) })
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

  /**
   * Apply the panel's reported arm state from a System Key Status response
   * (DATA frame id=2310) received on startup/reconnect. Maps Pima status
   * values to the closest HomeKit state.
   *
   * Status values (from PROTOCOL.md):
   *   1=NotExist  2=Disarmed  3=FullArmed  4=Home1  5=Home2
   *   6=Home3     7=Home4     8=Shabbat-ON  9=Shabbat-OFF
   */
  setStateFromStartupStatus(status: number): void {
    const C = this.platform.api.hap.Characteristic;
    switch (status) {
      case 3: // FullArmed → AWAY_ARM
        this.targetState = C.SecuritySystemTargetState.AWAY_ARM;
        this.currentState = C.SecuritySystemCurrentState.AWAY_ARM;
        this.lastArmedState = C.SecuritySystemTargetState.AWAY_ARM;
        this.alarmActive = false;
        break;
      case 4: // Home1 → STAY_ARM
        this.targetState = C.SecuritySystemTargetState.STAY_ARM;
        this.currentState = C.SecuritySystemCurrentState.STAY_ARM;
        this.lastArmedState = C.SecuritySystemTargetState.STAY_ARM;
        this.alarmActive = false;
        break;
      case 5: // Home2 → NIGHT_ARM
        this.targetState = C.SecuritySystemTargetState.NIGHT_ARM;
        this.currentState = C.SecuritySystemCurrentState.NIGHT_ARM;
        this.lastArmedState = C.SecuritySystemTargetState.NIGHT_ARM;
        this.alarmActive = false;
        break;
      case 6: // Home3 — no exact HomeKit equivalent; report as AWAY
      case 7: // Home4 — no exact HomeKit equivalent; report as AWAY
      case 8: // Shabbat-ON — treat as armed
        this.targetState = C.SecuritySystemTargetState.AWAY_ARM;
        this.currentState = C.SecuritySystemCurrentState.AWAY_ARM;
        this.lastArmedState = C.SecuritySystemTargetState.AWAY_ARM;
        this.alarmActive = false;
        break;
      default: // 1=NotExist, 2=Disarmed, 9=Shabbat-OFF
        this.targetState = C.SecuritySystemTargetState.DISARM;
        this.currentState = C.SecuritySystemCurrentState.DISARMED;
        this.lastArmedState = null;
        this.alarmActive = false;
        break;
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
    if (!this.allowedTargets.has(target)) {
      // Defense in depth — HAP's validValues should already prevent this.
      this.platform.log.warn(
        `partition ${this.accessory.context.id}: arm mode target=${target} is disabled in config`,
      );
      throw new this.platform.api.hap.HapStatusError(
        this.platform.api.hap.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE,
      );
    }
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
