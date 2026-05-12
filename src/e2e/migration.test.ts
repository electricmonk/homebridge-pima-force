/**
 * Migration: a user upgrading from a pre-flat-zones plugin version had
 * their config laid out with zones nested under each partition. The new
 * plugin must (a) read that shape, (b) register accessories with stable
 * UUIDs derived from zone#/partition.id only (not from nesting), and
 * (c) preserve those accessories across a restart so existing HomeKit
 * automations don't break.
 */
import { strict as assert } from 'node:assert';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { type E2EHarness, setupE2E } from '../test-support/e2e-fixture.js';
import { eventually } from '../test-support/eventually.js';
import { aPartition, aPluginConfig, aZone } from '../test-support/plugin-config.js';

describe('E2E: legacy nested config migration', { timeout: 90_000 }, () => {
  const nestedZone = aZone({ type: 'contact' });
  const partition = aPartition({
    // Legacy schema: zones nested under the partition.
    zones: [nestedZone],
  });
  const sirenName = 'Legacy Siren';
  const legacyConfig = aPluginConfig({
    partitions: [partition],
    siren: { enabled: true, name: sirenName },
    zones: [],
  });
  const expectedAccessories = [partition.name, nestedZone.name, sirenName];

  let harness: E2EHarness;
  let storagePath: string;
  let firstBootUuids: Map<string, string>;

  before(async () => {
    // Boot 1: install with legacy nested config. Plugin migrates in-memory
    // and registers accessories with the new flat-shape UUID convention.
    harness = await setupE2E({ config: legacyConfig, keepStorage: true });
    storagePath = harness.storage;
    const list = await eventually(async () => {
      const accs = await harness.homebridge.listAccessories();
      const names = new Set(accs.map((a) => a.serviceName));
      for (const n of expectedAccessories) assert.ok(names.has(n), `accessory "${n}" not yet registered; saw ${[...names].join(', ')}`);
      return accs;
    }, { timeoutMs: 15_000 });
    firstBootUuids = new Map(list.map((a) => [a.serviceName, a.uniqueId]));
    await harness.stop();
  });

  after(async () => {
    rmSync(storagePath, { recursive: true, force: true });
  });

  it('migrates nested zones into accessories on first boot', async () => {
    for (const name of expectedAccessories) {
      assert.ok(firstBootUuids.has(name), `${name} accessory was not registered`);
    }
  });

  it('logs the migration at INFO with the count of hoisted zones', async () => {
    const log = readFileSync(join(storagePath, 'homebridge.log'), 'utf8');
    assert.match(
      log,
      /migrated 1 zone\(s\) from legacy nested partition\.zones/,
      `expected migration log line; got log:\n${log}`,
    );
  });

  it('preserves accessory uniqueIds across a restart with the same legacy config', async () => {
    // Boot 2: same storage, same legacy config. Cached accessories from
    // Boot 1 should be matched by UUID — no new registrations, no orphans.
    await using restarted = await setupE2E({
      storage: storagePath,
      config: legacyConfig,
      keepStorage: true,
    });
    const list = await eventually(async () => {
      const accs = await restarted.homebridge.listAccessories();
      const names = new Set(accs.map((a) => a.serviceName));
      for (const n of expectedAccessories) assert.ok(names.has(n));
      return accs;
    }, { timeoutMs: 15_000 });

    const second = new Map(list.map((a) => [a.serviceName, a.uniqueId]));
    for (const name of expectedAccessories) {
      assert.equal(second.get(name), firstBootUuids.get(name), `"${name}" uniqueId changed across restart`);
    }

    const log = readFileSync(join(storagePath, 'homebridge.log'), 'utf8');
    assert.doesNotMatch(
      log,
      /removing \d+ stale accessory/,
      `cached accessories were unexpectedly orphaned during restart; log:\n${log}`,
    );
  });
});
