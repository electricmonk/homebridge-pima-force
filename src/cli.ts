#!/usr/bin/env node
/**
 * Interactive CLI around PimaDriver. Logs every event in a readable form
 * and accepts arm/disarm/output commands from stdin.
 *
 * Usage:
 *   PIMA_P1_CODE=xxxx PIMA_P2_CODE=yyyy npm run cli
 *
 * Optional env:
 *   PIMA_PORT    (default 7780)  — TCP port the alarm dials in to
 *   PIMA_ACCOUNT (default 1234)  — Account ID configured on the panel CMS path
 *   PIMA_DEBUG   (1 to enable)   — log every wire frame in/out
 *
 * Stdin commands:
 *   arm <partition> [mode]   mode = away (default) | home1 | home2 | home3 | home4 | shabbat
 *   disarm <partition>
 *   output activate <N>      activate panel output N (1=ext siren, 2=int siren, 34-41=outputs 1-8)
 *   output deactivate <N>    de-activate panel output N
 *   siren on                 shortcut for `output activate 1`
 *   siren off                shortcut for `output deactivate 1`
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

driver.on('output', ({ output, partition, active }) => {
  log(`output ${output} (partition ${partition}) → ${active ? 'ACTIVE' : 'inactive'}`);
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
log(`listening on 0.0.0.0:${PORT} | account=${ACCOUNT} | partitions=[${partitions.map(p => p.id).join(',')}]${debug ? ' | DEBUG' : ''}`);
log('Commands: arm <partition> [mode] | disarm <partition> | output activate|deactivate <N> | siren on|off | debug on|off | status | quit');

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
