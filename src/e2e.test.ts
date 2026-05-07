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
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
        partitions: [
          {
            id: 2,
            name: 'E2E Partition',
            userCode: '0000',
            zones: [
              { zone: 3, name: 'E2E Motion' },
              { zone: 4, name: 'E2E Door' },
            ],
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

  return { uiPort, alarmPort, account, storage, token, api, connectAlarm, stop };
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
    await waitForAccessories(fix, ['E2E Partition', 'E2E Motion', 'E2E Door']);
  });
  after(async () => { await fix?.stop(); });

  it('all configured accessories appear in the UI', async () => {
    const list = await listAccessories(fix);
    const names = new Set(list.map((a) => a.serviceName));
    for (const expected of ['E2E Partition', 'E2E Motion', 'E2E Door']) {
      assert.ok(names.has(expected), `expected accessory "${expected}" in ${[...names].join(', ')}`);
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

  it('panel ARM event flips partition Switch to On', async () => {
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
      // HAP transports booleans as 0/1; treat both representations as truthy.
      const acc = await waitForAccessoryState(fix, 'E2E Partition', (a) => Boolean(a.values.On));
      assert.ok(Boolean(acc.values.On), `expected On to be truthy, got ${JSON.stringify(acc.values.On)}`);
    } finally {
      alarm.close();
    }
  });

  it('UI Switch toggle ON sends OPERATION arm to panel', async () => {
    const alarm = await fix.connectAlarm();
    try {
      alarm.send({ frame_type: 'null', counter: 30, account: String(fix.account) });
      await alarm.waitForRx(1);
      const before = alarm.received.length;

      const partition = await findAccessoryByName(fix, 'E2E Partition');
      // Toggle to OFF first to ensure the SET handler actually fires (it skips if equal).
      // Then toggle ON.
      await fix.api('PUT', `/api/accessories/${partition.uniqueId}`, { characteristicType: 'On', value: false });
      await fix.api('PUT', `/api/accessories/${partition.uniqueId}`, { characteristicType: 'On', value: true });

      // Wait for an OPERATION frame to arrive at the fake alarm.
      const deadline = Date.now() + 5000;
      let op: Record<string, unknown> | undefined;
      while (Date.now() < deadline) {
        op = alarm.received.slice(before).find((f) => f.frame_type === 'OPERATION' && f.optype === 12);
        if (op) break;
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      }
      assert.ok(op, `no ARM OPERATION received; got: ${JSON.stringify(alarm.received.slice(before))}`);
      assert.equal(op.optype, 12);
      assert.equal(op.partition, 2);
      assert.equal(op.password, '0000');
      assert.equal(op.account, fix.account);
    } finally {
      alarm.close();
    }
  });

  it('UI Switch toggle OFF sends OPERATION disarm to panel', async () => {
    const alarm = await fix.connectAlarm();
    try {
      alarm.send({ frame_type: 'null', counter: 40, account: String(fix.account) });
      await alarm.waitForRx(1);
      const before = alarm.received.length;

      const partition = await findAccessoryByName(fix, 'E2E Partition');
      // Force ON first so the OFF transition actually triggers a SET (handler short-circuits if equal).
      await fix.api('PUT', `/api/accessories/${partition.uniqueId}`, { characteristicType: 'On', value: true });
      // The toggle-on sent an arm; clear our slate then send the disarm.
      await new Promise((r) => setTimeout(r, 100));
      const since = alarm.received.length;
      await fix.api('PUT', `/api/accessories/${partition.uniqueId}`, { characteristicType: 'On', value: false });

      const deadline = Date.now() + 5000;
      let op: Record<string, unknown> | undefined;
      while (Date.now() < deadline) {
        op = alarm.received.slice(since).find((f) => f.frame_type === 'OPERATION' && f.optype === 17);
        if (op) break;
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      }
      assert.ok(op, `no DISARM OPERATION received; got: ${JSON.stringify(alarm.received.slice(before))}`);
      assert.equal(op.optype, 17);
      assert.equal(op.partition, 2);
    } finally {
      alarm.close();
    }
  });
});
