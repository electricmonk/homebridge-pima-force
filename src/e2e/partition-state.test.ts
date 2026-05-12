/**
 * The platform queries System Key Status (param 2310) for every
 * configured partition on each panel connect, and reflects the result
 * in HomeKit. The driver serialises wire commands, so the queries are
 * issued one at a time — a regression we ship-tested in v0.1.15.
 */
import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import {
  AWAY_ARM,
  DISARMED,
  PARAM_ID_SYSTEM_KEY_STATUS,
  PARTITION_FULL_ARMED,
} from '../test-support/constants.js';
import { type E2EHarness, setupE2E } from '../test-support/e2e-fixture.js';
import { eventually } from '../test-support/eventually.js';
import {
  disarmedFromRemote,
  partitionStatus,
} from '../test-support/frames.js';
import { aPartition, aPluginConfig } from '../test-support/plugin-config.js';

describe('E2E: partition state on connect (single partition)', { timeout: 60_000 }, () => {
  const partition = aPartition();

  let harness: E2EHarness;
  before(async () => {
    harness = await setupE2E({
      config: aPluginConfig({ partitions: [partition], zones: [] }),
    });
    await eventually(async () => {
      const names = new Set((await harness.homebridge.listAccessories()).map((a) => a.serviceName));
      assert.ok(names.has(partition.name));
    }, { timeoutMs: 15_000 });
  });
  after(async () => { await harness?.stop(); });

  it('on panel connect, queries partition state via DATA-REQ and reflects arm status', async () => {
    using alarm = await harness.connectAlarm();
    const inHomeKit = harness.homebridge.partition(partition.name);
    // Respond to the startup partition-state query: FullArmed → AWAY_ARM.
    const stateQ = await alarm.nextQuery({ id: PARAM_ID_SYSTEM_KEY_STATUS, startOrder: partition.id });
    alarm.respond(stateQ, partitionStatus({ status: PARTITION_FULL_ARMED }));

    await eventually(async () => assert.equal(await inHomeKit.currentState(), AWAY_ARM));

    // Reset to disarmed so this test doesn't affect later tests. A stray DATA
    // frame won't work — the transport claims every DATA via in-flight
    // matching — so use the panel-side disarm event path (CID 407 q=1)
    // instead, which the driver dispatches as a `disarm` event.
    await alarm.report(disarmedFromRemote({ partition: partition.id }));
    await eventually(async () => assert.equal(await inHomeKit.currentState(), DISARMED));
  });
});

/**
 * Regression: with multiple partitions configured, the platform must query
 * each partition's state one-at-a-time. The real panel only accepts a
 * single DATA-REQ in flight at once and NAKs/drops the rest. v0.1.15
 * fanned out 3 concurrent DATA-REQs and only partition 1's state ever
 * arrived.
 */
describe('E2E: partition state query serialisation (3 partitions)', { timeout: 30_000 }, () => {
  // Pima system-key status → HomeKit current state:
  //   3=FullArmed→AWAY_ARM(1), 4=Home1→STAY_ARM(0), 5=Home2→NIGHT_ARM(2).
  const partition1 = aPartition({ userCode: '1111' });
  const partition2 = aPartition({ userCode: '2222' });
  const partition3 = aPartition({ userCode: '3333' });
  const cases = [
    { partition: partition1, pimaStatus: 3, homekitState: 1 },
    { partition: partition2, pimaStatus: 4, homekitState: 0 },
    { partition: partition3, pimaStatus: 5, homekitState: 2 },
  ];

  let harness: E2EHarness;
  before(async () => {
    harness = await setupE2E({
      config: aPluginConfig({
        partitions: [partition1, partition2, partition3],
        siren: { enabled: false },
        zones: [],
      }),
    });
    await eventually(async () => {
      const names = new Set((await harness.homebridge.listAccessories()).map((a) => a.serviceName));
      for (const { partition } of cases) assert.ok(names.has(partition.name));
    }, { timeoutMs: 15_000 });
  });
  after(async () => { await harness?.stop(); });

  it('issues 2310 DATA-REQs one at a time and updates every partition', async () => {
    using alarm = await harness.connectAlarm();

    for (const { partition, pimaStatus } of cases) {
      const q = await alarm.nextQuery({ id: PARAM_ID_SYSTEM_KEY_STATUS, startOrder: partition.id });
      alarm.respond(q, partitionStatus({ status: pimaStatus }));
    }

    for (const { partition, homekitState } of cases) {
      await eventually(async () => assert.equal(
        await harness.homebridge.partition(partition.name).currentState(),
        homekitState,
      ));
    }
  });
});
