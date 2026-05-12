/**
 * Freshly installed plugin: `partitions: []` in config means the user
 * hasn't finished onboarding. The plugin must:
 *   - NOT start the TCP driver (no point listening for a panel that has
 *     no partitions to control)
 *   - register no HomeKit accessories
 *
 * Regression: an early version started the driver eagerly on every load.
 */
import { strict as assert } from 'node:assert';
import net from 'node:net';
import { after, before, describe, it } from 'node:test';
import { type E2EHarness, setupE2E } from '../test-support/e2e-fixture.js';
import { aPluginConfig } from '../test-support/plugin-config.js';

describe('E2E: freshly installed plugin with no partitions configured', { timeout: 60_000 }, () => {
  let harness: E2EHarness;
  before(async () => {
    harness = await setupE2E({
      config: aPluginConfig({
        name: 'Pima Force Unconfigured',
        partitions: [],
        zones: [],
      }),
      expectAlarmPort: false,
    });
  });
  after(async () => { await harness?.stop(); });

  it('driver does not start — alarm port remains unbound', async () => {
    // This is a "must NOT happen for a duration" assertion — the inverse
    // of `eventually()`, which polls until success. Here we poll until
    // failure or until the window closes; success means the predicate
    // never failed during the window. The setTimeout below is the poll
    // interval, not a "wait then check" sleep.
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const bound = await new Promise<boolean>((resolve) => {
        const sock = net.createConnection({ host: '127.0.0.1', port: harness.alarmPort });
        sock.once('connect', () => { sock.destroy(); resolve(true); });
        sock.once('error', () => resolve(false));
      });
      if (bound) {
        assert.fail(
          `alarm port became bound when no partitions are configured; logs:\n${harness.logs().split('\n').slice(-20).join('\n')}`,
        );
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  });

  it('no plugin accessories are registered', async () => {
    const list = await harness.homebridge.listAccessories();
    const pluginTypes = new Set(['SecuritySystem', 'ContactSensor', 'MotionSensor', 'LeakSensor', 'SmokeSensor', 'Switch']);
    const pluginAccessories = list.filter((a) => pluginTypes.has(a.type));
    assert.equal(pluginAccessories.length, 0,
      `expected no plugin accessories when unconfigured, got: ${pluginAccessories.map((a) => a.serviceName).join(', ')}`);
  });
});
