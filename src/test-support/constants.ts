/**
 * Named constants for the spec values that tests assert on. Wire-side
 * constants are re-exported from `protocol.ts` (single source of truth).
 * HomeKit-side constants are listed here because they're a HAP detail the
 * production code reads via `Characteristic.SecuritySystem*State.*` and
 * doesn't need at module scope.
 *
 * Tests should reach for these by name (ARM_AWAY, ZONE_OPENED, AWAY_ARM)
 * rather than the underlying integer (12, 760-qualifier-1, 1).
 */
export {
  EVENT_TYPE_BURGLARY,
  EVENT_TYPE_COMM,
  EVENT_TYPE_LOCAL_ARM,
  EVENT_TYPE_OUTPUT,
  EVENT_TYPE_REMOTE_ARM,
  EVENT_TYPE_ZONE,
  OPTYPE_ACTIVATE_OUTPUT,
  OPTYPE_ARM_AWAY,
  OPTYPE_ARM_HOME1,
  OPTYPE_ARM_HOME2,
  OPTYPE_ARM_HOME3,
  OPTYPE_ARM_HOME4,
  OPTYPE_ARM_SHABBAT,
  OPTYPE_DEACTIVATE_OUTPUT,
  OPTYPE_DISARM,
  OUTPUT_EXTERNAL_SIREN,
  OUTPUT_INTERNAL_SIREN,
  PARAM_ID_NUMBER_OF_INSTALLED_ZONES,
  PARAM_ID_SYSTEM_KEY_STATUS,
  PARAM_ID_ZONE_NAMES,
  PARAM_ID_ZONE_STATUS,
  QUALIFIER_NEW,
  QUALIFIER_RESTORE,
} from '../protocol.js';

/**
 * Pima System Key Status values (id=2310, Appendix C).
 * Tests use these instead of bare digits inside DATA `parameters` strings.
 */
export const PARTITION_NOT_EXIST = 1;
export const PARTITION_DISARMED = 2;
export const PARTITION_FULL_ARMED = 3;
export const PARTITION_HOME1 = 4;
export const PARTITION_HOME2 = 5;
export const PARTITION_HOME3 = 6;
export const PARTITION_HOME4 = 7;
export const PARTITION_SHABBAT_ON = 8;
export const PARTITION_SHABBAT_OFF = 9;

/**
 * HomeKit `SecuritySystemTargetState` / `SecuritySystemCurrentState` enum
 * values. HAP types live in `@homebridge/hap-nodejs`, but as integers
 * they're stable parts of the public protocol — fine to mirror by name
 * for test readability.
 *
 * Note: SecuritySystem*TargetState* uses STAY/AWAY/NIGHT/DISARM only;
 * SecuritySystem*CurrentState* adds ALARM_TRIGGERED.
 */
export const STAY_ARM = 0;
export const AWAY_ARM = 1;
export const NIGHT_ARM = 2;
export const DISARMED = 3;
export const DISARM = DISARMED; // target alias
export const ALARM_TRIGGERED = 4;

/** HomeKit `ContactSensorState`. */
export const CONTACT_DETECTED = 0;
export const CONTACT_NOT_DETECTED = 1;
