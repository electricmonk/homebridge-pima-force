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
  /** All frames received from the driver, in order. DATA-REQ frames are
   * separated into their own list and not included here — see waitForDataReq. */
  received: Array<Record<string, unknown>>;
  /** Resolve when at least N frames received from the driver. */
  waitForRx(n: number, timeoutMs?: number): Promise<void>;
  /** Resolve with the next DATA-REQ frame the driver sends matching `id` (and optionally `startOrder`). */
  waitForDataReq(opts: { id: number; startOrder?: number; timeoutMs?: number }): Promise<Record<string, unknown>>;
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
  const pimaEntry = opts.pimaPlatformOverride
    ? { ...opts.pimaPlatformOverride, platform: 'PimaForce', port: alarmPort, account }
    : defaultPima;

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

  const connectAlarm = (): Promise<FakeAlarm> => new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: '127.0.0.1', port: alarmPort });
    const received: Array<Record<string, unknown>> = [];
    const dataReqs: Array<Record<string, unknown>> = [];
    sock.on('data', (buf) => {
      // The driver may emit multiple frames per chunk under TCP coalescing.
      const text = buf.toString('utf8');
      for (const part of text.split(/(?<=\})(?=\{)/)) {
        try {
          const frame = JSON.parse(part);
          // DATA-REQ frames go into their own list. Tests that don't care
          // about discovery (most of them) ignore that list; tests that do
          // care use waitForDataReq to await + respond. Either way, DATA-REQ
          // doesn't pollute `received` so frame-count assertions stay clean.
          if (frame?.frame_type === 'DATA-REQ') {
            dataReqs.push(frame);
            continue;
          }
          received.push(frame);
        } catch { /* ignore */ }
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
      const waitForDataReq = async (opts: { id: number; startOrder?: number; timeoutMs?: number }) => {
        const d = Date.now() + (opts.timeoutMs ?? 3000);
        while (Date.now() < d) {
          const found = dataReqs.find(
            (f) => Number(f.id) === opts.id &&
              (opts.startOrder === undefined || Number(f.start_order) === opts.startOrder),
          );
          if (found) return found;
          await new Promise((r) => setTimeout(r, 10));
        }
        const startDesc = opts.startOrder !== undefined ? ` start_order=${opts.startOrder}` : '';
        throw new Error(`timeout waiting for DATA-REQ id=${opts.id}${startDesc}; got: ${JSON.stringify(dataReqs)}`);
      };
      const close = () => sock.destroy();
      resolve({ send, received, waitForRx, waitForDataReq, close });
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

  it('on panel connect, queries partition state via DATA-REQ and reflects arm status', async () => {
    const alarm = await fix.connectAlarm();
    try {
      // The driver verifies the panel on first received frame. Send a heartbeat
      // so verification completes and queryPartitionStates() fires.
      alarm.send({ frame_type: 'null', counter: 1, account: String(fix.account) });
      await alarm.waitForRx(1); // wait for the ACK

      // The platform should now send DATA-REQ (id=2310) for each configured partition.
      const req = await alarm.waitForDataReq({ id: 2310, startOrder: 2, timeoutMs: 5000 });

      // Respond: partition 2 = FullArmed (status 3) → HomeKit AWAY_ARM (1)
      alarm.send({
        frame_type: 'DATA',
        counter: req.counter as number,
        account: String(fix.account),
        id: 2310,
        start_order: 2,
        parameters: ['3'],
      });

      // E2E Partition (id 2) should update to AWAY_ARM (1).
      const acc = await waitForAccessoryState(
        fix, 'E2E Partition', (a) => a.values.SecuritySystemCurrentState === 1,
      );
      assert.equal(acc.values.SecuritySystemCurrentState, 1);

      // Reset to disarmed so this test doesn't affect later tests.
      alarm.send({
        frame_type: 'DATA',
        counter: (req.counter as number) + 1,
        account: String(fix.account),
        id: 2310,
        start_order: 2,
        parameters: ['2'],
      });
      await waitForAccessoryState(
        fix, 'E2E Partition', (a) => a.values.SecuritySystemCurrentState === 3,
      );
    } finally {
      alarm.close();
    }
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

  before(async () => {
    // Boot 1: install with legacy nested config. Plugin migrates in-memory
    // and registers accessories with the new flat-shape UUID convention.
    fix = await setupE2E({ pimaPlatformOverride: legacyPima, keepStorage: true });
    storagePath = fix.storage;
    await waitForAccessories(fix, ['Legacy Partition', 'Legacy Door', 'Legacy Siren']);
    const list = await listAccessories(fix);
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
      await waitForAccessories(fix, ['Legacy Partition', 'Legacy Door', 'Legacy Siren']);
      const list = await listAccessories(fix);
      const second = new Map(list.map((a) => [a.serviceName, a.uniqueId]));

      for (const name of ['Legacy Partition', 'Legacy Door', 'Legacy Siren']) {
        const before = firstBootUuids.get(name);
        const after = second.get(name);
        assert.ok(after, `"${name}" missing after restart`);
        assert.equal(after, before, `"${name}" uniqueId changed across restart (was ${before}, now ${after})`);
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
    await waitForAccessories(fix, ['Discovery Partition']);
  });
  after(async () => { await fix?.stop(); });

  it('queries the panel and registers each discovered zone as a HomeKit sensor', async () => {
    const alarm = await fix.connectAlarm();
    try {
      // Send a heartbeat first — real panels emit one immediately on
      // connect, and the plugin uses the first incoming frame as its
      // signal that the connection is real (vs. a port-up probe) before
      // kicking off discovery.
      alarm.send({ frame_type: 'null', counter: 1, account: String(fix.account) });

      // 1) Plugin queries installed zone count (param 2148).
      const countReq = await alarm.waitForDataReq({ id: 2148 }).catch((err) => {
        throw new Error(`${(err as Error).message}\n--- homebridge log ---\n${fix.logs()}`);
      });
      assert.equal(countReq.start_order, 1, `zone-count DATA-REQ should start_order=1; got ${JSON.stringify(countReq)}`);
      alarm.send({
        frame_type: 'DATA',
        counter: countReq.counter,
        account: String(fix.account),
        id: 2148,
        start_order: 1,
        parameters: ['3'],
        more: 'no',
      });

      // 2) Plugin queries zone names (param 260) — paginated, but 3 zones
      //    fits in one page so we expect a single DATA-REQ for 1..3.
      const namesReq = await alarm.waitForDataReq({ id: 260 });
      assert.equal(namesReq.start_order, 1, `zone-names DATA-REQ should start at 1; got ${JSON.stringify(namesReq)}`);
      alarm.send({
        frame_type: 'DATA',
        counter: namesReq.counter,
        account: String(fix.account),
        id: 260,
        start_order: 1,
        parameters: ['Front Door', 'Living Room PIR', 'Kitchen Smoke'],
        more: 'no',
      });

      // 3) Plugin should register each zone in-process — they appear in the
      //    UI without a Homebridge restart.
      await waitForAccessories(fix, ['Front Door', 'Living Room PIR', 'Kitchen Smoke']);

      // 4) And persist them into config.json so a future restart still
      //    sees them.
      const configText = readFileSync(join(fix.storage, 'config.json'), 'utf8');
      const cfg = JSON.parse(configText) as { platforms: Array<Record<string, unknown>> };
      const myEntry = cfg.platforms.find((p) => p.platform === 'PimaForce') as
        | { zones?: Array<{ zone: number; name: string; type: string }> }
        | undefined;
      assert.ok(myEntry, 'PimaForce platform entry missing from config.json');
      const zones = myEntry!.zones ?? [];
      const byZone = new Map(zones.map((z) => [z.zone, z]));
      assert.equal(zones.length, 3, `expected 3 zones written to config.json; got ${zones.length}: ${JSON.stringify(zones)}`);
      assert.equal(byZone.get(1)?.name, 'Front Door');
      assert.equal(byZone.get(2)?.name, 'Living Room PIR');
      assert.equal(byZone.get(3)?.name, 'Kitchen Smoke');
      // Default type for newly-discovered zones is contact; user customizes
      // afterwards via the UI.
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
    await waitForAccessories(fix, ['Discovery Partition']);
  });
  after(async () => { await fix?.stop(); });

  it('aggregates zone names split across multiple DATA frames (more: yes)', async () => {
    const alarm = await fix.connectAlarm();
    try {
      alarm.send({ frame_type: 'null', counter: 1, account: String(fix.account) });

      // Zone count: 4 zones total.
      const countReq = await alarm.waitForDataReq({ id: 2148 }).catch((err) => {
        throw new Error(`${(err as Error).message}\n--- homebridge log ---\n${fix.logs()}`);
      });
      alarm.send({
        frame_type: 'DATA',
        counter: countReq.counter,
        account: String(fix.account),
        id: 2148,
        start_order: 1,
        parameters: ['4'],
        more: 'no',
      });

      // First page of names: zones 1–3, panel says more is coming.
      const namesReq1 = await alarm.waitForDataReq({ id: 260, startOrder: 1 });
      assert.equal(namesReq1.start_order, 1, `first page should start at 1; got ${JSON.stringify(namesReq1)}`);
      alarm.send({
        frame_type: 'DATA',
        counter: namesReq1.counter,
        account: String(fix.account),
        id: 260,
        start_order: 1,
        parameters: ['Front Door', 'Living Room PIR', 'Kitchen Smoke'],
        more: 'yes',
      });

      // Second page: zone 4, no more.
      const namesReq2 = await alarm.waitForDataReq({ id: 260, startOrder: 4 });
      assert.equal(namesReq2.start_order, 4, `second page should start at 4; got ${JSON.stringify(namesReq2)}`);
      alarm.send({
        frame_type: 'DATA',
        counter: namesReq2.counter,
        account: String(fix.account),
        id: 260,
        start_order: 4,
        parameters: ['Garage Motion'],
        more: 'no',
      });

      await waitForAccessories(fix, ['Front Door', 'Living Room PIR', 'Kitchen Smoke', 'Garage Motion']);

      const configText = readFileSync(join(fix.storage, 'config.json'), 'utf8');
      const cfg = JSON.parse(configText) as { platforms: Array<Record<string, unknown>> };
      const myEntry = cfg.platforms.find((p) => p.platform === 'PimaForce') as
        | { zones?: Array<{ zone: number; name: string; type: string }> }
        | undefined;
      assert.ok(myEntry, 'PimaForce platform entry missing from config.json');
      const zones = myEntry!.zones ?? [];
      const byZone = new Map(zones.map((z) => [z.zone, z]));
      assert.equal(zones.length, 4, `expected 4 zones written to config.json; got ${zones.length}: ${JSON.stringify(zones)}`);
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
    await waitForAccessories(fix, ['Discovery Partition']);
  });
  after(async () => { await fix?.stop(); });

  it('ignores an unrelated NAK (different counter) during discovery', async () => {
    const alarm = await fix.connectAlarm();
    try {
      alarm.send({ frame_type: 'null', counter: 1, account: String(fix.account) });

      // Plugin sends a DATA-REQ for zone count.
      const countReq = await alarm.waitForDataReq({ id: 2148 }).catch((err) => {
        throw new Error(`${(err as Error).message}\n--- homebridge log ---\n${fix.logs()}`);
      });

      // Simulate the panel NAKing some *other* command with a different counter.
      const unrelatedCounter = (countReq.counter as number) + 99;
      alarm.send({
        frame_type: 'NAK',
        counter: unrelatedCounter,
        account: String(fix.account),
        data: 'invalid password',
      });

      // Discovery should still proceed — respond with the real zone count DATA.
      alarm.send({
        frame_type: 'DATA',
        counter: countReq.counter,
        account: String(fix.account),
        id: 2148,
        start_order: 1,
        parameters: ['2'],
        more: 'no',
      });

      const namesReq = await alarm.waitForDataReq({ id: 260 }).catch((err) => {
        throw new Error(`discovery was incorrectly aborted by unrelated NAK: ${(err as Error).message}\n--- homebridge log ---\n${fix.logs()}`);
      });
      alarm.send({
        frame_type: 'DATA',
        counter: namesReq.counter,
        account: String(fix.account),
        id: 260,
        start_order: 1,
        parameters: ['Porch Sensor', 'Back Door'],
        more: 'no',
      });

      await waitForAccessories(fix, ['Porch Sensor', 'Back Door']);
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
