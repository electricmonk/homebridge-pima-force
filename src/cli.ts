#!/usr/bin/env node
/**
 * Interactive CLI around PimaDriver. Logs every event in a readable form
 * and accepts arm/disarm/output commands from stdin.
 * Useful for development purposes.
 *
 * Usage:
 *   PIMA_P1_CODE=xxxx PIMA_P2_CODE=yyyy npm run cli
 *
 * Optional env:
 *   PIMA_PORT    (default 7780)  — TCP port the alarm dials in to
 *   PIMA_ACCOUNT (default 1234)  — Account ID configured on the panel CMS path
 *   PIMA_DEBUG   (1 to enable)   — log every wire frame in/out
 *   PIMA_ENCODING (default windows-1255) — text encoding for string values; use
 *                                   `windows-1255` for Hebrew zone names
 *   PIMA_REVERSE_STRINGS (1 to enable) — reverse string parameter order;
 *                                   use when Hebrew names come back visually flipped
 *
 * Stdin commands:
 *   arm <partition> [mode]   mode = away (default) | home1 | home2 | home3 | home4 | shabbat
 *   disarm <partition>
 *   output activate <N>      activate panel output N (1=ext siren, 2=int siren, 34-41=outputs 1-8)
 *   output deactivate <N>    de-activate panel output N
 *   siren on                 shortcut for `output activate 1`
 *   siren off                shortcut for `output deactivate 1`
 *   zones count              ask the panel how many zones are installed
 *   zones names [N [M]]      ask for zone names (default first 16; second arg = stop)
 *   req <id> <start> [stop] [pw]  raw DATA-REQ for any parameter id; pw overrides P1's user code
 *   discover <master-code>   onboarding flow: enumerate partitions + arm/disarm cycle to map zones
 *   debug on|off             toggle wire-frame logging at runtime
 *   status
 *   quit
 */

import readline from 'node:readline';
import { PimaDriver } from './driver.js';
import type { ArmMode, PartitionConfig } from './types.js';

const ARM_MODES: ArmMode[] = ['away', 'home1', 'home2', 'home3', 'home4', 'shabbat'];

const PORT = Number(process.env.PIMA_PORT ?? 7780);
const ACCOUNT = Number(process.env.PIMA_ACCOUNT ?? 1234);
const ENCODING = process.env.PIMA_ENCODING || 'windows-1255';
const REVERSE_STRINGS = process.env.PIMA_REVERSE_STRINGS === '1';
let debug = process.env.PIMA_DEBUG === '1';

const partitions: PartitionConfig[] = [];
for (const k of Object.keys(process.env)) {
  const m = k.match(/^PIMA_P(\d+)_CODE$/);
  if (m) partitions.push({ id: Number(m[1]), userCode: process.env[k]! });
}
partitions.sort((a, b) => a.id - b.id);

if (partitions.length === 0) {
  console.error('No partitions configured. Set PIMA_P1_CODE=xxxx (and/or PIMA_P2_CODE etc.)');
  process.exit(1);
}

function ts(): string {
  return new Date().toISOString().substring(11, 19); // HH:MM:SS
}

function log(msg: string): void {
  process.stdout.write(`[${ts()}] ${msg}\n`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface ZoneStatusBits {
  zone: number;
  armed: boolean;
  open: boolean;
  raw: number;
}

// Parse one entry of param 2149. Last byte = zone#, upper bytes = bitfield (LSB-indexed).
// Bit 10 = Armed, bit 11 = Open. See PROTOCOL.md "Zone Status bits (id 2149)".
function parseZoneStatusEntry(hex: string): ZoneStatusBits | null {
  if (hex.length < 2) return null;
  const zone = parseInt(hex.slice(-2), 16);
  if (!zone) return null;
  const upper = hex.length > 2 ? parseInt(hex.slice(0, -2), 16) : 0;
  return {
    zone,
    armed: (upper & (1 << 10)) !== 0,
    open: (upper & (1 << 11)) !== 0,
    raw: upper,
  };
}

function parseZoneStatus(parameters: string[]): Map<number, ZoneStatusBits> {
  const m = new Map<number, ZoneStatusBits>();
  for (const hex of parameters) {
    const e = parseZoneStatusEntry(hex);
    if (e) m.set(e.zone, e);
  }
  return m;
}

// Wait for a DATA event matching id+startOrder, or any NAK (which the panel
// often emits with counter=0 for parse failures, so we can't match it precisely).
function awaitData(id: number, startOrder: number, timeoutMs = 5000): Promise<{ parameters: string[]; more: boolean }> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer);
      driver.off('data', dataHandler);
      driver.off('nak', nakHandler);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timeout waiting for DATA id=${id} start=${startOrder}`));
    }, timeoutMs);
    const dataHandler = (msg: { id: number; startOrder: number; parameters: string[]; more: boolean }): void => {
      if (msg.id === id && msg.startOrder === startOrder) {
        cleanup();
        resolve({ parameters: msg.parameters, more: msg.more });
      }
    };
    const nakHandler = ({ counter, reason }: { counter?: number; reason: string }): void => {
      cleanup();
      reject(new Error(`NAK: ${reason} (counter=${counter ?? '?'})`));
    };
    driver.on('data', dataHandler);
    driver.on('nak', nakHandler);
  });
}

// Request a parameter and await the matching DATA response in one step.
async function reqAndAwait(
  id: number,
  startOrder: number,
  stopOrder: number | undefined,
  password: string,
): Promise<{ parameters: string[]; more: boolean }> {
  const wait = awaitData(id, startOrder);
  await driver.requestData({ id, startOrder, stopOrder, password });
  return wait;
}

async function discover(masterCode: string): Promise<void> {
  log(`>> discover: starting`);

  // 1) Zone count.
  const countRes = await reqAndAwait(2148, 1, 1, masterCode);
  const zoneCount = Number(countRes.parameters[0] ?? 0);
  if (!zoneCount) throw new Error('zone count returned empty/zero');
  log(`   installed zones: ${zoneCount}`);

  // 2) Zone names (paginated).
  const names = new Map<number, string>();
  let cursor = 1;
  while (cursor <= zoneCount) {
    const stop = Math.min(cursor + 15, zoneCount);
    const res = await reqAndAwait(260, cursor, stop, masterCode);
    res.parameters.forEach((name, i) => {
      const z = cursor + i;
      const trimmed = name.trim();
      if (trimmed) names.set(z, trimmed);
    });
    cursor = stop + 1;
  }
  log(`   collected ${names.size} non-empty zone names`);

  // 3) Enumerate partitions via 2310 (1=NotExist, 2=Disarmed, 3+=armed in some mode).
  const keyRes = await reqAndAwait(2310, 1, 16, masterCode);
  const existing: { partition: number; armed: boolean; state: number }[] = [];
  keyRes.parameters.forEach((s, i) => {
    const state = Number(s);
    if (state !== 1) existing.push({ partition: i + 1, armed: state >= 3, state });
  });
  if (existing.length === 0) throw new Error('no partitions found via 2310 — is the master code correct?');
  log(`   partitions: ${existing.map((p) => `P${p.partition}(${p.armed ? `armed/state=${p.state}` : 'disarmed'})`).join(', ')}`);

  // 4) For each partition: snapshot 2149 with its user code (or master if not configured),
  //    arm-then-disarm if disarmed, and deduce zone membership.
  const zoneToPartition = new Map<number, number>();

  for (const p of existing) {
    const partCfg = partitions.find((cfg) => cfg.id === p.partition);
    const code = partCfg?.userCode ?? masterCode;
    const codeLabel = partCfg ? `P${p.partition} code` : 'master code';

    log(`-- P${p.partition} (using ${codeLabel}) --`);
    const before = parseZoneStatus((await reqAndAwait(2149, 1, 144, code)).parameters);
    const beforeZones = [...before.keys()].sort((a, b) => a - b);
    log(`   before: zones [${beforeZones.join(',')}] (${beforeZones.length})`);

    // Safety: any zone currently Open means arming would trip it past the exit delay.
    // For 24h zones, "Open" means active right now (smoke detector firing) — also a hard abort.
    const openZones = [...before.values()].filter((z) => z.open).map((z) => z.zone);
    if (!p.armed && openZones.length > 0) {
      log(`   ! P${p.partition}: ${openZones.length} zone(s) currently OPEN (${openZones.join(',')}) — skipping arm cycle`);
      beforeZones.forEach((z) => zoneToPartition.set(z, p.partition));
      continue;
    }

    if (p.armed) {
      // Already armed — `before` already contains all zones on this partition.
      log(`   P${p.partition} already armed; using current snapshot`);
      beforeZones.forEach((z) => zoneToPartition.set(z, p.partition));
      continue;
    }

    // Arm AWAY → snapshot → disarm. `try/finally` ensures disarm runs.
    log(`   P${p.partition}: arming AWAY...`);
    try {
      await driver.arm(p.partition, 'away');
      await sleep(500); // give the panel a beat to flip Armed bits
      const during = parseZoneStatus((await reqAndAwait(2149, 1, 144, code)).parameters);
      const duringZones = [...during.keys()].sort((a, b) => a - b);
      log(`   armed:  zones [${duringZones.join(',')}] (${duringZones.length})`);
      duringZones.forEach((z) => zoneToPartition.set(z, p.partition));
      beforeZones.forEach((z) => zoneToPartition.set(z, p.partition));
    } finally {
      log(`   P${p.partition}: disarming...`);
      await driver.disarm(p.partition).catch((e) => log(`   ! disarm failed: ${(e as Error).message}`));
      // Brief pause so the next iteration's DATA-REQ doesn't race the panel's
      // ACK of our disarm OPERATION (panel NAKs back-to-back coalesced frames).
      await sleep(500);
    }
  }

  // 5) Print final map.
  log('=== Discovery result ===');
  for (let z = 1; z <= zoneCount; z++) {
    const part = zoneToPartition.get(z);
    const name = names.get(z) ?? '(unnamed)';
    log(`   zone ${String(z).padStart(3)}  P${part ?? '?'}  ${name}`);
  }
  const unmapped = Array.from({ length: zoneCount }, (_, i) => i + 1).filter((z) => !zoneToPartition.has(z));
  if (unmapped.length) {
    log(`   ! ${unmapped.length} zones unmapped: ${unmapped.join(',')} — likely non-24h zones on a partition that we couldn't safely arm (open zones, or no per-partition code)`);
  }
}

const driver = new PimaDriver({
  port: PORT,
  account: ACCOUNT,
  partitions,
  encoding: ENCODING,
  reverseStrings: REVERSE_STRINGS,
});

driver.on('connected',    () => log('CONNECTED — alarm dialed in'));
driver.on('disconnected', () => log('DISCONNECTED'));

driver.on('zone', ({ zone, partition, active }) => {
  log(`zone ${zone} (partition ${partition}) → ${active ? 'ACTIVE' : 'restored'}`);
});

driver.on('arm', ({ partition, source }) => {
  log(`ARMED   partition ${partition} (source: ${source})`);
});

driver.on('disarm', ({ partition, source }) => {
  log(`DISARMED partition ${partition} (source: ${source})`);
});

driver.on('output', ({ output, partition, active }) => {
  log(`output ${output} (partition ${partition}) → ${active ? 'ACTIVE' : 'inactive'}`);
});

driver.on('data', ({ id, startOrder, parameters, more }) => {
  // Pretty-print the responses we know about; fall back to raw JSON otherwise.
  if (id === 260) {
    // Zone names — useful for plugin config bootstrap. Skip empty slots.
    log(`zone names ${startOrder}..${startOrder + parameters.length - 1}${more ? ' (more)' : ''}:`);
    parameters.forEach((name, i) => {
      const zone = startOrder + i;
      const trimmed = name.trim();
      if (trimmed) log(`  zone ${zone}: ${trimmed}`);
    });
    if (more) log(`  (more available — request again with start_order=${startOrder + parameters.length})`);
    return;
  }
  if (id === 2148) {
    log(`installed zone count: ${parameters[0] ?? '(empty)'}`);
    return;
  }
  log(`DATA id=${id} start=${startOrder}${more ? ' (more)' : ''} parameters=${JSON.stringify(parameters)}`);
});

driver.on('alarm', ({ zone, partition, active }) => {
  log(`ALARM ${active ? 'TRIGGERED' : 'restored'} partition ${partition} (zone ${zone})`);
});

driver.on('system', ({ kind, ok, channel, partition }) => {
  log(`system: ${kind} channel ${channel} (partition ${partition}) → ${ok ? 'restored' : 'trouble'}`);
});

driver.on('nak', ({ counter, account, reason }) => {
  log(`NAK (counter=${counter}, account=${account}): ${reason}`);
});

driver.on('unknown', (frame) => {
  log(`unknown frame: ${JSON.stringify(frame)}`);
});

driver.on('error', (err) => {
  log(`ERROR: ${err.message}`);
});

function redact(frame: Record<string, unknown>): Record<string, unknown> {
  return frame.password === undefined ? frame : { ...frame, password: '***' };
}

driver.on('frameIn', (frame) => {
  if (debug) log(`<< ${JSON.stringify(frame)}`);
});
driver.on('frameOut', (frame) => {
  if (debug) log(`>> ${JSON.stringify(redact(frame))}`);
});

await driver.start();
log(`listening on 0.0.0.0:${PORT} | account=${ACCOUNT} | encoding=${ENCODING}${REVERSE_STRINGS ? ' (reversed)' : ''} | partitions=[${partitions.map(p => p.id).join(',')}]${debug ? ' | DEBUG' : ''}`);
log('Commands: arm <partition> [mode] | disarm <partition> | output activate|deactivate <N> | siren on|off | zones count|names [start [stop]] | req <id> <start> [stop] | debug on|off | status | quit');

const rl = readline.createInterface({ input: process.stdin });

rl.on('line', async (line) => {
  const [cmd, ...rest] = line.trim().split(/\s+/);
  if (!cmd) return;
  try {
    switch (cmd) {
      case 'arm': {
        const partition = Number(rest[0]);
        if (!partition) return log(`usage: arm <partition> [mode]; mode = ${ARM_MODES.join('|')}`);
        const mode = (rest[1] ?? 'away') as ArmMode;
        if (!ARM_MODES.includes(mode)) return log(`unknown mode: ${mode}; use ${ARM_MODES.join('|')}`);
        log(`>> arm partition ${partition} (${mode})`);
        await driver.arm(partition, mode);
        return;
      }
      case 'disarm': {
        const partition = Number(rest[0]);
        if (!partition) return log('usage: disarm <partition>');
        log(`>> disarm partition ${partition}`);
        await driver.disarm(partition);
        return;
      }
      case 'output': {
        const action = rest[0];
        const output = Number(rest[1]);
        if (!output || (action !== 'activate' && action !== 'deactivate')) {
          return log('usage: output activate|deactivate <N>  (1=ext siren, 2=int siren, 34-41=outputs 1-8)');
        }
        log(`>> ${action} output ${output}`);
        await driver.setOutput(output, action === 'activate');
        return;
      }
      case 'siren': {
        const action = rest[0];
        if (action !== 'on' && action !== 'off') return log('usage: siren on|off');
        log(`>> siren ${action} (${action === 'on' ? 'activate' : 'deactivate'} output 1)`);
        await driver.setOutput(1, action === 'on');
        return;
      }
      case 'zones': {
        const action = rest[0];
        if (action === 'count') {
          log('>> request installed zone count');
          await driver.getZoneCount();
          return;
        }
        if (action === 'names') {
          const start = Number(rest[1] ?? 1);
          const stop = rest[2] !== undefined ? Number(rest[2]) : start + 15;
          if (!start || !stop || stop < start) {
            return log('usage: zones names [start [stop]]; start, stop are 1-indexed zone numbers (1-144)');
          }
          log(`>> request zone names ${start}..${stop}`);
          await driver.getZoneNames(start, stop);
          return;
        }
        return log('usage: zones count | zones names [start [stop]]');
      }
      case 'req': {
        const id = Number(rest[0]);
        const start = Number(rest[1] ?? 1);
        // Optional 3rd arg may be `stop` (number) or `pw` (string) when stop is omitted.
        // Optional 4th arg is always `pw` (overrides the configured user code).
        let stop: number | undefined;
        let pw: string | undefined;
        if (rest[2] !== undefined) {
          if (/^\d+$/.test(rest[2])) stop = Number(rest[2]);
          else pw = rest[2];
        }
        if (rest[3] !== undefined) pw = rest[3];
        if (!id || !start || (stop !== undefined && stop < start)) {
          return log('usage: req <id> <start> [stop] [pw]  — raw DATA-REQ; pw overrides the configured user code');
        }
        log(`>> DATA-REQ id=${id} start=${start}${stop !== undefined ? ` stop=${stop}` : ''}${pw ? ` pw=***` : ''}`);
        await driver.requestData({ id, startOrder: start, stopOrder: stop, password: pw });
        return;
      }
      case 'discover': {
        const code = rest[0];
        if (!code) return log('usage: discover <master-code>  — orchestrates names + partition enumeration + arm/disarm cycle');
        try {
          await discover(code);
        } catch (e) {
          log(`discover failed: ${(e as Error).message}`);
        }
        return;
      }
      case 'debug': {
        if (rest[0] === 'on') { debug = true; log('debug ON'); }
        else if (rest[0] === 'off') { debug = false; log('debug OFF'); }
        else log('usage: debug on|off');
        return;
      }
      case 'status': {
        log(`connected=${driver.isConnected()} debug=${debug}`);
        return;
      }
      case 'quit':
      case 'exit': {
        log('shutting down…');
        await driver.stop();
        process.exit(0);
      }
      // eslint-disable-next-line no-fallthrough
      default: {
        log(`unknown command: ${cmd}`);
      }
    }
  } catch (err) {
    log(`command failed: ${(err as Error).message}`);
  }
});

process.on('SIGINT', async () => {
  log('SIGINT — shutting down…');
  await driver.stop();
  process.exit(0);
});
