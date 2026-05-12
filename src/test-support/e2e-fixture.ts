/**
 * Shared infrastructure for the e2e test suite (`src/e2e/*.test.ts`).
 *
 * `setupE2E()` boots a real Homebridge + homebridge-config-ui-x in a child
 * process with an isolated temp storage dir, listens for the plugin's TCP
 * port, and returns a fixture object exposing the UI's HTTP API surface.
 *
 * Tests pair the fixture with two domain drivers from the test-support
 * tree:
 *   - `connectAlarmSystem(fix)` — opens a fake-panel TCP client.
 *   - `homeBridgeFor(fix)` — wraps the UI's `/api/accessories` REST.
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { anAlarmSystem, type AlarmSystem } from './alarm-system.js';
import { homeBridge, type HomeBridge } from './homebridge.js';

const ROOT = process.cwd();
const HB_SERVICE_BIN = join(ROOT, 'node_modules/homebridge-config-ui-x/dist/bin/hb-service.js');
const STARTUP_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 50;

interface AuthResponse { access_token: string }

export interface E2EFixture {
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

export interface SetupE2EOptions {
  /** Pre-existing storage dir (used for restart scenarios). When omitted, a fresh dir is created. */
  storage?: string;
  /** Override for the PimaForce platform entry in config.json. Used to test legacy schemas. */
  pimaPlatformOverride?: Record<string, unknown>;
  /** When true, stop() preserves the storage dir on teardown (caller must clean up). */
  keepStorage?: boolean;
  /**
   * Whether to wait for the plugin's TCP server (alarm port) to bind during
   * setup. Defaults to true. Tests that expect the driver NOT to start —
   * e.g. when `partitions: []` — pass false; otherwise setup hangs.
   */
  expectAlarmPort?: boolean;
}

/**
 * Open an `alarmSystem` connection to the fixture's alarm port and, by
 * default, complete the verification handshake.
 */
export async function connectAlarmSystem(
  fix: E2EFixture,
  opts: { verify?: boolean } = {},
): Promise<AlarmSystem> {
  const alarm = anAlarmSystem({ port: fix.alarmPort, account: fix.account });
  await alarm.connect();
  if (opts.verify !== false) await alarm.verify();
  return alarm;
}

/** Build a `homeBridge` driver from the e2e fixture's UI port and auth token. */
export function homeBridgeFor(fix: E2EFixture): HomeBridge {
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

export async function setupE2E(opts: SetupE2EOptions = {}): Promise<E2EFixture> {
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
    if (opts.expectAlarmPort !== false) await waitForPort(alarmPort);
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
