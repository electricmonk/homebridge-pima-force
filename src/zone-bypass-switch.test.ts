/**
 * Auto-clear behaviour of the zone bypass switch, in isolation.
 *
 * A bypassed zone is a zone that will not alarm — for a smoke detector that
 * means a disabled smoke detector. The cooking case is inherently temporary,
 * so a forgotten bypass has to expire on its own. The e2e suite runs with
 * `autoClearMinutes: 0`; this is where the timer itself is pinned down.
 *
 * Uses node:test mock timers rather than real waits — the production default
 * is 30 minutes.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { DEFAULT_AUTO_CLEAR_MINUTES, ZoneBypassSwitch } from './zone-bypass-switch.js';

/** Minimal HAP/platform test doubles — just enough surface for the switch. */
function aPlatform(opts: { userCode?: string } = {}) {
  const calls: Array<{ zone: number; bypassed: boolean; password?: string }> = [];
  const updates: Array<boolean> = [];
  const logs: string[] = [];
  let failNext: Error | null = null;

  const Characteristic = { On: 'On', Name: 'Name', Manufacturer: 'M', Model: 'Mo', SerialNumber: 'S' };
  const service = {
    setCharacteristic() { return service; },
    getCharacteristic() {
      return {
        onGet() { return this; },
        onSet() { return this; },
      };
    },
    updateCharacteristic(_c: string, v: boolean) { updates.push(v); return service; },
  };
  const accessory = {
    context: { kind: 'zone-bypass' as const, zone: 13, name: 'Kitchen Smoke Bypass', partition: 3, autoClearMinutes: 30 },
    getService() { return service; },
    addService() { return service; },
  };
  const platform = {
    log: {
      info: (m: string) => logs.push(`info ${m}`),
      warn: (m: string) => logs.push(`warn ${m}`),
      error: (m: string) => logs.push(`error ${m}`),
      debug: (m: string) => logs.push(`debug ${m}`),
    },
    api: { hap: { Characteristic, Service: { Switch: 'Switch', AccessoryInformation: 'AI' }, HapStatusError: Error, HAPStatus: {} } },
    driver: {
      setZoneBypass(zone: number, bypassed: boolean, o: { password?: string } = {}) {
        calls.push({ zone, bypassed, password: o.password });
        if (failNext) { const e = failNext; failNext = null; return Promise.reject(e); }
        return Promise.resolve();
      },
    },
    userCodeForPartition: () => opts.userCode ?? '3333',
  };
  return {
    calls, updates, logs,
    failWith(e: Error) { failNext = e; },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    build: () => new ZoneBypassSwitch(platform as any, accessory as any),
    accessory,
  };
}

describe('ZoneBypassSwitch — auto-clear', () => {
  it('clears the bypass automatically once the window elapses', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const p = aPlatform();
    const sw = p.build();

    // CID 570 confirms the bypass — that's what arms the timer.
    sw.setBypassed(true);
    assert.equal(p.calls.length, 0, 'observing a bypass must not write anything back');

    t.mock.timers.tick(29 * 60_000);
    assert.equal(p.calls.length, 0, 'must not clear early');

    t.mock.timers.tick(2 * 60_000);
    assert.deepEqual(p.calls, [{ zone: 13, bypassed: false, password: '3333' }]);
  });

  it('cancels the timer when the bypass is cleared by someone else first', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const p = aPlatform();
    const sw = p.build();

    sw.setBypassed(true);
    sw.setBypassed(false); // cleared at the keypad
    t.mock.timers.tick(60 * 60_000);

    assert.equal(p.calls.length, 0, 'no auto-clear should fire after a manual clear');
  });

  it('extends the window when a repeat 570 arrives for an already-bypassed zone', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const p = aPlatform();
    const sw = p.build();

    sw.setBypassed(true);
    t.mock.timers.tick(20 * 60_000);
    sw.setBypassed(true); // panel re-reports; window restarts
    t.mock.timers.tick(20 * 60_000);
    assert.equal(p.calls.length, 0, 'the repeat should have restarted the 30-minute window');

    t.mock.timers.tick(11 * 60_000);
    assert.equal(p.calls.length, 1);
  });

  it('dispose() stops a pending auto-clear', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const p = aPlatform();
    const sw = p.build();

    sw.setBypassed(true);
    sw.dispose();
    t.mock.timers.tick(60 * 60_000);
    assert.equal(p.calls.length, 0);
  });

  it('logs loudly when the auto-clear fails — the zone is still suppressed', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const p = aPlatform();
    const sw = p.build();

    sw.setBypassed(true);
    p.failWith(new Error('panel NAK: nope'));
    t.mock.timers.tick(31 * 60_000);
    await Promise.resolve();
    await Promise.resolve();

    assert.ok(
      p.logs.some((l) => l.startsWith('error') && /still bypassed and will not alarm/.test(l)),
      `expected a loud failure log, got: ${p.logs.join(' | ')}`,
    );
  });

  it('never arms a timer when auto-clear is disabled', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const p = aPlatform();
    p.accessory.context.autoClearMinutes = 0;
    const sw = p.build();

    sw.setBypassed(true);
    t.mock.timers.tick(24 * 60 * 60_000);
    assert.equal(p.calls.length, 0);
  });

  it('defaults to a 30-minute window', () => {
    assert.equal(DEFAULT_AUTO_CLEAR_MINUTES, 30);
  });
});
