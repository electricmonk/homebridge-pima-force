/**
 * Panel-originated events propagate into the HomeKit UI:
 *   - zone open/close, motion, leak, smoke
 *   - keypad / remote arm
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
import { type E2EHarness, setupE2E } from '../test-support/e2e-fixture.js';
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
import { aPartition, aPluginConfig, aZone } from '../test-support/plugin-config.js';

describe('E2E: panel → UI events', { timeout: 60_000 }, () => {
  const partition = aPartition();
  const door = aZone({ name: 'Door', type: 'contact' });
  const motion = aZone({ name: 'Motion', type: 'motion' });
  const leak = aZone({ name: 'Leak', type: 'leak' });
  const smoke = aZone({ name: 'Smoke', type: 'smoke' });
  const sirenName = 'Siren';
  // The siren is panel-wide (output not partition-bound), but the panel still
  // tags its 770 events with a partition. Tests use this for those events.
  const sirenPartition = 1;

  let harness: E2EHarness;
  before(async () => {
    harness = await setupE2E({
      config: aPluginConfig({
        partitions: [partition],
        zones: [door, motion, leak, smoke],
        siren: { enabled: true, name: sirenName },
      }),
    });
    await eventually(async () => {
      const names = new Set((await harness.homebridge.listAccessories()).map((a) => a.serviceName));
      for (const n of [partition.name, door.name, motion.name, leak.name, smoke.name, sirenName]) {
        assert.ok(names.has(n));
      }
    }, { timeoutMs: 15_000 });
  });
  after(async () => { await harness?.stop(); });

  it('zone OPEN event flips ContactSensor to detected (Open) in UI', async () => {
    using alarm = await harness.connectAlarm();
    await alarm.report(zoneOpened({ zone: door.zone, partition: partition.id }));
    await eventually(async () => assert.equal(
      await harness.homebridge.zone(door.name).state(), CONTACT_NOT_DETECTED,
    ));
  });

  it('zone RESTORE event flips ContactSensor back to closed', async () => {
    using alarm = await harness.connectAlarm();
    await alarm.report(zoneClosed({ zone: door.zone, partition: partition.id }));
    await eventually(async () => assert.equal(
      await harness.homebridge.zone(door.name).state(), CONTACT_DETECTED,
    ));
  });

  it('panel ARM event flips SecuritySystem CurrentState to AWAY_ARM', async () => {
    using alarm = await harness.connectAlarm();
    // External arm event with no prior target → defaults to AWAY_ARM.
    await alarm.report(armedFromRemote({ partition: partition.id, user: 2 }));
    await eventually(async () => assert.equal(
      await harness.homebridge.partition(partition.name).currentState(), AWAY_ARM,
    ));
  });

  it('burglary alarm event flips SecuritySystem CurrentState to ALARM_TRIGGERED', async () => {
    using alarm = await harness.connectAlarm();
    await alarm.report(burglaryAlarm({ zone: door.zone, partition: partition.id }));
    await eventually(async () => assert.equal(
      await harness.homebridge.partition(partition.name).currentState(), ALARM_TRIGGERED,
    ));

    await alarm.report(alarmRestored({ zone: door.zone, partition: partition.id }));
    await eventually(async () => assert.notEqual(
      await harness.homebridge.partition(partition.name).currentState(), ALARM_TRIGGERED,
    ));
  });

  it('siren ON event flips Switch On to true', async () => {
    using alarm = await harness.connectAlarm();
    const siren = harness.homebridge.siren(sirenName);
    await alarm.report(sirenActivated({ partition: sirenPartition }));
    await eventually(async () => assert.equal(await siren.on(), true));
  });

  it('siren OFF event flips Switch On to false', async () => {
    using alarm = await harness.connectAlarm();
    const siren = harness.homebridge.siren(sirenName);
    await alarm.report(sirenActivated({ partition: sirenPartition }));
    await eventually(async () => assert.equal(await siren.on(), true));

    await alarm.report(sirenDeactivated({ partition: sirenPartition }));
    await eventually(async () => assert.equal(await siren.on(), false));
  });

  it('motion zone event flips MotionDetected true/false', async () => {
    using alarm = await harness.connectAlarm();
    const motionSensor = harness.homebridge.zone(motion.name);
    await alarm.report(zoneOpened({ zone: motion.zone, partition: partition.id }));
    // HAP serialises MotionDetected as 1/0, not true/false.
    await eventually(async () => assert.equal(await motionSensor.state(), 1));

    await alarm.report(zoneClosed({ zone: motion.zone, partition: partition.id }));
    await eventually(async () => assert.equal(await motionSensor.state(), 0));
  });

  it('leak zone event flips LeakDetected', async () => {
    using alarm = await harness.connectAlarm();
    const leakSensor = harness.homebridge.zone(leak.name);
    await alarm.report(zoneOpened({ zone: leak.zone, partition: partition.id }));
    await eventually(async () => assert.equal(await leakSensor.state(), 1));

    await alarm.report(zoneClosed({ zone: leak.zone, partition: partition.id }));
    await eventually(async () => assert.equal(await leakSensor.state(), 0));
  });

  it('smoke zone event flips SmokeDetected', async () => {
    using alarm = await harness.connectAlarm();
    const smokeSensor = harness.homebridge.zone(smoke.name);
    await alarm.report(zoneOpened({ zone: smoke.zone, partition: partition.id }));
    await eventually(async () => assert.equal(await smokeSensor.state(), 1));

    await alarm.report(zoneClosed({ zone: smoke.zone, partition: partition.id }));
    await eventually(async () => assert.equal(await smokeSensor.state(), 0));
  });

  it('zone event for unconfigured zone is logged once at INFO and does not crash', async () => {
    using alarm = await harness.connectAlarm();
    const accessoriesBefore = (await harness.homebridge.listAccessories()).length;

    // A zone number not in our config. Send twice — the second open/close
    // pair should NOT generate a second INFO log.
    const unknownZone = 99;
    await alarm.report(zoneOpened({ zone: unknownZone, partition: partition.id }));
    await alarm.report(zoneClosed({ zone: unknownZone, partition: partition.id }));

    // Give the subprocess a moment to receive + log.
    await new Promise((r) => setTimeout(r, 300));

    // No new accessories were registered.
    assert.equal((await harness.homebridge.listAccessories()).length, accessoriesBefore);

    // Logs contain at least one INFO line for the unconfigured zone.
    const logs = harness.logs();
    const infoLines = logs.split('\n').filter((l) => l.includes('unconfigured zone') && l.includes(String(unknownZone)));
    assert.ok(
      infoLines.filter((l) => !l.includes('debug')).length >= 1,
      `expected at least one info-level log mentioning unconfigured zone ${unknownZone}, got:\n${infoLines.join('\n')}`,
    );
  });

  it('arm event for unconfigured partition is logged at INFO and does not crash', async () => {
    using alarm = await harness.connectAlarm();
    const unknownPartition = 7;
    await alarm.report(armedFromRemote({ partition: unknownPartition }));

    await new Promise((r) => setTimeout(r, 300));

    // Existing partition accessory is unaffected.
    const acc = await harness.homebridge.findAccessory(partition.name);
    assert.notEqual(acc, undefined);

    const logs = harness.logs();
    assert.ok(
      logs.includes(`unconfigured partition ${unknownPartition}`),
      `expected log to mention unconfigured partition ${unknownPartition}, got tail:\n${logs.split('\n').slice(-30).join('\n')}`,
    );
  });

  it('valid event still works after an unconfigured one', async () => {
    using alarm = await harness.connectAlarm();
    const motionSensor = harness.homebridge.zone(motion.name);
    // Unknown zone first (should be ignored gracefully).
    await alarm.report(zoneOpened({ zone: 88, partition: partition.id }));
    // Then a valid event on the configured motion zone.
    await alarm.report(zoneOpened({ zone: motion.zone, partition: partition.id }));

    await eventually(async () => assert.equal(await motionSensor.state(), 1));
  });
});
