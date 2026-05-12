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
import { type E2EHarness, setupE2E } from '../test-support/e2e-fixture.js';
import { eventually } from '../test-support/eventually.js';
import {
  nakWithReason,
  partitionStatus,
  zoneCount,
  zoneNames,
} from '../test-support/frames.js';
import { aPartition, aPluginConfig } from '../test-support/plugin-config.js';

describe('E2E: zone auto-discovery on first connect', { timeout: 30_000 }, () => {
  const partition = aPartition();
  const discoveredZoneNames = ['Front Door', 'Living Room PIR', 'Kitchen Smoke'];

  let harness: E2EHarness;
  before(async () => {
    harness = await setupE2E({
      config: aPluginConfig({
        siren: { enabled: false },
        partitions: [partition],
        zones: [],  // No zones — the plugin should populate them from the panel.
      }),
    });
    // The partition accessory is wired up at didFinishLaunching, before the
    // panel ever connects. Zones aren't expected yet.
    await eventually(async () => {
      const names = new Set((await harness.homebridge.listAccessories()).map((a) => a.serviceName));
      assert.ok(names.has(partition.name));
    }, { timeoutMs: 15_000 });
  });
  after(async () => { await harness?.stop(); });

  it('queries the panel and registers each discovered zone as a HomeKit sensor', async () => {
    using alarm = await harness.connectAlarm({ verify: false });
    // Real panels emit a heartbeat immediately on connect; the plugin uses
    // the first incoming frame as its signal that the connection is real
    // (vs. a port-up probe) before kicking off discovery.
    await alarm.verify();

    // Drain the partition-state query that the platform issues before
    // anything else (the transport serializes DATA-REQs).
    const stateQ = await alarm.nextQuery({ id: PARAM_ID_SYSTEM_KEY_STATUS, startOrder: partition.id });
    alarm.respond(stateQ, partitionStatus({ status: PARTITION_DISARMED }));

    // 1) Plugin queries installed zone count.
    const countQ = await alarm.nextQuery({ id: PARAM_ID_NUMBER_OF_INSTALLED_ZONES });
    assert.equal(countQ.start_order, 1);
    alarm.respond(countQ, zoneCount({ count: discoveredZoneNames.length }));

    // 2) Plugin queries zone names — fits in one page.
    const namesQ = await alarm.nextQuery({ id: PARAM_ID_ZONE_NAMES, startOrder: 1 });
    alarm.respond(namesQ, zoneNames({ names: discoveredZoneNames }));

    // 3) Plugin should register each zone in-process — they appear in the
    //    UI without a Homebridge restart.
    await eventually(async () => {
      const names = new Set((await harness.homebridge.listAccessories()).map((a) => a.serviceName));
      for (const n of discoveredZoneNames) {
        assert.ok(names.has(n), `accessory "${n}" not yet registered`);
      }
    }, { timeoutMs: 15_000 });

    // 4) And persist them into config.json so a future restart still sees them.
    const configText = readFileSync(join(harness.storage, 'config.json'), 'utf8');
    const cfg = JSON.parse(configText) as { platforms: Array<Record<string, unknown>> };
    const myEntry = cfg.platforms.find((p) => p.platform === 'PimaForce') as
      | { zones?: Array<{ zone: number; name: string; type: string }> }
      | undefined;
    assert.ok(myEntry, 'PimaForce platform entry missing from config.json');
    const persisted = myEntry!.zones ?? [];
    assert.equal(persisted.length, discoveredZoneNames.length);
    discoveredZoneNames.forEach((expectedName, i) => {
      assert.equal(persisted[i].zone, i + 1);
      assert.equal(persisted[i].name, expectedName);
      assert.equal(persisted[i].type, 'contact', 'discovered zones default to contact');
    });
  });
});

describe('E2E: zone auto-discovery — paginated zone names', { timeout: 30_000 }, () => {
  const partition = aPartition();
  const firstPageNames = ['Front Door', 'Living Room PIR', 'Kitchen Smoke'];
  const secondPageNames = ['Garage Motion'];
  const allNames = [...firstPageNames, ...secondPageNames];

  let harness: E2EHarness;
  before(async () => {
    harness = await setupE2E({
      config: aPluginConfig({
        siren: { enabled: false },
        partitions: [partition],
        zones: [],
      }),
    });
    await eventually(async () => {
      const names = new Set((await harness.homebridge.listAccessories()).map((a) => a.serviceName));
      assert.ok(names.has(partition.name));
    }, { timeoutMs: 15_000 });
  });
  after(async () => { await harness?.stop(); });

  it('aggregates zone names split across multiple DATA frames (more: yes)', async () => {
    using alarm = await harness.connectAlarm();
    const stateQ = await alarm.nextQuery({ id: PARAM_ID_SYSTEM_KEY_STATUS, startOrder: partition.id });
    alarm.respond(stateQ, partitionStatus({ status: PARTITION_DISARMED }));

    const countQ = await alarm.nextQuery({ id: PARAM_ID_NUMBER_OF_INSTALLED_ZONES });
    alarm.respond(countQ, zoneCount({ count: allNames.length }));

    // First page: panel says more is coming.
    const page1 = await alarm.nextQuery({ id: PARAM_ID_ZONE_NAMES, startOrder: 1 });
    alarm.respond(page1, zoneNames({ names: firstPageNames, more: true }));

    // Second page: no more.
    const page2 = await alarm.nextQuery({ id: PARAM_ID_ZONE_NAMES, startOrder: firstPageNames.length + 1 });
    alarm.respond(page2, zoneNames({ names: secondPageNames }));

    await eventually(async () => {
      const names = new Set((await harness.homebridge.listAccessories()).map((a) => a.serviceName));
      for (const n of allNames) {
        assert.ok(names.has(n), `accessory "${n}" not yet registered`);
      }
    }, { timeoutMs: 15_000 });

    const configText = readFileSync(join(harness.storage, 'config.json'), 'utf8');
    const cfg = JSON.parse(configText) as { platforms: Array<Record<string, unknown>> };
    const myEntry = cfg.platforms.find((p) => p.platform === 'PimaForce') as
      | { zones?: Array<{ zone: number; name: string; type: string }> }
      | undefined;
    assert.ok(myEntry, 'PimaForce platform entry missing from config.json');
    const persisted = myEntry!.zones ?? [];
    assert.equal(persisted.length, allNames.length);
    allNames.forEach((expectedName, i) => {
      assert.equal(persisted[i].zone, i + 1);
      assert.equal(persisted[i].name, expectedName);
    });
  });
});

describe('E2E: zone auto-discovery — NAK counter correlation', { timeout: 30_000 }, () => {
  const partition = aPartition();
  const discoveredZoneNames = ['Porch Sensor', 'Back Door'];

  let harness: E2EHarness;
  before(async () => {
    harness = await setupE2E({
      config: aPluginConfig({
        siren: { enabled: false },
        partitions: [partition],
        zones: [],
      }),
    });
    await eventually(async () => {
      const names = new Set((await harness.homebridge.listAccessories()).map((a) => a.serviceName));
      assert.ok(names.has(partition.name));
    }, { timeoutMs: 15_000 });
  });
  after(async () => { await harness?.stop(); });

  it('ignores an unrelated NAK (different counter) during discovery', async () => {
    using alarm = await harness.connectAlarm();
    const stateQ = await alarm.nextQuery({ id: PARAM_ID_SYSTEM_KEY_STATUS, startOrder: partition.id });
    alarm.respond(stateQ, partitionStatus({ status: PARTITION_DISARMED }));

    const countQ = await alarm.nextQuery({ id: PARAM_ID_NUMBER_OF_INSTALLED_ZONES });

    // Simulate the panel NAKing some *other* command with a different counter.
    // The plugin's discovery loop should ignore it and keep waiting on its
    // own DATA-REQ.
    alarm.sendRaw({
      frame_type: 'NAK',
      counter: Number(countQ.counter) + 99,
      account: String(harness.account),
      data: nakWithReason('invalid password').data,
    });

    // Discovery should still proceed — respond with the real zone count DATA.
    alarm.respond(countQ, zoneCount({ count: discoveredZoneNames.length }));

    const namesQ = await alarm.nextQuery({ id: PARAM_ID_ZONE_NAMES });
    alarm.respond(namesQ, zoneNames({ names: discoveredZoneNames }));

    await eventually(async () => {
      const names = new Set((await harness.homebridge.listAccessories()).map((a) => a.serviceName));
      for (const n of discoveredZoneNames) {
        assert.ok(names.has(n), `accessory "${n}" not yet registered`);
      }
    }, { timeoutMs: 15_000 });
  });
});
