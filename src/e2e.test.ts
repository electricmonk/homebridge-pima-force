/**
 * Full-stack E2E test: Pima panel TCP socket → driver → platform → HAP →
 * Homebridge UI REST API, and back (UI characteristic write → driver
 * OPERATION at the fake alarm).
 *
 * Boots a real Homebridge + homebridge-config-ui-x in a child process
 * with an isolated temp storage dir, dials in a fake alarm TCP client,
 * and asserts state propagation in both directions via the UI's REST API
 * (the same API the web UI uses).
 *
 * The plugin discovery requires the self-symlink `node_modules/homebridge-pima-force`
 * created by the `hb:dev:link` script. Run `npm run hb:dev:link` once before
 * running these tests if it doesn't exist.
 */

import { strict as assert } from 'node:assert';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { anAlarmSystem, type AlarmSystem } from './test-support/alarm-system.js';
import { eventually } from './test-support/eventually.js';
import {
  ALARM_TRIGGERED,
  AWAY_ARM,
  CONTACT_DETECTED,
  CONTACT_NOT_DETECTED,
  DISARMED,
  NIGHT_ARM,
  OPTYPE_ACTIVATE_OUTPUT,
  OPTYPE_ARM_AWAY,
  OPTYPE_ARM_HOME1,
  OPTYPE_ARM_HOME2,
  OPTYPE_DEACTIVATE_OUTPUT,
  OPTYPE_DISARM,
  PARAM_ID_NUMBER_OF_INSTALLED_ZONES,
  PARAM_ID_SYSTEM_KEY_STATUS,
  PARAM_ID_ZONE_NAMES,
  PARTITION_DISARMED,
  PARTITION_FULL_ARMED,
  STAY_ARM,
} from './test-support/constants.js';
import {
  alarmRestored,
  armedFromRemote,
  burglaryAlarm,
  disarmedFromRemote,
  nakWithReason,
  partitionStatus,
  sirenActivated,
  sirenDeactivated,
  zoneClosed,
  zoneCount,
  zoneNames,
  zoneOpened,
} from './test-support/frames.js';
import { homeBridge, type HomeBridge } from './test-support/homebridge.js';

const ROOT = process.cwd();
const HB_SERVICE_BIN = join(ROOT, 'node_modules/homebridge-config-ui-x/dist/bin/hb-service.js');
const STARTUP_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 50;

/**
 * Open an `alarmSystem` connection to the fixture's alarm port and, by
 * default, complete the verification handshake.
 */
async function connectAlarmSystem(
  fix: E2EFixture,
  opts: { verify?: boolean } = {},
): Promise<AlarmSystem> {
  const alarm = anAlarmSystem({ port: fix.alarmPort, account: fix.account });
  await alarm.connect();
  if (opts.verify !== false) await alarm.verify();
  return alarm;
}

/** Build a `homeBridge` driver from the e2e fixture's UI port and auth token. */
function homeBridgeFor(fix: E2EFixture): HomeBridge {
  return homeBridge({ baseUrl: `http://127.0.0.1:${fix.uiPort}`, token: fix.token });
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function waitForPort(port: number, host = '127.0.0.1', timeoutMs = STARTUP_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((resolve) => {
      const sock = net.createConnection({ host, port });
      sock.once('connect', () => { sock.destroy(); resolve(true); });
      sock.once('error', () => resolve(false));
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`timeout waiting for ${host}:${port}`);
}

async function httpJson<T = unknown>(method: string, url: string, body?: unknown, token?: string): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${method} ${url} → ${res.status} ${res.statusText}: ${text}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

interface AuthResponse { access_token: string }

interface AccessoryService {
  uniqueId: string;
  serviceName: string;
  type: string;
  serviceCharacteristics: Array<{ type: string; value: unknown }>;
}

interface E2EFixture {
  uiPort: number;
  alarmPort: number;
  account: number;
  storage: string;
  token: string;
  api<T = unknown>(method: string, path: string, body?: unknown): Promise<T>;
  /** Snapshot of all stdout+stderr written by the homebridge subprocess. */
  logs(): string;
  stop(): Promise<void>;
}

interface SetupOpts {
  /** Pre-existing storage dir (used for restart scenarios). When omitted, a fresh dir is created. */
  storage?: string;
  /** Override for the PimaForce platform entry in config.json. Used to test legacy schemas. */
  pimaPlatformOverride?: Record<string, unknown>;
  /** When true, stop() preserves the storage dir on teardown (caller must clean up). */
  keepStorage?: boolean;
}

async function setupE2E(opts: SetupOpts = {}): Promise<E2EFixture> {
  const uiPort = await getFreePort();
  const bridgePort = await getFreePort();
  const alarmPort = await getFreePort();
  const account = 1234;
  const reusingStorage = !!opts.storage;
  const storage = opts.storage ?? mkdtempSync(join(tmpdir(), 'hbpima-e2e-'));

  // When reusing storage, read the bridge block from the existing config.json
  // so the HAP cache (keyed by bridge username) lines up across boots. We
  // only refresh the listener ports, which the HAP cache doesn't bind to.
  let bridgeBlock: Record<string, unknown>;
  if (reusingStorage) {
    const existing = JSON.parse(readFileSync(join(storage, 'config.json'), 'utf8')) as {
      bridge: Record<string, unknown>;
    };
    bridgeBlock = { ...existing.bridge, port: bridgePort };
  } else {
    bridgeBlock = {
      name: 'E2E Test Bridge',
      // Random username to avoid HAP cache collisions across runs.
      username: ['CC', '22', '3D', 'E3'].concat([
        Math.floor(Math.random() * 256).toString(16).padStart(2, '0').toUpperCase(),
        Math.floor(Math.random() * 256).toString(16).padStart(2, '0').toUpperCase(),
      ]).join(':'),
      port: bridgePort,
      pin: '031-45-154',
    };
  }

  const defaultPima = {
    platform: 'PimaForce',
    name: 'Pima E2E',
    port: alarmPort,
    account,
    siren: { enabled: true, name: 'E2E Siren' },
    partitions: [
      {
        id: 2,
        name: 'E2E Partition',
        userCode: '0000',
      },
      {
        // Used to test the per-partition armModes toggle: AWAY enabled,
        // STAY and NIGHT disabled, so HomeKit picker should expose only
        // DISARM and AWAY for this partition.
        id: 3,
        name: 'E2E Restricted',
        userCode: '0000',
        armModes: { away: true, stay: false, night: false },
      },
    ],
    zones: [
      { zone: 3, name: 'E2E Motion', type: 'motion' },
      { zone: 4, name: 'E2E Door', type: 'contact' },
      { zone: 5, name: 'E2E Leak', type: 'leak' },
      { zone: 6, name: 'E2E Smoke', type: 'smoke' },
    ],
  };
  // Override fixes the alarmPort regardless (each setup gets a fresh port).
  // Force a short request timeout in tests: unanswered DATA-REQ / OPERATION
  // responses would otherwise stall the transport's wire queue for the
  // production-default 5 s, pushing HTTP-API-driven SET handlers past
  // homebridge's HAP socket timeout.
  const pimaEntry = {
    // Shorter than production-default (5000ms) so that unanswered DATA-REQs
    // — common in tests that don't drain the platform's startup queries —
    // don't stall the wire queue and push HTTP SETs past homebridge's HAP
    // socket timeout.
    requestTimeoutMs: 150,
    ...(opts.pimaPlatformOverride ?? defaultPima),
    platform: 'PimaForce',
    port: alarmPort,
    account,
  };

  const config = {
    bridge: bridgeBlock,
    platforms: [
      {
        platform: 'config',
        name: 'Config',
        port: uiPort,
        // Use 'none' so the noauth endpoint issues us a token without a real password.
        // We still need an admin user in auth.json for noauth to find one.
        auth: 'none',
        theme: 'auto',
      },
      pimaEntry,
    ],
  };
  // Pre-seed auth.json with an admin user so the /api/auth/noauth endpoint
  // can issue a token without going through the first-run setup wizard.
  // The bcrypt hash is never verified when `auth: 'none'` — only `admin === true` matters.
  const auth = [{
    id: 1,
    username: 'admin',
    name: 'Admin',
    hashedPassword: 'x',
    salt: 'x',
    admin: true,
  }];
  writeFileSync(join(storage, 'config.json'), JSON.stringify(config, null, 2));
  writeFileSync(join(storage, 'auth.json'), JSON.stringify(auth));

  const child = spawn(process.execPath, [HB_SERVICE_BIN, 'run', '-U', storage, '-P', ROOT], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  });
  // Surface failures but don't print every line — keep test logs clean.
  let logBuf = '';
  child.stdout?.on('data', (b) => { logBuf += b.toString('utf8'); });
  child.stderr?.on('data', (b) => { logBuf += b.toString('utf8'); });

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    if (!child.killed) {
      child.kill('SIGTERM');
      const settled = await Promise.race([
        once(child, 'exit').then(() => true),
        new Promise<boolean>((r) => setTimeout(() => r(false), 5000)),
      ]);
      if (!settled) child.kill('SIGKILL');
    }
    if (!opts.keepStorage) {
      rmSync(storage, { recursive: true, force: true });
    }
  };

  try {
    await waitForPort(uiPort);
    await waitForPort(alarmPort);
  } catch (err) {
    await stop();
    throw new Error(`setup failed: ${(err as Error).message}\n--- subprocess output ---\n${logBuf}`);
  }

  // Get an API token via noauth (auth=none + pre-seeded admin user).
  let token = '';
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await httpJson<AuthResponse>('POST', `http://127.0.0.1:${uiPort}/api/auth/noauth`, {});
      token = res.access_token;
      break;
    } catch {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
  }
  if (!token) {
    await stop();
    throw new Error(`could not obtain auth token\n--- subprocess output ---\n${logBuf}`);
  }

  const api = <T = unknown>(method: string, path: string, body?: unknown) =>
    httpJson<T>(method, `http://127.0.0.1:${uiPort}${path}`, body, token);

  // hb-service redirects the homebridge child's logs to a file in storage;
  // the supervisor's own stdout only contains startup banners. Read both.
  const logs = (): string => {
    let fileLog = '';
    try { fileLog = readFileSync(join(storage, 'homebridge.log'), 'utf8'); } catch { /* not yet created */ }
    return logBuf + '\n' + fileLog;
  };
  return { uiPort, alarmPort, account, storage, token, api, logs, stop };
}

describe('E2E: TCP ↔ UI', { timeout: 60_000 }, () => {
  let fix: E2EFixture;
  before(async () => {
    fix = await setupE2E();
    // Bridge accessory + plugin accessories take a moment to appear in the
    // UI's data layer after startup (HAP IPC bring-up). Don't start asserting
    // until they're all visible.
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

  it('on panel connect, queries partition state via DATA-REQ and reflects arm status', async () => {
    const alarm = await connectAlarmSystem(fix);
    const hb = homeBridgeFor(fix);
    try {
      // Respond to the startup partition-state query: partition 2 = FullArmed
      // (HomeKit AWAY_ARM).
      const stateQ = await alarm.nextQuery({ id: PARAM_ID_SYSTEM_KEY_STATUS, startOrder: 2 });
      alarm.respond(stateQ, partitionStatus({ status: PARTITION_FULL_ARMED }));

      await eventually(async () => assert.equal(
        await hb.partition('E2E Partition').currentState(), AWAY_ARM,
      ));

      // Reset to disarmed so this test doesn't affect later tests. A stray
      // DATA frame won't work — the transport claims every DATA via in-flight
      // matching — so use the panel-side disarm event path (CID 407 q=1)
      // instead, which the driver dispatches as a `disarm` event.
      await alarm.report(disarmedFromRemote({ partition: 2 }));
      await eventually(async () => assert.equal(
        await hb.partition('E2E Partition').currentState(), DISARMED,
      ));
    } finally {
      alarm.close();
    }
  });

  it('zone OPEN event flips ContactSensor to detected (Open) in UI', async () => {
    const alarm = await connectAlarmSystem(fix);
    const hb = homeBridgeFor(fix);
    try {
      await alarm.report(zoneOpened({ zone: 4, partition: 2 }));
      await eventually(async () => assert.equal(
        await hb.zone('E2E Door').state(), CONTACT_NOT_DETECTED,
      ));
    } finally {
      alarm.close();
    }
  });

  it('zone RESTORE event flips ContactSensor back to closed', async () => {
    const alarm = await connectAlarmSystem(fix);
    const hb = homeBridgeFor(fix);
    try {
      await alarm.report(zoneClosed({ zone: 4, partition: 2 }));
      await eventually(async () => assert.equal(
        await hb.zone('E2E Door').state(), CONTACT_DETECTED,
      ));
    } finally {
      alarm.close();
    }
  });

  it('panel ARM event flips SecuritySystem CurrentState to AWAY_ARM', async () => {
    const alarm = await connectAlarmSystem(fix);
    const hb = homeBridgeFor(fix);
    try {
      // External arm event with no prior target → defaults to AWAY_ARM.
      await alarm.report(armedFromRemote({ partition: 2, user: 2 }));
      await eventually(async () => assert.equal(
        await hb.partition('E2E Partition').currentState(), AWAY_ARM,
      ));
    } finally {
      alarm.close();
    }
  });

  it('UI SecuritySystem AWAY target sends an AWAY-arm OPERATION', async () => {
    const alarm = await connectAlarmSystem(fix);
    const partition = homeBridgeFor(fix).partition('E2E Partition');
    try {
      // Force DISARM first so the AWAY transition is a real SET (SET handler
      // short-circuits when value already matches).
      await partition.setTarget(DISARMED);
      await partition.setTarget(AWAY_ARM);

      const op = await alarm.nextOperation({ optype: OPTYPE_ARM_AWAY, partition: 2 });
      assert.equal(op.partition, 2);
    } finally {
      alarm.close();
    }
  });

  it('UI SecuritySystem STAY target sends a Home1 OPERATION', async () => {
    const alarm = await connectAlarmSystem(fix);
    const partition = homeBridgeFor(fix).partition('E2E Partition');
    try {
      await partition.setTarget(DISARMED);
      await partition.setTarget(STAY_ARM);

      const op = await alarm.nextOperation({ optype: OPTYPE_ARM_HOME1, partition: 2 });
      assert.equal(op.partition, 2);
    } finally {
      alarm.close();
    }
  });

  it('UI SecuritySystem NIGHT target sends a Home2 OPERATION', async () => {
    const alarm = await connectAlarmSystem(fix);
    const partition = homeBridgeFor(fix).partition('E2E Partition');
    try {
      await partition.setTarget(DISARMED);
      await partition.setTarget(NIGHT_ARM);

      await alarm.nextOperation({ optype: OPTYPE_ARM_HOME2, partition: 2 });
    } finally {
      alarm.close();
    }
  });

  it('burglary alarm event flips SecuritySystem CurrentState to ALARM_TRIGGERED', async () => {
    const alarm = await connectAlarmSystem(fix);
    const hb = homeBridgeFor(fix);
    try {
      await alarm.report(burglaryAlarm({ zone: 4, partition: 2 }));
      await eventually(async () => assert.equal(
        await hb.partition('E2E Partition').currentState(), ALARM_TRIGGERED,
      ));

      // Restore: alarm clears, current state leaves ALARM_TRIGGERED.
      await alarm.report(alarmRestored({ zone: 4, partition: 2 }));
      await eventually(async () => assert.notEqual(
        await hb.partition('E2E Partition').currentState(), ALARM_TRIGGERED,
      ));
    } finally {
      alarm.close();
    }
  });

  it('siren ON event flips Switch On to true', async () => {
    const alarm = await connectAlarmSystem(fix);
    const siren = homeBridgeFor(fix).siren('E2E Siren');
    try {
      await alarm.report(sirenActivated({ partition: 1 }));
      await eventually(async () => assert.equal(await siren.on(), true));
    } finally {
      alarm.close();
    }
  });

  it('siren OFF event flips Switch On to false', async () => {
    const alarm = await connectAlarmSystem(fix);
    const siren = homeBridgeFor(fix).siren('E2E Siren');
    try {
      await alarm.report(sirenActivated({ partition: 1 }));
      await eventually(async () => assert.equal(await siren.on(), true));

      await alarm.report(sirenDeactivated({ partition: 1 }));
      await eventually(async () => assert.equal(await siren.on(), false));
    } finally {
      alarm.close();
    }
  });

  it('toggling Switch OFF (while sounding) sends de-activate output OPERATION', async () => {
    const alarm = await connectAlarmSystem(fix);
    const siren = homeBridgeFor(fix).siren('E2E Siren');
    try {
      // First make the siren "sounding" so toggling OFF has work to do.
      await alarm.report(sirenActivated({ partition: 1 }));
      await eventually(async () => assert.equal(await siren.on(), true));

      await siren.setOn(false);

      const op = await alarm.nextOperation({ optype: OPTYPE_DEACTIVATE_OUTPUT });
      assert.equal(op.order, 1, 'external siren output number');
      assert.equal(op.partition, 0, 'panel-wide partition');
    } finally {
      alarm.close();
    }
  });

  it('toggling Switch OFF still sends de-activate even when we never saw a 770 q=1', async () => {
    // Regression: previously the SET handler short-circuited when
    // `target === this.active`. If the panel sounded the siren without
    // emitting type=770 (or we missed it), `this.active` stayed false and
    // tapping OFF in the Home app silently sent nothing.
    const alarm = await connectAlarmSystem(fix);
    const siren = homeBridgeFor(fix).siren('E2E Siren');
    try {
      // Deliberately no `sirenActivated` event — simulates the panel
      // sounding without us ever seeing the 770 q=1.
      assert.equal(await siren.on(), false, 'precondition: switch is OFF');

      await siren.setOn(false);
      const op = await alarm.nextOperation({ optype: OPTYPE_DEACTIVATE_OUTPUT });
      assert.equal(op.order, 1);
    } finally {
      alarm.close();
    }
  });

  it('toggling Switch ON (manual activation) is rejected — no OPERATION sent', async () => {
    const alarm = await connectAlarmSystem(fix);
    const hb = homeBridgeFor(fix);
    const siren = hb.siren('E2E Siren');
    try {
      // Ensure siren is OFF first.
      await alarm.report(sirenDeactivated({ partition: 1 }));
      await eventually(async () => assert.equal(await siren.on(), false));

      const opsBefore = alarm.operations.length;
      await siren.setOn(true);

      // Wait briefly; assert NO output OPERATION arrived.
      await new Promise((r) => setTimeout(r, 500));
      const opAfter = alarm.operations.slice(opsBefore).find(
        (o) => o.optype === OPTYPE_ACTIVATE_OUTPUT || o.optype === OPTYPE_DEACTIVATE_OUTPUT,
      );
      assert.equal(opAfter, undefined, `no output OPERATION should be sent on manual activation; got: ${JSON.stringify(opAfter)}`);

      // And the switch should be back to OFF.
      assert.equal(await siren.on(), false);
    } finally {
      alarm.close();
    }
  });

  it('zone event for unconfigured zone is logged once at INFO and does not crash', async () => {
    const alarm = await connectAlarmSystem(fix);
    const hb = homeBridgeFor(fix);
    try {
      const accessoriesBefore = (await hb.listAccessories()).length;

      // Zone 99 is not in our config. Send twice — the second open/close pair
      // should NOT generate a second INFO log.
      await alarm.report(zoneOpened({ zone: 99, partition: 2 }));
      await alarm.report(zoneClosed({ zone: 99, partition: 2 }));

      // Give the subprocess a moment to receive + log.
      await new Promise((r) => setTimeout(r, 300));

      // No new accessories were registered.
      assert.equal((await hb.listAccessories()).length, accessoriesBefore);

      // Logs contain at least one INFO line for unconfigured zone 99.
      const logs = fix.logs();
      const infoLines = logs.split('\n').filter((l) => l.includes('unconfigured zone') && l.includes('99'));
      assert.ok(
        infoLines.filter((l) => !l.includes('debug')).length >= 1,
        `expected at least one info-level log mentioning unconfigured zone 99, got:\n${infoLines.join('\n')}`,
      );
    } finally {
      alarm.close();
    }
  });

  it('arm event for unconfigured partition is logged at INFO and does not crash', async () => {
    const alarm = await connectAlarmSystem(fix);
    const hb = homeBridgeFor(fix);
    try {
      // Partition 7 is not in our config.
      await alarm.report(armedFromRemote({ partition: 7 }));

      await new Promise((r) => setTimeout(r, 300));

      // Existing partition 2 accessory is unaffected.
      const acc = await hb.findAccessory('E2E Partition');
      assert.notEqual(acc, undefined);

      const logs = fix.logs();
      assert.ok(
        logs.includes('unconfigured partition 7'),
        `expected log to mention unconfigured partition 7, got tail:\n${logs.split('\n').slice(-30).join('\n')}`,
      );
    } finally {
      alarm.close();
    }
  });

  it('valid event still works after an unconfigured one', async () => {
    const alarm = await connectAlarmSystem(fix);
    const motion = homeBridgeFor(fix).zone('E2E Motion');
    try {
      // Unknown zone first (should be ignored gracefully).
      await alarm.report(zoneOpened({ zone: 88, partition: 2 }));
      // Then a valid event on configured zone 3 (motion sensor).
      await alarm.report(zoneOpened({ zone: 3, partition: 2 }));

      // HAP serialises MotionDetected as 1/0, not true/false.
      await eventually(async () => assert.equal(await motion.state(), 1));
    } finally {
      alarm.close();
    }
  });

  it('motion zone event flips MotionDetected true/false', async () => {
    const alarm = await connectAlarmSystem(fix);
    const motion = homeBridgeFor(fix).zone('E2E Motion');
    try {
      await alarm.report(zoneOpened({ zone: 3, partition: 2 }));
      await eventually(async () => assert.equal(await motion.state(), 1));

      await alarm.report(zoneClosed({ zone: 3, partition: 2 }));
      await eventually(async () => assert.equal(await motion.state(), 0));
    } finally {
      alarm.close();
    }
  });

  it('leak zone event flips LeakDetected', async () => {
    const alarm = await connectAlarmSystem(fix);
    const leak = homeBridgeFor(fix).zone('E2E Leak');
    try {
      await alarm.report(zoneOpened({ zone: 5, partition: 2 }));
      // LeakDetected: 1 = LEAK_DETECTED, 0 = LEAK_NOT_DETECTED
      await eventually(async () => assert.equal(await leak.state(), 1));

      await alarm.report(zoneClosed({ zone: 5, partition: 2 }));
      await eventually(async () => assert.equal(await leak.state(), 0));
    } finally {
      alarm.close();
    }
  });

  it('smoke zone event flips SmokeDetected', async () => {
    const alarm = await connectAlarmSystem(fix);
    const smoke = homeBridgeFor(fix).zone('E2E Smoke');
    try {
      await alarm.report(zoneOpened({ zone: 6, partition: 2 }));
      await eventually(async () => assert.equal(await smoke.state(), 1));

      await alarm.report(zoneClosed({ zone: 6, partition: 2 }));
      await eventually(async () => assert.equal(await smoke.state(), 0));
    } finally {
      alarm.close();
    }
  });

  it('restricted partition advertises only DISARM and AWAY as valid targets', async () => {
    // The UI exposes `validValues` for the characteristic (the values the
    // Home app picker offers). For the partition with
    // armModes={away:true, stay:false, night:false} we expect [DISARM, AWAY].
    const restricted = homeBridgeFor(fix).partition('E2E Restricted');
    const allowed = await restricted.validTargetStates();
    assert.ok(allowed.length > 0, 'expected validValues to be advertised');
    assert.deepEqual(
      [...allowed].sort((a, b) => a - b),
      [AWAY_ARM, DISARMED],
      `expected validValues [AWAY=${AWAY_ARM}, DISARM=${DISARMED}], got ${JSON.stringify(allowed)}`,
    );
  });

  it('disabled mode SET on restricted partition does not send an arm OPERATION', async () => {
    const alarm = await connectAlarmSystem(fix);
    const restricted = homeBridgeFor(fix).partition('E2E Restricted');
    try {
      const opsBefore = alarm.operations.length;
      // STAY is disabled. HAP / platform defense-in-depth should reject the SET.
      await restricted.setTarget(STAY_ARM).catch(() => { /* expected error */ });

      await new Promise((r) => setTimeout(r, 300));
      const op = alarm.operations.slice(opsBefore).find(
        (o) => o.optype === OPTYPE_ARM_HOME1 || o.optype === OPTYPE_ARM_HOME2,
      );
      assert.equal(op, undefined, `disabled mode should not send Home1/Home2; got: ${JSON.stringify(op)}`);
    } finally {
      alarm.close();
    }
  });

  it('enabled mode SET on restricted partition still works (AWAY arm)', async () => {
    const alarm = await connectAlarmSystem(fix);
    const restricted = homeBridgeFor(fix).partition('E2E Restricted');
    try {
      // Force DISARM first so the AWAY transition fires SET.
      await restricted.setTarget(DISARMED);
      await restricted.setTarget(AWAY_ARM);

      const op = await alarm.nextOperation({ optype: OPTYPE_ARM_AWAY, partition: 3 });
      assert.equal(op.partition, 3);
    } finally {
      alarm.close();
    }
  });

  it('UI SecuritySystem DISARM target sends disarm OPERATION', async () => {
    const alarm = await connectAlarmSystem(fix);
    const partition = homeBridgeFor(fix).partition('E2E Partition');
    try {
      // Force AWAY_ARM first so the DISARM transition actually triggers a SET.
      await partition.setTarget(AWAY_ARM);
      await partition.setTarget(DISARMED);

      const op = await alarm.nextOperation({ optype: OPTYPE_DISARM, partition: 2 });
      assert.equal(op.partition, 2);
    } finally {
      alarm.close();
    }
  });
});

/**
 * Migration E2E: a user upgrading from a pre-flat-zones plugin version had
 * their config laid out with zones nested under each partition. The new
 * plugin must (a) read that shape, (b) register accessories with stable
 * UUIDs derived from zone#/partition.id only (not from nesting), and
 * (c) preserve those accessories across a restart so existing HomeKit
 * automations don't break.
 */
describe('E2E: legacy nested config migration', { timeout: 90_000 }, () => {
  const legacyPima = {
    name: 'Pima E2E (legacy)',
    siren: { enabled: true, name: 'Legacy Siren' },
    partitions: [
      {
        id: 1,
        name: 'Legacy Partition',
        userCode: '0000',
        zones: [
          { zone: 7, name: 'Legacy Door', type: 'contact' },
        ],
      },
    ],
  };

  let fix: E2EFixture;
  let storagePath: string;
  let firstBootUuids: Map<string, string>;

  const expectedAccessories = ['Legacy Partition', 'Legacy Door', 'Legacy Siren'];

  before(async () => {
    // Boot 1: install with legacy nested config. Plugin migrates in-memory
    // and registers accessories with the new flat-shape UUID convention.
    fix = await setupE2E({ pimaPlatformOverride: legacyPima, keepStorage: true });
    storagePath = fix.storage;
    const hb = homeBridgeFor(fix);
    const list = await eventually(async () => {
      const accs = await hb.listAccessories();
      const names = new Set(accs.map((a) => a.serviceName));
      for (const n of expectedAccessories) assert.ok(names.has(n), `accessory "${n}" not yet registered; saw ${[...names].join(', ')}`);
      return accs;
    }, { timeoutMs: 15_000 });
    firstBootUuids = new Map(list.map((a) => [a.serviceName, a.uniqueId]));
    await fix.stop();
  });

  after(async () => {
    rmSync(storagePath, { recursive: true, force: true });
  });

  it('migrates nested zones into accessories on first boot', async () => {
    assert.ok(firstBootUuids.has('Legacy Partition'), 'partition accessory was not registered');
    assert.ok(firstBootUuids.has('Legacy Door'), 'nested zone was not migrated to a HomeKit accessory');
    assert.ok(firstBootUuids.has('Legacy Siren'), 'siren accessory was not registered');
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
    fix = await setupE2E({
      storage: storagePath,
      pimaPlatformOverride: legacyPima,
      keepStorage: true,
    });
    try {
      const hb = homeBridgeFor(fix);
      const list = await eventually(async () => {
        const accs = await hb.listAccessories();
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
    } finally {
      await fix.stop();
    }
  });
});

/**
 * Onboarding E2E: a user installs the plugin with only partitions configured
 * (no manual zone list). On first panel connect, the plugin must query the
 * panel for installed zone count + zone names, append the discovered zones
 * to config.json, and register them as HomeKit accessories in-process so
 * they appear in the Home app immediately — no Homebridge restart required.
 */
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
    const alarm = await connectAlarmSystem(fix, { verify: false });
    const hb = homeBridgeFor(fix);
    try {
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
    } finally {
      alarm.close();
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
    const alarm = await connectAlarmSystem(fix);
    const hb = homeBridgeFor(fix);
    try {
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
    } finally {
      alarm.close();
    }
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
    const alarm = await connectAlarmSystem(fix);
    const hb = homeBridgeFor(fix);
    try {
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
    } finally {
      alarm.close();
    }
  });
});

/**
 * Regression: with multiple partitions configured, the platform must query each
 * partition's state one-at-a-time. The real panel only accepts a single
 * DATA-REQ in flight at once and NAKs/drops the rest. v0.1.15 fanned out 3
 * concurrent DATA-REQs and only partition 1's state ever arrived.
 */
describe('E2E: partition state query serialization', { timeout: 30_000 }, () => {
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
    const alarm = await connectAlarmSystem(fix);
    const hb = homeBridgeFor(fix);
    try {
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
    } finally {
      alarm.close();
    }
  });
});

describe('E2E: freshly installed plugin with no partitions configured', { timeout: 60_000 }, () => {
  let uiPort: number;
  let alarmPort: number;
  let apiCall: E2EFixture['api'];
  let stopFn: () => Promise<void>;
  let getlogs: () => string;

  before(async () => {
    uiPort = await getFreePort();
    const bridgePort = await getFreePort();
    alarmPort = await getFreePort();

    const storage = mkdtempSync(join(tmpdir(), 'hbpima-e2e-uncfg-'));
    const config = {
      bridge: {
        name: 'E2E Unconfigured Bridge',
        username: ['CC', '22', '3D', 'E3'].concat([
          Math.floor(Math.random() * 256).toString(16).padStart(2, '0').toUpperCase(),
          Math.floor(Math.random() * 256).toString(16).padStart(2, '0').toUpperCase(),
        ]).join(':'),
        port: bridgePort,
        pin: '031-45-154',
      },
      platforms: [
        {
          platform: 'config',
          name: 'Config',
          port: uiPort,
          auth: 'none',
          theme: 'auto',
        },
        {
          platform: 'PimaForce',
          name: 'Pima Force Unconfigured',
          port: alarmPort,
          account: 1234,
          partitions: [],
        },
      ],
    };
    const auth = [{ id: 1, username: 'admin', name: 'Admin', hashedPassword: 'x', salt: 'x', admin: true }];
    writeFileSync(join(storage, 'config.json'), JSON.stringify(config, null, 2));
    writeFileSync(join(storage, 'auth.json'), JSON.stringify(auth));

    const child = spawn(process.execPath, [HB_SERVICE_BIN, 'run', '-U', storage, '-P', ROOT], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    let logBuf = '';
    child.stdout?.on('data', (b: Buffer) => { logBuf += b.toString('utf8'); });
    child.stderr?.on('data', (b: Buffer) => { logBuf += b.toString('utf8'); });

    let stopped = false;
    stopFn = async (): Promise<void> => {
      if (stopped) return;
      stopped = true;
      if (!child.killed) {
        child.kill('SIGTERM');
        const settled = await Promise.race([
          once(child, 'exit').then(() => true),
          new Promise<boolean>((r) => setTimeout(() => r(false), 5000)),
        ]);
        if (!settled) child.kill('SIGKILL');
      }
      rmSync(storage, { recursive: true, force: true });
    };

    try {
      await waitForPort(uiPort);
    } catch (err) {
      await stopFn();
      throw new Error(`setup failed: ${(err as Error).message}\n--- subprocess output ---\n${logBuf}`);
    }

    let token = '';
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        const res = await httpJson<AuthResponse>('POST', `http://127.0.0.1:${uiPort}/api/auth/noauth`, {});
        token = res.access_token;
        break;
      } catch {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      }
    }
    if (!token) {
      await stopFn();
      throw new Error(`could not obtain auth token\n--- subprocess output ---\n${logBuf}`);
    }

    apiCall = <T = unknown>(method: string, path: string, body?: unknown) =>
      httpJson<T>(method, `http://127.0.0.1:${uiPort}${path}`, body, token);

    getlogs = (): string => {
      let fileLog = '';
      try { fileLog = readFileSync(join(storage, 'homebridge.log'), 'utf8'); } catch { /* not yet created */ }
      return logBuf + '\n' + fileLog;
    };

  });

  after(async () => { await stopFn?.(); });

  it('driver does not start — alarm port remains unbound', async () => {
    // Poll for 5 s to give discoverDevices() time to run. Fail fast if the port
    // ever becomes bound; pass once the window closes without a connection.
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const bound = await new Promise<boolean>((resolve) => {
        const sock = net.createConnection({ host: '127.0.0.1', port: alarmPort });
        sock.once('connect', () => { sock.destroy(); resolve(true); });
        sock.once('error', () => resolve(false));
      });
      if (bound) {
        assert.fail(
          `alarm port became bound when no partitions are configured; logs:\n${getlogs().split('\n').slice(-20).join('\n')}`
        );
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
  });

  it('no plugin accessories are registered', async () => {
    const list = await apiCall<AccessoryService[]>('GET', '/api/accessories');
    const pluginTypes = new Set(['SecuritySystem', 'ContactSensor', 'MotionSensor', 'LeakSensor', 'SmokeSensor', 'Switch']);
    const pluginAccessories = list.filter((a) => pluginTypes.has(a.type));
    assert.equal(pluginAccessories.length, 0,
      `expected no plugin accessories when unconfigured, got: ${pluginAccessories.map((a) => a.serviceName).join(', ')}`);
  });
});
