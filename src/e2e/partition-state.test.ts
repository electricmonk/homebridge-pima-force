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
import {
  type E2EFixture,
  connectAlarmSystem,
  homeBridgeFor,
  setupE2E,
} from '../test-support/e2e-fixture.js';
import { eventually } from '../test-support/eventually.js';
import {
  disarmedFromRemote,
  partitionStatus,
} from '../test-support/frames.js';

describe('E2E: partition state on connect (default fixture, partition 2)', { timeout: 60_000 }, () => {
  let fix: E2EFixture;
  before(async () => {
    fix = await setupE2E();
    const hb = homeBridgeFor(fix);
    await eventually(async () => {
      const names = new Set((await hb.listAccessories()).map((a) => a.serviceName));
      assert.ok(names.has('E2E Partition'));
    }, { timeoutMs: 15_000 });
  });
  after(async () => { await fix?.stop(); });

  it('on panel connect, queries partition state via DATA-REQ and reflects arm status', async () => {
    using alarm = await connectAlarmSystem(fix);
    const hb = homeBridgeFor(fix);
    // Respond to the startup partition-state query: partition 2 = FullArmed
    // (HomeKit AWAY_ARM).
    const stateQ = await alarm.nextQuery({ id: PARAM_ID_SYSTEM_KEY_STATUS, startOrder: 2 });
    alarm.respond(stateQ, partitionStatus({ status: PARTITION_FULL_ARMED }));

    await eventually(async () => assert.equal(
      await hb.partition('E2E Partition').currentState(), AWAY_ARM,
    ));

    // Reset to disarmed so this test doesn't affect later tests. A stray DATA
    // frame won't work — the transport claims every DATA via in-flight
    // matching — so use the panel-side disarm event path (CID 407 q=1)
    // instead, which the driver dispatches as a `disarm` event.
    await alarm.report(disarmedFromRemote({ partition: 2 }));
    await eventually(async () => assert.equal(
      await hb.partition('E2E Partition').currentState(), DISARMED,
    ));
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
  const threePartitionConfig = {
    name: 'Pima Serialization',
    siren: { enabled: false },
    partitions: [
      { id: 1, name: 'Part One',   userCode: '1111' },
      { id: 2, name: 'Part Two',   userCode: '2222' },
      { id: 3, name: 'Part Three', userCode: '3333' },
    ],
    zones: [{ zone: 1, name: 'Serialization Zone', type: 'contact' }],
  };

  let fix: E2EFixture;
  before(async () => {
    fix = await setupE2E({ pimaPlatformOverride: threePartitionConfig });
    const hb = homeBridgeFor(fix);
    await eventually(async () => {
      const names = new Set((await hb.listAccessories()).map((a) => a.serviceName));
      for (const n of ['Part One', 'Part Two', 'Part Three']) assert.ok(names.has(n));
    }, { timeoutMs: 15_000 });
  });
  after(async () => { await fix?.stop(); });

  it('issues 2310 DATA-REQs one at a time and updates every partition', async () => {
    using alarm = await connectAlarmSystem(fix);
    const hb = homeBridgeFor(fix);
    // Pima system-key status → HomeKit current state:
    //   3=FullArmed→AWAY_ARM(1), 4=Home1→STAY_ARM(0), 5=Home2→NIGHT_ARM(2).
    const expected = [
      { partition: 1, accessoryName: 'Part One',   pimaStatus: 3, homekitState: 1 },
      { partition: 2, accessoryName: 'Part Two',   pimaStatus: 4, homekitState: 0 },
      { partition: 3, accessoryName: 'Part Three', pimaStatus: 5, homekitState: 2 },
    ];

    for (const { partition, pimaStatus } of expected) {
      const q = await alarm.nextQuery({ id: PARAM_ID_SYSTEM_KEY_STATUS, startOrder: partition });
      alarm.respond(q, partitionStatus({ status: pimaStatus }));
    }

    for (const { accessoryName, homekitState } of expected) {
      await eventually(async () => assert.equal(
        await hb.partition(accessoryName).currentState(),
        homekitState,
      ));
    }
  });
});
