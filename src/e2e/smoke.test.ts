/**
 * Smoke: every accessory the user configures should appear in the UI with
 * the right HAP service. Assertions derive their expected values from the
 * config object, not hardcoded literals.
 */
import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { type E2EHarness, setupE2E } from '../test-support/e2e-fixture.js';
import { eventually } from '../test-support/eventually.js';
import { aPluginConfig, type ZoneType } from '../test-support/plugin-config.js';

describe('E2E smoke: accessory registration', { timeout: 60_000 }, () => {
  const config = aPluginConfig();
  const expectedNames = [
    ...config.partitions.map((p) => p.name),
    ...(config.zones ?? []).map((z) => z.name),
    ...(config.siren?.enabled && config.siren.name ? [config.siren.name] : []),
  ];

  let harness: E2EHarness;
  before(async () => {
    harness = await setupE2E({ config });
    // Bridge accessory + plugin accessories take a moment to appear in the
    // UI's data layer after startup (HAP IPC bring-up).
    await eventually(async () => {
      const names = new Set((await harness.homebridge.listAccessories()).map((a) => a.serviceName));
      for (const n of expectedNames) {
        assert.ok(names.has(n), `accessory "${n}" not yet registered`);
      }
    }, { timeoutMs: 15_000 });
  });
  after(async () => { await harness?.stop(); });

  it('every configured accessory appears in the UI', async () => {
    const names = new Set((await harness.homebridge.listAccessories()).map((a) => a.serviceName));
    for (const expected of expectedNames) {
      assert.ok(names.has(expected), `expected accessory "${expected}" in ${[...names].join(', ')}`);
    }
  });

  it('each zone is registered with the HAP service for its type', async () => {
    const byName = new Map((await harness.homebridge.listAccessories()).map((a) => [a.serviceName, a]));
    const hapTypeFor: Record<ZoneType, string> = {
      contact: 'ContactSensor',
      motion: 'MotionSensor',
      leak: 'LeakSensor',
      smoke: 'SmokeSensor',
    };
    for (const z of config.zones ?? []) {
      assert.equal(byName.get(z.name)?.type, hapTypeFor[z.type], `zone "${z.name}" expected ${hapTypeFor[z.type]}`);
    }
  });

  it('partitions are exposed as SecuritySystem services', async () => {
    for (const p of config.partitions) {
      const acc = await harness.homebridge.findAccessory(p.name);
      assert.equal(acc.type, 'SecuritySystem');
    }
  });

  it('siren is exposed as a Switch service', async () => {
    if (!config.siren?.enabled || !config.siren.name) return;
    const acc = await harness.homebridge.findAccessory(config.siren.name);
    assert.equal(acc.type, 'Switch');
  });
});
