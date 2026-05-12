/**
 * Smoke: every accessory the user configures should appear in the UI with
 * the right HAP service.
 */
import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { eventually } from '../test-support/eventually.js';
import {
  type E2EFixture,
  homeBridgeFor,
  setupE2E,
} from '../test-support/e2e-fixture.js';

describe('E2E smoke: accessory registration', { timeout: 60_000 }, () => {
  let fix: E2EFixture;
  before(async () => {
    fix = await setupE2E();
    // Bridge accessory + plugin accessories take a moment to appear in the
    // UI's data layer after startup (HAP IPC bring-up).
    const hb = homeBridgeFor(fix);
    await eventually(async () => {
      const names = new Set((await hb.listAccessories()).map((a) => a.serviceName));
      for (const n of ['E2E Partition', 'E2E Motion', 'E2E Door', 'E2E Leak', 'E2E Smoke', 'E2E Siren', 'E2E Restricted']) {
        assert.ok(names.has(n), `accessory "${n}" not yet registered`);
      }
    }, { timeoutMs: 15_000 });
  });
  after(async () => { await fix?.stop(); });

  it('all configured accessories appear in the UI', async () => {
    const names = new Set((await homeBridgeFor(fix).listAccessories()).map((a) => a.serviceName));
    for (const expected of ['E2E Partition', 'E2E Motion', 'E2E Door', 'E2E Leak', 'E2E Smoke', 'E2E Siren']) {
      assert.ok(names.has(expected), `expected accessory "${expected}" in ${[...names].join(', ')}`);
    }
  });

  it('zone types map to the right HAP service per the dropdown', async () => {
    const byName = new Map((await homeBridgeFor(fix).listAccessories()).map((a) => [a.serviceName, a]));
    assert.equal(byName.get('E2E Door')?.type, 'ContactSensor');
    assert.equal(byName.get('E2E Motion')?.type, 'MotionSensor');
    assert.equal(byName.get('E2E Leak')?.type, 'LeakSensor');
    assert.equal(byName.get('E2E Smoke')?.type, 'SmokeSensor');
  });

  it('partition is exposed as a SecuritySystem service', async () => {
    const acc = await homeBridgeFor(fix).findAccessory('E2E Partition');
    assert.equal(acc.type, 'SecuritySystem');
  });

  it('siren is exposed as a Switch service', async () => {
    const acc = await homeBridgeFor(fix).findAccessory('E2E Siren');
    assert.equal(acc.type, 'Switch');
  });
});
