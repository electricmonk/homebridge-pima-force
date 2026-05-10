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

const ROOT = process.cwd();
const HB_SERVICE_BIN = join(ROOT, 'node_modules/homebridge-config-ui-x/dist/bin/hb-service.js');
const STARTUP_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 50;

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

interface FakeAlarm {
  send(frame: Record<string, unknown>): void;
  /** All frames received from the driver, in order. */
  received: Array<Record<string, unknown>>;
  /** Resolve when at least N frames received from the driver. */
  waitForRx(n: number, timeoutMs?: number): Promise<void>;
  close(): void;
}

interface E2EFixture {
  uiPort: number;
  alarmPort: number;
  account: number;
  storage: string;
  token: string;
  api<T = unknown>(method: string, path: string, body?: unknown): Promise<T>;
  connectAlarm(): Promise<FakeAlarm>;
  /** Snapshot of all stdout+stderr written by the homebridge subprocess. */
  logs(): string;
  stop(): Promise<void>;
}

async function setupE2E(): Promise<E2EFixture> {
  const uiPort = await getFreePort();
  const bridgePort = await getFreePort();
  const alarmPort = await getFreePort();
  const account = 1234;
  const storage = mkdtempSync(join(tmpdir(), 'hbpima-e2e-'));

  const config = {
    bridge: {
      name: 'E2E Test Bridge',
      // Random username to avoid HAP cache collisions across runs.
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
        // Use 'none' so the noauth endpoint issues us a token without a real password.
        // We still need an admin user in auth.json for noauth to find one.
        auth: 'none',
        theme: 'auto',
      },
      {
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
            zones: [
              { zone: 3, name: 'E2E Motion', type: 'motion' },
              { zone: 4, name: 'E2E Door', type: 'contact' },
              { zone: 5, name: 'E2E Leak', type: 'leak' },
              { zone: 6, name: 'E2E Smoke', type: 'smoke' },
            ],
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
      },
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
    rmSync(storage, { recursive: true, force: true });
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

  const connectAlarm = (): Promise<FakeAlarm> => new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: '127.0.0.1', port: alarmPort });
    const received: Array<Record<string, unknown>> = [];
    sock.on('data', (buf) => {
      // The driver may emit multiple frames per chunk under TCP coalescing.
      const text = buf.toString('utf8');
      for (const part of text.split(/(?<=\})(?=\{)/)) {
        try { received.push(JSON.parse(part)); } catch { /* ignore */ }
      }
    });
    sock.once('connect', () => {
      const send = (frame: Record<string, unknown>) => {
        sock.write(JSON.stringify(frame));
      };
      const waitForRx = async (n: number, timeoutMs = 2000) => {
        const d = Date.now() + timeoutMs;
        while (received.length < n) {
          if (Date.now() > d) {
            throw new Error(`timeout waiting for ${n} frames; got ${received.length}: ${JSON.stringify(received)}`);
          }
          await new Promise((r) => setTimeout(r, 10));
        }
      };
      const close = () => sock.destroy();
      resolve({ send, received, waitForRx, close });
    });
    sock.once('error', reject);
  });

  // hb-service redirects the homebridge child's logs to a file in storage;
  // the supervisor's own stdout only contains startup banners. Read both.
  const logs = (): string => {
    let fileLog = '';
    try { fileLog = readFileSync(join(storage, 'homebridge.log'), 'utf8'); } catch { /* not yet created */ }
    return logBuf + '\n' + fileLog;
  };
  return { uiPort, alarmPort, account, storage, token, api, connectAlarm, logs, stop };
}

interface AccessorySnapshot extends AccessoryService {
  values: Record<string, unknown>;
}

async function listAccessories(fix: E2EFixture): Promise<AccessorySnapshot[]> {
  const list = await fix.api<AccessoryService[]>('GET', '/api/accessories');
  return list.map((a) => ({
    ...a,
    values: Object.fromEntries(a.serviceCharacteristics.map((c) => [c.type, c.value])),
  }));
}

async function findAccessoryByName(fix: E2EFixture, name: string): Promise<AccessorySnapshot> {
  const list = await listAccessories(fix);
  const acc = list.find((a) => a.serviceName === name);
  if (!acc) throw new Error(`accessory "${name}" not found in: ${list.map((a) => a.serviceName).join(', ')}`);
  return acc;
}

/**
 * Poll the UI accessories API until `predicate(accessory)` returns true.
 * Used to wait for state propagation from a TCP event into the UI's data layer.
 * Tolerates the accessory being briefly absent from the list (config-ui-x's
 * IPC link to homebridge takes a beat to populate after startup).
 */
async function waitForAccessoryState(
  fix: E2EFixture,
  name: string,
  predicate: (acc: AccessorySnapshot) => boolean,
  timeoutMs = 5000,
): Promise<AccessorySnapshot> {
  const deadline = Date.now() + timeoutMs;
  let last: AccessorySnapshot | undefined;
  let lastErr: Error | undefined;
  while (Date.now() < deadline) {
    try {
      last = await findAccessoryByName(fix, name);
      if (predicate(last)) return last;
    } catch (err) {
      lastErr = err as Error;
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`timeout waiting for accessory "${name}" predicate; last state: ${JSON.stringify(last?.values)} ${lastErr ? `(last error: ${lastErr.message})` : ''}`);
}

/** Wait until all named accessories appear in the UI's list. */
async function waitForAccessories(fix: E2EFixture, names: string[], timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: string[] = [];
  while (Date.now() < deadline) {
    try {
      const list = await listAccessories(fix);
      last = list.map((a) => a.serviceName);
      if (names.every((n) => last.includes(n))) return;
    } catch {
      // ignore — keep polling
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`timeout waiting for accessories ${JSON.stringify(names)}; last seen: ${JSON.stringify(last)}`);
}

describe('E2E: TCP ↔ UI', { timeout: 60_000 }, () => {
  let fix: E2EFixture;
  before(async () => {
    fix = await setupE2E();
    // Bridge accessory + plugin accessories take a moment to appear in the
    // UI's data layer after startup (HAP IPC bring-up). Don't start asserting
    // until they're all visible.
    await waitForAccessories(fix, [
      'E2E Partition', 'E2E Motion', 'E2E Door', 'E2E Leak', 'E2E Smoke', 'E2E Siren',
      'E2E Restricted',
    ]);
  });
  after(async () => { await fix?.stop(); });

  it('all configured accessories appear in the UI', async () => {
    const list = await listAccessories(fix);
    const names = new Set(list.map((a) => a.serviceName));
    for (const expected of ['E2E Partition', 'E2E Motion', 'E2E Door', 'E2E Leak', 'E2E Smoke', 'E2E Siren']) {
      assert.ok(names.has(expected), `expected accessory "${expected}" in ${[...names].join(', ')}`);
    }
  });

  it('zone types map to the right HAP service per the dropdown', async () => {
    const list = await listAccessories(fix);
    const byName = new Map(list.map((a) => [a.serviceName, a]));
    assert.equal(byName.get('E2E Door')?.type, 'ContactSensor');
    assert.equal(byName.get('E2E Motion')?.type, 'MotionSensor');
    assert.equal(byName.get('E2E Leak')?.type, 'LeakSensor');
    assert.equal(byName.get('E2E Smoke')?.type, 'SmokeSensor');
  });

  it('partition is exposed as a SecuritySystem service', async () => {
    const list = await listAccessories(fix);
    const partition = list.find((a) => a.serviceName === 'E2E Partition');
    assert.equal(partition?.type, 'SecuritySystem');
  });

  it('siren is exposed as a Switch service', async () => {
    const list = await listAccessories(fix);
    const siren = list.find((a) => a.serviceName === 'E2E Siren');
    assert.equal(siren?.type, 'Switch');
  });

  it('zone OPEN event flips ContactSensor to detected (Open) in UI', async () => {
    const alarm = await fix.connectAlarm();
    try {
      // Bring the connection alive with a heartbeat so the driver registers
      // it as the "active" socket; the response is the driver's ACK.
      alarm.send({ frame_type: 'null', counter: 1, account: String(fix.account) });
      await alarm.waitForRx(1);

      // Send zone-open event for zone 4 (E2E Door).
      alarm.send({
        frame_type: 'event',
        counter: 2,
        account: String(fix.account),
        type: 760,
        qualifier: 1,
        zone: 4,
        partition: 2,
      });

      // ContactSensorState: 0 = CONTACT_DETECTED (closed), 1 = CONTACT_NOT_DETECTED (open).
      const acc = await waitForAccessoryState(fix, 'E2E Door', (a) => a.values.ContactSensorState === 1);
      assert.equal(acc.values.ContactSensorState, 1);
    } finally {
      alarm.close();
    }
  });

  it('zone RESTORE event flips ContactSensor back to closed', async () => {
    const alarm = await fix.connectAlarm();
    try {
      alarm.send({ frame_type: 'null', counter: 10, account: String(fix.account) });
      await alarm.waitForRx(1);
      alarm.send({
        frame_type: 'event',
        counter: 11,
        account: String(fix.account),
        type: 760,
        qualifier: 3,
        zone: 4,
        partition: 2,
      });
      const acc = await waitForAccessoryState(fix, 'E2E Door', (a) => a.values.ContactSensorState === 0);
      assert.equal(acc.values.ContactSensorState, 0);
    } finally {
      alarm.close();
    }
  });

  it('panel ARM event flips SecuritySystem CurrentState to AWAY_ARM', async () => {
    const alarm = await fix.connectAlarm();
    try {
      alarm.send({ frame_type: 'null', counter: 20, account: String(fix.account) });
      await alarm.waitForRx(1);
      // type=407 qualifier=3 = remote arm (closing/restore on partition 2)
      alarm.send({
        frame_type: 'event',
        counter: 21,
        account: String(fix.account),
        type: 407,
        qualifier: 3,
        zone: 2,
        partition: 2,
      });
      // SecuritySystemCurrentState: STAY=0, AWAY=1, NIGHT=2, DISARMED=3, ALARM=4.
      // External arm event with no prior target → defaults to AWAY_ARM (1).
      const acc = await waitForAccessoryState(fix, 'E2E Partition',
        (a) => a.values.SecuritySystemCurrentState === 1);
      assert.equal(acc.values.SecuritySystemCurrentState, 1);
    } finally {
      alarm.close();
    }
  });

  it('UI SecuritySystem AWAY target sends OPERATION arm (optype=12)', async () => {
    const alarm = await fix.connectAlarm();
    try {
      alarm.send({ frame_type: 'null', counter: 30, account: String(fix.account) });
      await alarm.waitForRx(1);
      const before = alarm.received.length;

      const partition = await findAccessoryByName(fix, 'E2E Partition');
      // Force DISARM first (SET handler short-circuits when value already matches).
      await fix.api('PUT', `/api/accessories/${partition.uniqueId}`, {
        characteristicType: 'SecuritySystemTargetState', value: 3, // DISARM
      });
      await fix.api('PUT', `/api/accessories/${partition.uniqueId}`, {
        characteristicType: 'SecuritySystemTargetState', value: 1, // AWAY_ARM
      });

      const deadline = Date.now() + 5000;
      let op: Record<string, unknown> | undefined;
      while (Date.now() < deadline) {
        op = alarm.received.slice(before).find((f) => f.frame_type === 'OPERATION' && f.optype === 12);
        if (op) break;
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      }
      assert.ok(op, `no AWAY ARM OPERATION received; got: ${JSON.stringify(alarm.received.slice(before))}`);
      assert.equal(op.optype, 12);
      assert.equal(op.partition, 2);
    } finally {
      alarm.close();
    }
  });

  it('UI SecuritySystem STAY target sends Home1 OPERATION (optype=13)', async () => {
    const alarm = await fix.connectAlarm();
    try {
      alarm.send({ frame_type: 'null', counter: 31, account: String(fix.account) });
      await alarm.waitForRx(1);
      const before = alarm.received.length;

      const partition = await findAccessoryByName(fix, 'E2E Partition');
      await fix.api('PUT', `/api/accessories/${partition.uniqueId}`, {
        characteristicType: 'SecuritySystemTargetState', value: 3, // DISARM
      });
      await fix.api('PUT', `/api/accessories/${partition.uniqueId}`, {
        characteristicType: 'SecuritySystemTargetState', value: 0, // STAY_ARM
      });

      const deadline = Date.now() + 5000;
      let op: Record<string, unknown> | undefined;
      while (Date.now() < deadline) {
        op = alarm.received.slice(before).find((f) => f.frame_type === 'OPERATION' && f.optype === 13);
        if (op) break;
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      }
      assert.ok(op, `no STAY (Home1) OPERATION received; got: ${JSON.stringify(alarm.received.slice(before))}`);
      assert.equal(op.optype, 13);
      assert.equal(op.partition, 2);
    } finally {
      alarm.close();
    }
  });

  it('UI SecuritySystem NIGHT target sends Home2 OPERATION (optype=14)', async () => {
    const alarm = await fix.connectAlarm();
    try {
      alarm.send({ frame_type: 'null', counter: 32, account: String(fix.account) });
      await alarm.waitForRx(1);
      const before = alarm.received.length;

      const partition = await findAccessoryByName(fix, 'E2E Partition');
      await fix.api('PUT', `/api/accessories/${partition.uniqueId}`, {
        characteristicType: 'SecuritySystemTargetState', value: 3, // DISARM
      });
      await fix.api('PUT', `/api/accessories/${partition.uniqueId}`, {
        characteristicType: 'SecuritySystemTargetState', value: 2, // NIGHT_ARM
      });

      const deadline = Date.now() + 5000;
      let op: Record<string, unknown> | undefined;
      while (Date.now() < deadline) {
        op = alarm.received.slice(before).find((f) => f.frame_type === 'OPERATION' && f.optype === 14);
        if (op) break;
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      }
      assert.ok(op, `no NIGHT (Home2) OPERATION received; got: ${JSON.stringify(alarm.received.slice(before))}`);
      assert.equal(op.optype, 14);
    } finally {
      alarm.close();
    }
  });

  it('burglary alarm event flips SecuritySystem CurrentState to ALARM_TRIGGERED', async () => {
    const alarm = await fix.connectAlarm();
    try {
      alarm.send({ frame_type: 'null', counter: 110, account: String(fix.account) });
      await alarm.waitForRx(1);
      // type=130 qualifier=1 = burglary alarm
      alarm.send({
        frame_type: 'event',
        counter: 111,
        account: String(fix.account),
        type: 130,
        qualifier: 1,
        zone: 4,
        partition: 2,
      });
      const acc = await waitForAccessoryState(fix, 'E2E Partition',
        (a) => a.values.SecuritySystemCurrentState === 4); // ALARM_TRIGGERED
      assert.equal(acc.values.SecuritySystemCurrentState, 4);

      // Restore: alarm clears.
      alarm.send({
        frame_type: 'event',
        counter: 112,
        account: String(fix.account),
        type: 130,
        qualifier: 3,
        zone: 4,
        partition: 2,
      });
      // After restore current state should leave ALARM_TRIGGERED.
      await waitForAccessoryState(fix, 'E2E Partition',
        (a) => a.values.SecuritySystemCurrentState !== 4);
    } finally {
      alarm.close();
    }
  });

  it('siren ON event flips Switch On to true', async () => {
    const alarm = await fix.connectAlarm();
    try {
      alarm.send({ frame_type: 'null', counter: 120, account: String(fix.account) });
      await alarm.waitForRx(1);
      // type=770 qualifier=1, output=1 (zone field) = external siren on
      alarm.send({
        frame_type: 'event',
        counter: 121,
        account: String(fix.account),
        type: 770,
        qualifier: 1,
        zone: 1,
        partition: 1,
      });
      const acc = await waitForAccessoryState(fix, 'E2E Siren', (a) => Boolean(a.values.On));
      assert.ok(Boolean(acc.values.On));
    } finally {
      alarm.close();
    }
  });

  it('siren OFF event flips Switch On to false', async () => {
    const alarm = await fix.connectAlarm();
    try {
      alarm.send({ frame_type: 'null', counter: 122, account: String(fix.account) });
      await alarm.waitForRx(1);
      alarm.send({
        frame_type: 'event',
        counter: 123,
        account: String(fix.account),
        type: 770,
        qualifier: 1,
        zone: 1,
        partition: 1,
      });
      await waitForAccessoryState(fix, 'E2E Siren', (a) => Boolean(a.values.On));
      // Now send the de-activated event; switch should flip back.
      alarm.send({
        frame_type: 'event',
        counter: 124,
        account: String(fix.account),
        type: 770,
        qualifier: 3,
        zone: 1,
        partition: 1,
      });
      await waitForAccessoryState(fix, 'E2E Siren', (a) => !a.values.On);
    } finally {
      alarm.close();
    }
  });

  it('toggling Switch OFF (while sounding) sends de-activate output OPERATION', async () => {
    const alarm = await fix.connectAlarm();
    try {
      alarm.send({ frame_type: 'null', counter: 130, account: String(fix.account) });
      await alarm.waitForRx(1);
      // First make the siren "sounding" so toggling OFF has work to do.
      alarm.send({
        frame_type: 'event',
        counter: 131,
        account: String(fix.account),
        type: 770,
        qualifier: 1,
        zone: 1,
        partition: 1,
      });
      await waitForAccessoryState(fix, 'E2E Siren', (a) => Boolean(a.values.On));

      const before = alarm.received.length;
      const siren = await findAccessoryByName(fix, 'E2E Siren');
      await fix.api('PUT', `/api/accessories/${siren.uniqueId}`, {
        characteristicType: 'On', value: false,
      });

      const deadline = Date.now() + 5000;
      let op: Record<string, unknown> | undefined;
      while (Date.now() < deadline) {
        op = alarm.received.slice(before).find((f) => f.frame_type === 'OPERATION' && f.optype === 36);
        if (op) break;
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      }
      assert.ok(op, `no de-activate-output OPERATION received; got: ${JSON.stringify(alarm.received.slice(before))}`);
      assert.equal(op.optype, 36);
      assert.equal(op.order, 1); // external siren
      assert.equal(op.partition, 0); // panel-wide
    } finally {
      alarm.close();
    }
  });

  it('toggling Switch OFF still sends de-activate even when we never saw a 770 q=1', async () => {
    // Regression: previously the SET handler short-circuited when
    // `target === this.active`. If the panel sounded the siren without
    // emitting type=770 (or we missed it), `this.active` stayed false and
    // tapping OFF in the Home app silently sent nothing.
    const alarm = await fix.connectAlarm();
    try {
      alarm.send({ frame_type: 'null', counter: 150, account: String(fix.account) });
      await alarm.waitForRx(1);
      // Note: we deliberately do NOT send a 770 q=1 here — simulating the
      // panel either not reporting the activation or us having missed it.
      const before = alarm.received.length;
      const siren = await findAccessoryByName(fix, 'E2E Siren');
      assert.ok(!siren.values.On, 'precondition: switch is OFF');

      await fix.api('PUT', `/api/accessories/${siren.uniqueId}`, {
        characteristicType: 'On', value: false,
      });

      const deadline = Date.now() + 5000;
      let op: Record<string, unknown> | undefined;
      while (Date.now() < deadline) {
        op = alarm.received.slice(before).find((f) => f.frame_type === 'OPERATION' && f.optype === 36);
        if (op) break;
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      }
      assert.ok(op, `expected de-activate-output OPERATION even from a "no-change" SET; got: ${JSON.stringify(alarm.received.slice(before))}`);
      assert.equal(op.optype, 36);
      assert.equal(op.order, 1);
    } finally {
      alarm.close();
    }
  });

  it('toggling Switch ON (manual activation) is rejected — no OPERATION sent', async () => {
    const alarm = await fix.connectAlarm();
    try {
      alarm.send({ frame_type: 'null', counter: 140, account: String(fix.account) });
      await alarm.waitForRx(1);
      // Ensure siren is OFF first.
      alarm.send({
        frame_type: 'event',
        counter: 141,
        account: String(fix.account),
        type: 770,
        qualifier: 3,
        zone: 1,
        partition: 1,
      });
      await waitForAccessoryState(fix, 'E2E Siren', (a) => !a.values.On);

      const before = alarm.received.length;
      const siren = await findAccessoryByName(fix, 'E2E Siren');
      await fix.api('PUT', `/api/accessories/${siren.uniqueId}`, {
        characteristicType: 'On', value: true,
      });

      // Wait briefly for any OPERATION to surface; assert NONE arrives.
      await new Promise((r) => setTimeout(r, 500));
      const op = alarm.received.slice(before).find(
        (f) => f.frame_type === 'OPERATION' && (f.optype === 35 || f.optype === 36),
      );
      assert.equal(op, undefined, `no output OPERATION should be sent on manual activation; got: ${JSON.stringify(op)}`);

      // And the switch should be back to OFF.
      const acc = await findAccessoryByName(fix, 'E2E Siren');
      assert.ok(!acc.values.On, `expected siren switch to remain OFF; got On=${acc.values.On}`);
    } finally {
      alarm.close();
    }
  });

  it('zone event for unconfigured zone is logged once at INFO and does not crash', async () => {
    const alarm = await fix.connectAlarm();
    try {
      alarm.send({ frame_type: 'null', counter: 50, account: String(fix.account) });
      await alarm.waitForRx(1);

      const accessoriesBefore = (await listAccessories(fix)).length;

      // Zone 99 is not in our config.
      alarm.send({
        frame_type: 'event',
        counter: 51,
        account: String(fix.account),
        type: 760,
        qualifier: 1,
        zone: 99,
        partition: 2,
      });
      // Send same unknown zone again — should NOT generate a second info log.
      alarm.send({
        frame_type: 'event',
        counter: 52,
        account: String(fix.account),
        type: 760,
        qualifier: 3,
        zone: 99,
        partition: 2,
      });

      // Give the subprocess a moment to receive + log.
      await new Promise((r) => setTimeout(r, 300));

      // No new accessories were registered.
      const accessoriesAfter = await listAccessories(fix);
      assert.equal(accessoriesAfter.length, accessoriesBefore);

      // Logs contain exactly one INFO line for unconfigured zone 99.
      const logs = fix.logs();
      const infoLines = logs.split('\n').filter((l) => l.includes('unconfigured zone') && l.includes('99'));
      assert.equal(
        infoLines.filter((l) => !l.includes('debug')).length >= 1,
        true,
        `expected at least one info-level log mentioning unconfigured zone 99, got:\n${infoLines.join('\n')}`,
      );
    } finally {
      alarm.close();
    }
  });

  it('arm event for unconfigured partition is logged at INFO and does not crash', async () => {
    const alarm = await fix.connectAlarm();
    try {
      alarm.send({ frame_type: 'null', counter: 60, account: String(fix.account) });
      await alarm.waitForRx(1);

      // Partition 7 is not in our config.
      alarm.send({
        frame_type: 'event',
        counter: 61,
        account: String(fix.account),
        type: 407,
        qualifier: 3,
        zone: 1,
        partition: 7,
      });

      await new Promise((r) => setTimeout(r, 300));

      // Existing partition 2 switch is unaffected.
      const acc = await findAccessoryByName(fix, 'E2E Partition');
      assert.notEqual(acc, undefined);

      const logs = fix.logs();
      const found = logs.includes('unconfigured partition 7');
      assert.ok(found, `expected log to mention unconfigured partition 7, got tail:\n${logs.split('\n').slice(-30).join('\n')}`);
    } finally {
      alarm.close();
    }
  });

  it('valid event still works after an unconfigured one', async () => {
    const alarm = await fix.connectAlarm();
    try {
      alarm.send({ frame_type: 'null', counter: 70, account: String(fix.account) });
      await alarm.waitForRx(1);

      // First, an unknown zone (should be ignored gracefully).
      alarm.send({
        frame_type: 'event',
        counter: 71,
        account: String(fix.account),
        type: 760,
        qualifier: 1,
        zone: 88,
        partition: 2,
      });
      // Then a valid zone event for our configured zone 3 (motion sensor).
      alarm.send({
        frame_type: 'event',
        counter: 72,
        account: String(fix.account),
        type: 760,
        qualifier: 1,
        zone: 3,
        partition: 2,
      });

      const acc = await waitForAccessoryState(fix, 'E2E Motion', (a) => Boolean(a.values.MotionDetected));
      assert.ok(Boolean(acc.values.MotionDetected));
    } finally {
      alarm.close();
    }
  });

  it('motion zone event flips MotionDetected true/false', async () => {
    const alarm = await fix.connectAlarm();
    try {
      alarm.send({ frame_type: 'null', counter: 80, account: String(fix.account) });
      await alarm.waitForRx(1);
      // Active
      alarm.send({ frame_type: 'event', counter: 81, account: String(fix.account), type: 760, qualifier: 1, zone: 3, partition: 2 });
      await waitForAccessoryState(fix, 'E2E Motion', (a) => Boolean(a.values.MotionDetected));
      // Restore
      alarm.send({ frame_type: 'event', counter: 82, account: String(fix.account), type: 760, qualifier: 3, zone: 3, partition: 2 });
      await waitForAccessoryState(fix, 'E2E Motion', (a) => !a.values.MotionDetected);
    } finally {
      alarm.close();
    }
  });

  it('leak zone event flips LeakDetected', async () => {
    const alarm = await fix.connectAlarm();
    try {
      alarm.send({ frame_type: 'null', counter: 90, account: String(fix.account) });
      await alarm.waitForRx(1);
      alarm.send({ frame_type: 'event', counter: 91, account: String(fix.account), type: 760, qualifier: 1, zone: 5, partition: 2 });
      // LeakDetected: 1 = LEAK_DETECTED, 0 = LEAK_NOT_DETECTED
      await waitForAccessoryState(fix, 'E2E Leak', (a) => a.values.LeakDetected === 1);
      alarm.send({ frame_type: 'event', counter: 92, account: String(fix.account), type: 760, qualifier: 3, zone: 5, partition: 2 });
      await waitForAccessoryState(fix, 'E2E Leak', (a) => a.values.LeakDetected === 0);
    } finally {
      alarm.close();
    }
  });

  it('smoke zone event flips SmokeDetected', async () => {
    const alarm = await fix.connectAlarm();
    try {
      alarm.send({ frame_type: 'null', counter: 100, account: String(fix.account) });
      await alarm.waitForRx(1);
      alarm.send({ frame_type: 'event', counter: 101, account: String(fix.account), type: 760, qualifier: 1, zone: 6, partition: 2 });
      await waitForAccessoryState(fix, 'E2E Smoke', (a) => a.values.SmokeDetected === 1);
      alarm.send({ frame_type: 'event', counter: 102, account: String(fix.account), type: 760, qualifier: 3, zone: 6, partition: 2 });
      await waitForAccessoryState(fix, 'E2E Smoke', (a) => a.values.SmokeDetected === 0);
    } finally {
      alarm.close();
    }
  });

  it('restricted partition advertises only DISARM and AWAY as valid targets', async () => {
    // The UI's accessory listing exposes the characteristic's `validValues`
    // (i.e. the values the picker offers in the Home app). For the partition
    // with armModes={away:true, stay:false, night:false} we expect just
    // DISARM (3) and AWAY_ARM (1).
    const partition = await findAccessoryByName(fix, 'E2E Restricted');
    const targetChar = partition.serviceCharacteristics.find(
      (c) => c.type === 'SecuritySystemTargetState',
    ) as { type: string; value: unknown; minValue?: number; maxValue?: number; validValues?: number[] } | undefined;
    assert.ok(targetChar, 'SecuritySystemTargetState characteristic missing');
    // Either explicit validValues or a tightened min/max range — HAP exposes
    // validValues, but some serializations also expose minValue/maxValue.
    const allowed = targetChar.validValues ?? [];
    if (allowed.length > 0) {
      assert.deepEqual(
        [...allowed].sort((a, b) => a - b),
        [1, 3],
        `expected validValues [AWAY=1, DISARM=3], got ${JSON.stringify(allowed)}`,
      );
    } else if (targetChar.minValue !== undefined && targetChar.maxValue !== undefined) {
      // Fallback: at minimum, the range should not include STAY=0.
      assert.ok(targetChar.minValue >= 1, `expected minValue >= 1, got ${targetChar.minValue}`);
    } else {
      assert.fail('characteristic exposed neither validValues nor min/max — cannot verify restriction');
    }
  });

  it('disabled mode SET on restricted partition does not send an arm OPERATION', async () => {
    const alarm = await fix.connectAlarm();
    try {
      alarm.send({ frame_type: 'null', counter: 200, account: String(fix.account) });
      await alarm.waitForRx(1);
      const before = alarm.received.length;

      const partition = await findAccessoryByName(fix, 'E2E Restricted');
      // STAY (0) is disabled. Try to SET it. HAP should reject (4xx/5xx) or
      // the platform's defense-in-depth check rejects. Either way, no
      // arm OPERATION should reach the panel.
      try {
        await fix.api('PUT', `/api/accessories/${partition.uniqueId}`, {
          characteristicType: 'SecuritySystemTargetState', value: 0, // STAY_ARM
        });
      } catch {
        // expected — error from HAP/platform is fine
      }

      await new Promise((r) => setTimeout(r, 300));
      const op = alarm.received.slice(before).find(
        (f) => f.frame_type === 'OPERATION' && (f.optype === 13 || f.optype === 14),
      );
      assert.equal(op, undefined, `disabled mode should not send Home1/Home2; got: ${JSON.stringify(op)}`);
    } finally {
      alarm.close();
    }
  });

  it('enabled mode SET on restricted partition still works (AWAY → optype 12)', async () => {
    const alarm = await fix.connectAlarm();
    try {
      alarm.send({ frame_type: 'null', counter: 210, account: String(fix.account) });
      await alarm.waitForRx(1);
      const before = alarm.received.length;

      const partition = await findAccessoryByName(fix, 'E2E Restricted');
      // Force DISARM first so the AWAY transition fires SET.
      await fix.api('PUT', `/api/accessories/${partition.uniqueId}`, {
        characteristicType: 'SecuritySystemTargetState', value: 3, // DISARM
      });
      await fix.api('PUT', `/api/accessories/${partition.uniqueId}`, {
        characteristicType: 'SecuritySystemTargetState', value: 1, // AWAY_ARM (enabled)
      });

      const deadline = Date.now() + 5000;
      let op: Record<string, unknown> | undefined;
      while (Date.now() < deadline) {
        op = alarm.received.slice(before).find((f) => f.frame_type === 'OPERATION' && f.optype === 12);
        if (op) break;
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      }
      assert.ok(op, `expected AWAY arm (optype=12) on restricted partition; got: ${JSON.stringify(alarm.received.slice(before))}`);
      assert.equal(op.partition, 3);
    } finally {
      alarm.close();
    }
  });

  it('UI SecuritySystem DISARM target sends disarm OPERATION (optype=17)', async () => {
    const alarm = await fix.connectAlarm();
    try {
      alarm.send({ frame_type: 'null', counter: 40, account: String(fix.account) });
      await alarm.waitForRx(1);

      const partition = await findAccessoryByName(fix, 'E2E Partition');
      // Force AWAY_ARM first so the DISARM transition actually triggers a SET.
      await fix.api('PUT', `/api/accessories/${partition.uniqueId}`, {
        characteristicType: 'SecuritySystemTargetState', value: 1, // AWAY_ARM
      });
      await new Promise((r) => setTimeout(r, 100));
      const since = alarm.received.length;
      await fix.api('PUT', `/api/accessories/${partition.uniqueId}`, {
        characteristicType: 'SecuritySystemTargetState', value: 3, // DISARM
      });

      const deadline = Date.now() + 5000;
      let op: Record<string, unknown> | undefined;
      while (Date.now() < deadline) {
        op = alarm.received.slice(since).find((f) => f.frame_type === 'OPERATION' && f.optype === 17);
        if (op) break;
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      }
      assert.ok(op, `no DISARM OPERATION received; got: ${JSON.stringify(alarm.received.slice(since))}`);
      assert.equal(op.optype, 17);
      assert.equal(op.partition, 2);
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
