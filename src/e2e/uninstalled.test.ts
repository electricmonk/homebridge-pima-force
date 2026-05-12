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
import { consistently } from '../test-support/consistently.js';
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
    // 5s window covers discoverDevices() running and any retry cycles.
    await consistently(async () => {
      const bound = await new Promise<boolean>((resolve) => {
        const sock = net.createConnection({ host: '127.0.0.1', port: harness.alarmPort });
        sock.once('connect', () => { sock.destroy(); resolve(true); });
        sock.once('error', () => resolve(false));
      });
      assert.equal(bound, false,
        `alarm port became bound when no partitions are configured; logs:\n${harness.logs().split('\n').slice(-20).join('\n')}`,
      );
    }, { durationMs: 5_000, intervalMs: 50 });
  });

  it('no plugin accessories are registered', async () => {
    const list = await harness.homebridge.listAccessories();
    const pluginTypes = new Set(['SecuritySystem', 'ContactSensor', 'MotionSensor', 'LeakSensor', 'SmokeSensor', 'Switch']);
    const pluginAccessories = list.filter((a) => pluginTypes.has(a.type));
    assert.equal(pluginAccessories.length, 0,
      `expected no plugin accessories when unconfigured, got: ${pluginAccessories.map((a) => a.serviceName).join(', ')}`);
  });
});
