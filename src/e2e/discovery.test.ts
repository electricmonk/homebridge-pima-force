/**
 * Zone auto-discovery on first connect: the plugin queries the panel
 * (id 2148 + 260), appends the discovered zones to config.json, and
 * registers them as HomeKit accessories without requiring a restart.
 *
 * Three describe blocks because each variant ships its own fixture
 * (different platform config) — pagination and unrelated-NAK behaviours
 * each need a clean homebridge subprocess.
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
  PARAM_ID_NUMBER_OF_INSTALLED_ZONES,
  PARAM_ID_SYSTEM_KEY_STATUS,
  PARAM_ID_ZONE_NAMES,
  PARTITION_DISARMED,
} from '../test-support/constants.js';
import {
  type E2EFixture,
  connectAlarmSystem,
  homeBridgeFor,
  setupE2E,
} from '../test-support/e2e-fixture.js';
import { eventually } from '../test-support/eventually.js';
import {
  nakWithReason,
  partitionStatus,
  zoneCount,
  zoneNames,
} from '../test-support/frames.js';

describe('E2E: zone auto-discovery on first connect', { timeout: 30_000 }, () => {
  const partitionOnlyConfig = {
    name: 'Pima Discovery',
    siren: { enabled: false },
    partitions: [
      { id: 1, name: 'Discovery Partition', userCode: '0000' },
    ],
    // Note: no zones — the plugin should populate them from the panel.
  };

  let fix: E2EFixture;
  before(async () => {
    fix = await setupE2E({ pimaPlatformOverride: partitionOnlyConfig });
    // The partition accessory is wired up at didFinishLaunching, before the
    // panel ever connects. Zones aren't expected yet.
    const hb = homeBridgeFor(fix);
    await eventually(async () => {
      const names = new Set((await hb.listAccessories()).map((a) => a.serviceName));
      assert.ok(names.has('Discovery Partition'));
    }, { timeoutMs: 15_000 });
  });
  after(async () => { await fix?.stop(); });

  it('queries the panel and registers each discovered zone as a HomeKit sensor', async () => {
    using alarm = await connectAlarmSystem(fix, { verify: false });
    const hb = homeBridgeFor(fix);
    // Real panels emit a heartbeat immediately on connect; the plugin uses
    // the first incoming frame as its signal that the connection is real
    // (vs. a port-up probe) before kicking off discovery.
    await alarm.verify();

    // Drain the partition-state query that the platform issues before
    // anything else (the transport serializes DATA-REQs).
    const stateQuery = await alarm.nextQuery({ id: PARAM_ID_SYSTEM_KEY_STATUS, startOrder: 1 });
    alarm.respond(stateQuery, partitionStatus({ status: PARTITION_DISARMED }));

    // 1) Plugin queries installed zone count.
    const countQ = await alarm.nextQuery({ id: PARAM_ID_NUMBER_OF_INSTALLED_ZONES });
    assert.equal(countQ.start_order, 1);
    alarm.respond(countQ, zoneCount({ count: 3 }));

    // 2) Plugin queries zone names — 3 zones fits in one page.
    const namesQ = await alarm.nextQuery({ id: PARAM_ID_ZONE_NAMES, startOrder: 1 });
    alarm.respond(namesQ, zoneNames({ names: ['Front Door', 'Living Room PIR', 'Kitchen Smoke'] }));

    // 3) Plugin should register each zone in-process — they appear in the
    //    UI without a Homebridge restart.
    await eventually(async () => {
      const accs = await hb.listAccessories();
      const names = new Set(accs.map((a) => a.serviceName));
      for (const n of ['Front Door', 'Living Room PIR', 'Kitchen Smoke']) {
        assert.ok(names.has(n), `accessory "${n}" not yet registered`);
      }
    }, { timeoutMs: 15_000 });

    // 4) And persist them into config.json so a future restart still sees them.
    const configText = readFileSync(join(fix.storage, 'config.json'), 'utf8');
    const cfg = JSON.parse(configText) as { platforms: Array<Record<string, unknown>> };
    const myEntry = cfg.platforms.find((p) => p.platform === 'PimaForce') as
      | { zones?: Array<{ zone: number; name: string; type: string }> }
      | undefined;
    assert.ok(myEntry, 'PimaForce platform entry missing from config.json');
    const zones = myEntry!.zones ?? [];
    assert.equal(zones.length, 3);
    const byZone = new Map(zones.map((z) => [z.zone, z]));
    assert.equal(byZone.get(1)?.name, 'Front Door');
    assert.equal(byZone.get(2)?.name, 'Living Room PIR');
    assert.equal(byZone.get(3)?.name, 'Kitchen Smoke');
    for (const z of zones) {
      assert.equal(z.type, 'contact', `zone ${z.zone} should default to contact; got ${z.type}`);
    }
  });
});

describe('E2E: zone auto-discovery — paginated zone names', { timeout: 30_000 }, () => {
  const partitionOnlyConfig = {
    name: 'Pima Discovery Paginated',
    siren: { enabled: false },
    partitions: [
      { id: 1, name: 'Discovery Partition', userCode: '0000' },
    ],
  };

  let fix: E2EFixture;
  before(async () => {
    fix = await setupE2E({ pimaPlatformOverride: partitionOnlyConfig });
    const hb = homeBridgeFor(fix);
    await eventually(async () => {
      const names = new Set((await hb.listAccessories()).map((a) => a.serviceName));
      assert.ok(names.has('Discovery Partition'));
    }, { timeoutMs: 15_000 });
  });
  after(async () => { await fix?.stop(); });

  it('aggregates zone names split across multiple DATA frames (more: yes)', async () => {
    using alarm = await connectAlarmSystem(fix);
    const hb = homeBridgeFor(fix);
    const stateQ = await alarm.nextQuery({ id: PARAM_ID_SYSTEM_KEY_STATUS, startOrder: 1 });
    alarm.respond(stateQ, partitionStatus({ status: PARTITION_DISARMED }));

    const countQ = await alarm.nextQuery({ id: PARAM_ID_NUMBER_OF_INSTALLED_ZONES });
    alarm.respond(countQ, zoneCount({ count: 4 }));

    // First page: zones 1–3, panel says more is coming.
    const page1 = await alarm.nextQuery({ id: PARAM_ID_ZONE_NAMES, startOrder: 1 });
    alarm.respond(page1, zoneNames({
      names: ['Front Door', 'Living Room PIR', 'Kitchen Smoke'],
      more: true,
    }));

    // Second page: zone 4 only, no more.
    const page2 = await alarm.nextQuery({ id: PARAM_ID_ZONE_NAMES, startOrder: 4 });
    alarm.respond(page2, zoneNames({ names: ['Garage Motion'] }));

    await eventually(async () => {
      const names = new Set((await hb.listAccessories()).map((a) => a.serviceName));
      for (const n of ['Front Door', 'Living Room PIR', 'Kitchen Smoke', 'Garage Motion']) {
        assert.ok(names.has(n), `accessory "${n}" not yet registered`);
      }
    }, { timeoutMs: 15_000 });

    const configText = readFileSync(join(fix.storage, 'config.json'), 'utf8');
    const cfg = JSON.parse(configText) as { platforms: Array<Record<string, unknown>> };
    const myEntry = cfg.platforms.find((p) => p.platform === 'PimaForce') as
      | { zones?: Array<{ zone: number; name: string; type: string }> }
      | undefined;
    assert.ok(myEntry, 'PimaForce platform entry missing from config.json');
    const zones = myEntry!.zones ?? [];
    const byZone = new Map(zones.map((z) => [z.zone, z]));
    assert.equal(zones.length, 4);
    assert.equal(byZone.get(1)?.name, 'Front Door');
    assert.equal(byZone.get(2)?.name, 'Living Room PIR');
    assert.equal(byZone.get(3)?.name, 'Kitchen Smoke');
    assert.equal(byZone.get(4)?.name, 'Garage Motion');
  });
});

describe('E2E: zone auto-discovery — NAK counter correlation', { timeout: 30_000 }, () => {
  const partitionOnlyConfig = {
    name: 'Pima Discovery NAK',
    siren: { enabled: false },
    partitions: [
      { id: 1, name: 'Discovery Partition', userCode: '0000' },
    ],
  };

  let fix: E2EFixture;
  before(async () => {
    fix = await setupE2E({ pimaPlatformOverride: partitionOnlyConfig });
    const hb = homeBridgeFor(fix);
    await eventually(async () => {
      const names = new Set((await hb.listAccessories()).map((a) => a.serviceName));
      assert.ok(names.has('Discovery Partition'));
    }, { timeoutMs: 15_000 });
  });
  after(async () => { await fix?.stop(); });

  it('ignores an unrelated NAK (different counter) during discovery', async () => {
    using alarm = await connectAlarmSystem(fix);
    const hb = homeBridgeFor(fix);
    const stateQ = await alarm.nextQuery({ id: PARAM_ID_SYSTEM_KEY_STATUS, startOrder: 1 });
    alarm.respond(stateQ, partitionStatus({ status: PARTITION_DISARMED }));

    const countQ = await alarm.nextQuery({ id: PARAM_ID_NUMBER_OF_INSTALLED_ZONES });

    // Simulate the panel NAKing some *other* command with a different counter.
    // The plugin's discovery loop should ignore it and keep waiting on its
    // own DATA-REQ.
    alarm.sendRaw({
      frame_type: 'NAK',
      counter: Number(countQ.counter) + 99,
      account: String(fix.account),
      data: nakWithReason('invalid password').data,
    });

    // Discovery should still proceed — respond with the real zone count DATA.
    alarm.respond(countQ, zoneCount({ count: 2 }));

    const namesQ = await alarm.nextQuery({ id: PARAM_ID_ZONE_NAMES });
    alarm.respond(namesQ, zoneNames({ names: ['Porch Sensor', 'Back Door'] }));

    await eventually(async () => {
      const names = new Set((await hb.listAccessories()).map((a) => a.serviceName));
      for (const n of ['Porch Sensor', 'Back Door']) {
        assert.ok(names.has(n), `accessory "${n}" not yet registered`);
      }
    }, { timeoutMs: 15_000 });
  });
});
