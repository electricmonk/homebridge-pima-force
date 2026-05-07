#!/usr/bin/env node
/**
 * Interactive CLI around PimaDriver. Logs every event in a readable form
 * and accepts arm/disarm commands from stdin.
 *
 * Usage:
 *   PIMA_P1_CODE=xxxx PIMA_P2_CODE=yyyy npm run cli
 *
 * Optional env:
 *   PIMA_PORT (default 7780)  — TCP port the alarm dials in to
 *   PIMA_ACCOUNT (default 1234) — Account ID configured on the panel CMS path
 *
 * Stdin commands:
 *   arm <partition>
 *   disarm <partition>
 *   status
 *   quit
 */

import readline from 'node:readline';
import { PimaDriver } from './driver.js';
import type { PartitionConfig } from './types.js';

const PORT = Number(process.env.PIMA_PORT ?? 7780);
const ACCOUNT = Number(process.env.PIMA_ACCOUNT ?? 1234);

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

const driver = new PimaDriver({ port: PORT, account: ACCOUNT, partitions });

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

driver.on('system', ({ kind, ok, channel, partition }) => {
  log(`system: ${kind} channel ${channel} (partition ${partition}) → ${ok ? 'restored' : 'trouble'}`);
});

driver.on('unknown', (frame) => {
  log(`unknown frame: ${JSON.stringify(frame)}`);
});

driver.on('error', (err) => {
  log(`ERROR: ${err.message}`);
});

await driver.start();
log(`listening on 0.0.0.0:${PORT} | account=${ACCOUNT} | partitions=[${partitions.map(p => p.id).join(',')}]`);
log('Commands: arm <partition>, disarm <partition>, status, quit');

const rl = readline.createInterface({ input: process.stdin });

rl.on('line', async (line) => {
  const [cmd, ...rest] = line.trim().split(/\s+/);
  if (!cmd) return;
  try {
    if (cmd === 'arm' || cmd === 'disarm') {
      const partition = Number(rest[0]);
      if (!partition) return log(`usage: ${cmd} <partition>`);
      log(`>> ${cmd} partition ${partition}`);
      await driver[cmd](partition);
    } else if (cmd === 'status') {
      log(`connected=${driver.isConnected()}`);
    } else if (cmd === 'quit' || cmd === 'exit') {
      log('shutting down…');
      await driver.stop();
      process.exit(0);
    } else {
      log(`unknown command: ${cmd}`);
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
