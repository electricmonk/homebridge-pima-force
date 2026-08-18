/**
 * Zone bypass (panel parameter 2150) exposed as a per-zone Switch.
 *
 * Bypass is the only per-zone suppression the panel offers, and the only
 * thing that quiets a 24-hour zone: smoke and flood zones keep the Armed bit
 * in 2149 regardless of their partition's arm state, so disarming the
 * partition they sit on does nothing for them. Measured on a live panel
 * 2026-08-18 — partition 3 disarmed while zones 12/13 stayed at 0x0400.
 *
 * Two rules this suite pins down, both learned the hard way today:
 *   - the panel's CID 570 is the confirmation, never the frame ACK
 *   - the switch must not flip optimistically, or it goes dead the same way
 *     the siren toggle did during the 2026-08-17 incident
 */
import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { OPTYPE_DISARM, PARAM_ID_BYPASSED_ZONES } from '../test-support/constants.js';
import { consistently } from '../test-support/consistently.js';
import { type E2EHarness, setupE2E } from '../test-support/e2e-fixture.js';
import { eventually } from '../test-support/eventually.js';
import { zoneBypassCleared, zoneBypassed } from '../test-support/frames.js';
import { aPartition, aPluginConfig, aZone } from '../test-support/plugin-config.js';

const partition = aPartition({ id: 3, name: 'Ground Floor Smoke', userCode: '3333' });
const kitchenSmoke = aZone({
  zone: 13,
  name: 'Kitchen Smoke',
  type: 'smoke',
  partition: 3,
  bypass: { enabled: true, autoClearMinutes: 0 },
});
// A zone with no bypass configured — must not gain a switch.
const livingRoomSmoke = aZone({ zone: 12, name: 'Living Room Smoke', type: 'smoke', partition: 3 });

const BYPASS_SWITCH = 'Kitchen Smoke Bypass';

describe('E2E: per-zone bypass switch', { timeout: 60_000 }, () => {
  let harness: E2EHarness;

  /** HAP serialises StatusActive as 1/0 over the UI API, not true/false. */
  const statusActive = async (zoneName: string): Promise<number> => {
    const acc = await harness.homebridge.findAccessory(zoneName);
    return Number(acc.values.StatusActive);
  };

  before(async () => {
    harness = await setupE2E({
      config: aPluginConfig({
        partitions: [partition],
        zones: [kitchenSmoke, livingRoomSmoke],
        siren: { enabled: false },
      }),
    });
    await eventually(async () => {
      const names = new Set((await harness.homebridge.listAccessories()).map((a) => a.serviceName));
      assert.ok(names.has(BYPASS_SWITCH), `expected a bypass switch; saw ${[...names].join(', ')}`);
    }, { timeoutMs: 15_000 });
  });
  after(async () => { await harness?.stop(); });

  it('exposes a bypass switch only for zones that opted in', async () => {
    const names = new Set((await harness.homebridge.listAccessories()).map((a) => a.serviceName));
    assert.ok(names.has(BYPASS_SWITCH));
    assert.ok(names.has(kitchenSmoke.name), 'the sensor itself is still exposed');
    assert.ok(!names.has(`${livingRoomSmoke.name} Bypass`), 'zone 12 did not opt in');
  });

  it('turning the switch ON writes "1" to parameter 2150 for that zone, with the owning partition\'s code', async () => {
    using alarm = await harness.connectAlarm();
    const bypass = harness.homebridge.siren(BYPASS_SWITCH); // same Switch/On shape

    await bypass.setOn(true);

    const write = await alarm.nextDataWrite({ id: PARAM_ID_BYPASSED_ZONES, startOrder: kitchenSmoke.zone });
    assert.deepEqual(write.parameters, ['1']);
    assert.equal(write.password, partition.userCode, 'authorised with the owning partition\'s code');
  });

  it('does not flip the switch until the panel confirms with CID 570', async () => {
    using alarm = await harness.connectAlarm();
    const bypass = harness.homebridge.siren(BYPASS_SWITCH);

    // Panel ACKs the write (autoAck) but sends no 570 — the bypass has not
    // been confirmed, so the switch must stay Off and remain tappable.
    await bypass.setOn(true);
    await alarm.nextDataWrite({ id: PARAM_ID_BYPASSED_ZONES, startOrder: kitchenSmoke.zone });
    await consistently(async () => assert.equal(await bypass.on(), false), {
      durationMs: 600,
      intervalMs: 50,
      message: 'switch must not report bypassed before CID 570 arrives',
    });

    // 570 q=1 — now it flips.
    await alarm.report(zoneBypassed({ zone: kitchenSmoke.zone, partition: partition.id }));
    await eventually(async () => assert.equal(await bypass.on(), true));

    // And the sensor reports itself inactive while suppressed. HAP
    // serialises StatusActive as 1/0 over the UI API, not true/false.
    await eventually(async () => assert.equal(
      await statusActive(kitchenSmoke.name), 0, 'bypassed detector must not look healthy',
    ));

    await alarm.report(zoneBypassCleared({ zone: kitchenSmoke.zone, partition: partition.id }));
    await eventually(async () => assert.equal(await bypass.on(), false));
    await eventually(async () => assert.equal(await statusActive(kitchenSmoke.name), 1));
  });

  it('tracks a bypass applied at the keypad, which arrives as the same 570', async () => {
    using alarm = await harness.connectAlarm();
    const bypass = harness.homebridge.siren(BYPASS_SWITCH);
    const writesBefore = alarm.dataWrites.length;

    await alarm.report(zoneBypassed({ zone: kitchenSmoke.zone, partition: partition.id }));
    await eventually(async () => assert.equal(await bypass.on(), true));
    assert.equal(alarm.dataWrites.length, writesBefore, 'we should not echo a write back at the panel');

    await alarm.report(zoneBypassCleared({ zone: kitchenSmoke.zone, partition: partition.id }));
    await eventually(async () => assert.equal(await bypass.on(), false));
  });

  it('turning the switch OFF writes "0"', async () => {
    using alarm = await harness.connectAlarm();
    const bypass = harness.homebridge.siren(BYPASS_SWITCH);

    await alarm.report(zoneBypassed({ zone: kitchenSmoke.zone, partition: partition.id }));
    await eventually(async () => assert.equal(await bypass.on(), true));

    await bypass.setOn(false);
    await eventually(() => {
      const clear = alarm.dataWrites.filter(
        (w) => Number(w.start_order) === kitchenSmoke.zone && w.parameters[0] === '0',
      );
      assert.ok(clear.length >= 1, `expected a clear write; saw ${JSON.stringify(alarm.dataWrites)}`);
    });
  });
});

/**
 * A partition can exist purely to authorise operations on its zones. For a
 * smoke-only partition whose zones are 24-hour, the security-system tile is
 * actively misleading — arming or disarming it changes nothing — so it
 * should be possible to keep the credential and drop the tile.
 */
describe('E2E: partition as credential only (exposeAccessory=false)', { timeout: 60_000 }, () => {
  const hidden = aPartition({ id: 3, name: 'Smoke Credential', userCode: '3333', exposeAccessory: false });
  const zone = aZone({
    zone: 13,
    name: 'Cred Kitchen Smoke',
    type: 'smoke',
    partition: 3,
    bypass: { enabled: true, autoClearMinutes: 0 },
  });

  let harness: E2EHarness;
  before(async () => {
    harness = await setupE2E({
      config: aPluginConfig({ partitions: [hidden], zones: [zone], siren: { enabled: false } }),
    });
    await eventually(async () => {
      const names = new Set((await harness.homebridge.listAccessories()).map((a) => a.serviceName));
      assert.ok(names.has('Cred Kitchen Smoke Bypass'));
    }, { timeoutMs: 15_000 });
  });
  after(async () => { await harness?.stop(); });

  it('registers no security-system tile but still authorises bypass with that partition\'s code', async () => {
    const names = new Set((await harness.homebridge.listAccessories()).map((a) => a.serviceName));
    assert.ok(!names.has(hidden.name), 'partition must not appear in HomeKit');

    using alarm = await harness.connectAlarm();
    await harness.homebridge.siren('Cred Kitchen Smoke Bypass').setOn(true);
    const write = await alarm.nextDataWrite({ id: PARAM_ID_BYPASSED_ZONES, startOrder: zone.zone });
    assert.equal(write.password, hidden.userCode);
  });

  it('still drives the panel connection — the partition is configured, just not exposed', async () => {
    using alarm = await harness.connectAlarm();
    // The driver only starts when at least one partition is configured, so a
    // reachable panel proves the credential-only partition still counts.
    assert.ok(alarm);
    await consistently(() => {
      const disarms = alarm.operations.filter((o) => Number(o.optype) === OPTYPE_DISARM);
      assert.equal(disarms.length, 0, 'nothing should be arming or disarming on its own');
    }, { durationMs: 300 });
  });
});
