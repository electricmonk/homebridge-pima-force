/**
 * Panel-originated events propagate into the HomeKit UI:
 *   - zone open/close, motion, leak, smoke
 *   - keypad / remote arm + disarm
 *   - burglary alarm trigger + restore
 *   - siren output activate + deactivate
 *   - unconfigured ids logged once at INFO, valid events still work after
 */
import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import {
  ALARM_TRIGGERED,
  AWAY_ARM,
  CONTACT_DETECTED,
  CONTACT_NOT_DETECTED,
} from '../test-support/constants.js';
import {
  type E2EFixture,
  connectAlarmSystem,
  homeBridgeFor,
  setupE2E,
} from '../test-support/e2e-fixture.js';
import { eventually } from '../test-support/eventually.js';
import {
  alarmRestored,
  armedFromRemote,
  burglaryAlarm,
  sirenActivated,
  sirenDeactivated,
  zoneClosed,
  zoneOpened,
} from '../test-support/frames.js';

describe('E2E: panel → UI events', { timeout: 60_000 }, () => {
  let fix: E2EFixture;
  before(async () => {
    fix = await setupE2E();
    const hb = homeBridgeFor(fix);
    await eventually(async () => {
      const names = new Set((await hb.listAccessories()).map((a) => a.serviceName));
      for (const n of ['E2E Partition', 'E2E Motion', 'E2E Door', 'E2E Leak', 'E2E Smoke', 'E2E Siren', 'E2E Restricted']) {
        assert.ok(names.has(n));
      }
    }, { timeoutMs: 15_000 });
  });
  after(async () => { await fix?.stop(); });

  it('zone OPEN event flips ContactSensor to detected (Open) in UI', async () => {
    using alarm = await connectAlarmSystem(fix);
    const hb = homeBridgeFor(fix);
    await alarm.report(zoneOpened({ zone: 4, partition: 2 }));
    await eventually(async () => assert.equal(
      await hb.zone('E2E Door').state(), CONTACT_NOT_DETECTED,
    ));
  });

  it('zone RESTORE event flips ContactSensor back to closed', async () => {
    using alarm = await connectAlarmSystem(fix);
    const hb = homeBridgeFor(fix);
    await alarm.report(zoneClosed({ zone: 4, partition: 2 }));
    await eventually(async () => assert.equal(
      await hb.zone('E2E Door').state(), CONTACT_DETECTED,
    ));
  });

  it('panel ARM event flips SecuritySystem CurrentState to AWAY_ARM', async () => {
    using alarm = await connectAlarmSystem(fix);
    const hb = homeBridgeFor(fix);
    // External arm event with no prior target → defaults to AWAY_ARM.
    await alarm.report(armedFromRemote({ partition: 2, user: 2 }));
    await eventually(async () => assert.equal(
      await hb.partition('E2E Partition').currentState(), AWAY_ARM,
    ));
  });

  it('burglary alarm event flips SecuritySystem CurrentState to ALARM_TRIGGERED', async () => {
    using alarm = await connectAlarmSystem(fix);
    const hb = homeBridgeFor(fix);
    await alarm.report(burglaryAlarm({ zone: 4, partition: 2 }));
    await eventually(async () => assert.equal(
      await hb.partition('E2E Partition').currentState(), ALARM_TRIGGERED,
    ));

    await alarm.report(alarmRestored({ zone: 4, partition: 2 }));
    await eventually(async () => assert.notEqual(
      await hb.partition('E2E Partition').currentState(), ALARM_TRIGGERED,
    ));
  });

  it('siren ON event flips Switch On to true', async () => {
    using alarm = await connectAlarmSystem(fix);
    const siren = homeBridgeFor(fix).siren('E2E Siren');
    await alarm.report(sirenActivated({ partition: 1 }));
    await eventually(async () => assert.equal(await siren.on(), true));
  });

  it('siren OFF event flips Switch On to false', async () => {
    using alarm = await connectAlarmSystem(fix);
    const siren = homeBridgeFor(fix).siren('E2E Siren');
    await alarm.report(sirenActivated({ partition: 1 }));
    await eventually(async () => assert.equal(await siren.on(), true));

    await alarm.report(sirenDeactivated({ partition: 1 }));
    await eventually(async () => assert.equal(await siren.on(), false));
  });

  it('motion zone event flips MotionDetected true/false', async () => {
    using alarm = await connectAlarmSystem(fix);
    const motion = homeBridgeFor(fix).zone('E2E Motion');
    await alarm.report(zoneOpened({ zone: 3, partition: 2 }));
    // HAP serialises MotionDetected as 1/0, not true/false.
    await eventually(async () => assert.equal(await motion.state(), 1));

    await alarm.report(zoneClosed({ zone: 3, partition: 2 }));
    await eventually(async () => assert.equal(await motion.state(), 0));
  });

  it('leak zone event flips LeakDetected', async () => {
    using alarm = await connectAlarmSystem(fix);
    const leak = homeBridgeFor(fix).zone('E2E Leak');
    await alarm.report(zoneOpened({ zone: 5, partition: 2 }));
    await eventually(async () => assert.equal(await leak.state(), 1));

    await alarm.report(zoneClosed({ zone: 5, partition: 2 }));
    await eventually(async () => assert.equal(await leak.state(), 0));
  });

  it('smoke zone event flips SmokeDetected', async () => {
    using alarm = await connectAlarmSystem(fix);
    const smoke = homeBridgeFor(fix).zone('E2E Smoke');
    await alarm.report(zoneOpened({ zone: 6, partition: 2 }));
    await eventually(async () => assert.equal(await smoke.state(), 1));

    await alarm.report(zoneClosed({ zone: 6, partition: 2 }));
    await eventually(async () => assert.equal(await smoke.state(), 0));
  });

  it('zone event for unconfigured zone is logged once at INFO and does not crash', async () => {
    using alarm = await connectAlarmSystem(fix);
    const hb = homeBridgeFor(fix);
    const accessoriesBefore = (await hb.listAccessories()).length;

    // Zone 99 is not in our config. Send twice — the second open/close pair
    // should NOT generate a second INFO log.
    await alarm.report(zoneOpened({ zone: 99, partition: 2 }));
    await alarm.report(zoneClosed({ zone: 99, partition: 2 }));

    // Give the subprocess a moment to receive + log.
    await new Promise((r) => setTimeout(r, 300));

    // No new accessories were registered.
    assert.equal((await hb.listAccessories()).length, accessoriesBefore);

    // Logs contain at least one INFO line for unconfigured zone 99.
    const logs = fix.logs();
    const infoLines = logs.split('\n').filter((l) => l.includes('unconfigured zone') && l.includes('99'));
    assert.ok(
      infoLines.filter((l) => !l.includes('debug')).length >= 1,
      `expected at least one info-level log mentioning unconfigured zone 99, got:\n${infoLines.join('\n')}`,
    );
  });

  it('arm event for unconfigured partition is logged at INFO and does not crash', async () => {
    using alarm = await connectAlarmSystem(fix);
    const hb = homeBridgeFor(fix);
    // Partition 7 is not in our config.
    await alarm.report(armedFromRemote({ partition: 7 }));

    await new Promise((r) => setTimeout(r, 300));

    // Existing partition 2 accessory is unaffected.
    const acc = await hb.findAccessory('E2E Partition');
    assert.notEqual(acc, undefined);

    const logs = fix.logs();
    assert.ok(
      logs.includes('unconfigured partition 7'),
      `expected log to mention unconfigured partition 7, got tail:\n${logs.split('\n').slice(-30).join('\n')}`,
    );
  });

  it('valid event still works after an unconfigured one', async () => {
    using alarm = await connectAlarmSystem(fix);
    const motion = homeBridgeFor(fix).zone('E2E Motion');
    // Unknown zone first (should be ignored gracefully).
    await alarm.report(zoneOpened({ zone: 88, partition: 2 }));
    // Then a valid event on configured zone 3 (motion sensor).
    await alarm.report(zoneOpened({ zone: 3, partition: 2 }));

    await eventually(async () => assert.equal(await motion.state(), 1));
  });
});
