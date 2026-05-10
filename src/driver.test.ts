import { strict as assert } from 'node:assert';
import { once } from 'node:events';
import net from 'node:net';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { PimaDriver } from './driver.js';

/**
 * Integration tests: spin up the driver on a random port, dial in with a
 * raw TCP socket as the "fake alarm", and assert end-to-end behavior.
 */

interface Harness {
  driver: PimaDriver;
  port: number;
  alarm: net.Socket;
  /** Frames received by the fake alarm from the driver, parsed as JSON. */
  rxFromDriver: Array<Record<string, unknown>>;
}

async function setupConnected(): Promise<Harness> {
  const driver = new PimaDriver({
    port: 0, // random
    account: 1234,
    partitions: [
      { id: 1, userCode: '1111' },
      { id: 2, userCode: '2222' },
    ],
    opCounterStart: 5000,
  });
  await driver.start();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const addr = ((driver as any).server as net.Server).address() as net.AddressInfo;

  // Subscribe BEFORE initiating the connection — otherwise we can race the
  // server's 'connection' handler and miss the synchronous 'connected' emit.
  const connected = once(driver, 'connected');

  const alarm = net.createConnection({ host: '127.0.0.1', port: addr.port });
  const rxFromDriver: Array<Record<string, unknown>> = [];
  alarm.on('data', (buf) => {
    // TCP may deliver back-to-back writes as one chunk; split at JSON boundaries.
    const text = buf.toString('utf8');
    for (const part of text.split(/(?<=\})(?=\{)/)) {
      try {
        rxFromDriver.push(JSON.parse(part));
      } catch {
        // ignore
      }
    }
  });

  await connected;
  return { driver, port: addr.port, alarm, rxFromDriver };
}

async function teardown(h: Harness | null): Promise<void> {
  if (!h) return;
  h.alarm.destroy();
  await h.driver.stop();
}

/**
 * Wait until the fake alarm has received at least `count` frames from the
 * driver. setImmediate is not enough — the bytes have to round-trip through
 * the kernel even on localhost.
 */
async function waitForRx(h: Harness, count: number, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (h.rxFromDriver.length < count) {
    if (Date.now() > deadline) {
      throw new Error(`timeout waiting for ${count} frames; got ${h.rxFromDriver.length}`);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('PimaDriver — connection lifecycle', () => {
  let h: Harness | null = null;
  beforeEach(async () => { h = await setupConnected(); });
  afterEach(async () => { await teardown(h); h = null; });

  it('emits connected when the alarm dials in', () => {
    assert.equal(h!.driver.isConnected(), true);
  });

  it('emits verified after first frame with matching account', async () => {
    const verified = once(h!.driver, 'verified');
    h!.alarm.write('{"frame_type":"null","counter":1,"account":"1234"}');
    await verified;
  });

  it('closes connection if first frame has wrong account', async () => {
    const errEvt = once(h!.driver, 'error');
    h!.alarm.write('{"frame_type":"null","counter":1,"account":"9999"}');
    const [err] = await errEvt;
    assert.match((err as Error).message, /9999/);
    // Socket should be destroyed.
    await new Promise<void>((resolve) => {
      if (h!.alarm.destroyed) return resolve();
      h!.alarm.once('close', () => resolve());
    });
    assert.equal(h!.alarm.destroyed, true);
  });

  it('emits disconnected when the alarm drops', async () => {
    const off = once(h!.driver, 'disconnected');
    h!.alarm.destroy();
    await off;
    assert.equal(h!.driver.isConnected(), false);
  });
});

describe('PimaDriver — receive side', () => {
  let h: Harness | null = null;
  beforeEach(async () => { h = await setupConnected(); });
  afterEach(async () => { await teardown(h); h = null; });

  it('ACKs a null heartbeat', async () => {
    h!.alarm.write('{"frame_type":"null","counter":7,"account":"1234"}');
    await waitForRx(h!, 1);
    assert.deepEqual(h!.rxFromDriver[0], {
      account: 1234,
      counter: 7,
      frame_type: 'ACK',
      kc: 1,
    });
  });

  it('does NOT ACK a NAK (would feedback-loop)', async () => {
    h!.alarm.write('{"frame_type":"NAK","counter":0,"account":"1234","data":"JSON frame"}');
    // Give it a moment to NOT respond.
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(h!.rxFromDriver.length, 0);
  });

  it('emits zone active=true when type=760 qualifier=1', async () => {
    const off = once(h!.driver, 'zone');
    h!.alarm.write('{"frame_type":"event","counter":50,"account":"1234","type":760,"qualifier":1,"zone":4,"partition":2}');
    const [event] = await off;
    assert.deepEqual(event, { zone: 4, partition: 2, active: true });
  });

  it('emits zone active=false when type=760 qualifier=3', async () => {
    const off = once(h!.driver, 'zone');
    h!.alarm.write('{"frame_type":"event","counter":51,"account":"1234","type":760,"qualifier":3,"zone":4,"partition":2}');
    const [event] = await off;
    assert.deepEqual(event, { zone: 4, partition: 2, active: false });
  });

  it('emits arm with source=remote when type=407 qualifier=3', async () => {
    const off = once(h!.driver, 'arm');
    h!.alarm.write('{"frame_type":"event","counter":53,"account":"1234","type":407,"qualifier":3,"zone":2,"partition":2}');
    const [event] = await off;
    assert.deepEqual(event, { partition: 2, source: 'remote' });
  });

  it('emits disarm with source=remote when type=407 qualifier=1', async () => {
    const off = once(h!.driver, 'disarm');
    h!.alarm.write('{"frame_type":"event","counter":55,"account":"1234","type":407,"qualifier":1,"zone":2,"partition":2}');
    const [event] = await off;
    assert.deepEqual(event, { partition: 2, source: 'remote' });
  });

  it('emits arm with source=local when type=401 qualifier=3', async () => {
    const off = once(h!.driver, 'arm');
    h!.alarm.write('{"frame_type":"event","counter":60,"account":"1234","type":401,"qualifier":3,"zone":3,"partition":1}');
    const [event] = await off;
    assert.deepEqual(event, { partition: 1, source: 'local' });
  });

  it('emits data when the panel returns a DATA frame (zone names)', async () => {
    const off = once(h!.driver, 'data');
    h!.alarm.write('{"frame_type":"DATA","counter":80,"account":"1234","id":260,"start_order":1,"parameters":["Front Door","Back Door","Kitchen PIR"]}');
    const [event] = await off;
    assert.deepEqual(event, {
      id: 260,
      startOrder: 1,
      parameters: ['Front Door', 'Back Door', 'Kitchen PIR'],
      more: false,
    });
  });

  it('flags more:"yes" on paginated DATA responses', async () => {
    const off = once(h!.driver, 'data');
    h!.alarm.write('{"frame_type":"DATA","counter":81,"account":"1234","id":260,"start_order":1,"parameters":["Front Door"],"more":"yes"}');
    const [event] = await off;
    assert.equal(event.more, true);
  });

  it('emits unknown for unrecognized event types', async () => {
    const off = once(h!.driver, 'unknown');
    h!.alarm.write('{"frame_type":"event","counter":70,"account":"1234","type":999,"qualifier":1,"zone":1,"partition":1}');
    const [frame] = await off;
    assert.equal(frame.type, 999);
  });

  it('emits system commPath ok=true on type=350 qualifier=3', async () => {
    const off = once(h!.driver, 'system');
    h!.alarm.write('{"frame_type":"event","counter":80,"account":"1234","type":350,"qualifier":3,"zone":4,"partition":1}');
    const [event] = await off;
    assert.deepEqual(event, { kind: 'commPath', ok: true, channel: 4, partition: 1 });
  });

  it('emits system commPath ok=false on type=350 qualifier=1', async () => {
    const off = once(h!.driver, 'system');
    h!.alarm.write('{"frame_type":"event","counter":81,"account":"1234","type":350,"qualifier":1,"zone":4,"partition":1}');
    const [event] = await off;
    assert.deepEqual(event, { kind: 'commPath', ok: false, channel: 4, partition: 1 });
  });
});

describe('PimaDriver — send side (arm/disarm)', () => {
  let h: Harness | null = null;
  beforeEach(async () => { h = await setupConnected(); });
  afterEach(async () => { await teardown(h); h = null; });

  it('arm(2) sends the right OPERATION frame', async () => {
    await h!.driver.arm(2);
    await waitForRx(h!, 1);
    assert.deepEqual(h!.rxFromDriver[0], {
      account: 1234,
      counter: 5000,
      frame_type: 'OPERATION',
      opclass: 1,
      optype: 12,
      order: 0,
      partition: 2,
      password: '2222',
    });
  });

  it('disarm(1) uses the right per-partition code and increments counter', async () => {
    await h!.driver.arm(1);
    await h!.driver.disarm(1);
    await waitForRx(h!, 2);
    assert.equal(h!.rxFromDriver[0].counter, 5000);
    assert.equal(h!.rxFromDriver[0].password, '1111');
    assert.equal(h!.rxFromDriver[0].optype, 12);
    assert.equal(h!.rxFromDriver[1].counter, 5001);
    assert.equal(h!.rxFromDriver[1].password, '1111');
    assert.equal(h!.rxFromDriver[1].optype, 17);
  });

  it('arm() rejects for an unknown partition', async () => {
    await assert.rejects(h!.driver.arm(99), /partition 99 not configured/);
  });

  it('getZoneNames() sends a DATA-REQ with id=260 and the right range', async () => {
    await h!.driver.getZoneNames(1, 16);
    await waitForRx(h!, 1);
    assert.deepEqual(h!.rxFromDriver[0], {
      frame_type: 'DATA-REQ',
      counter: 5000,
      account: 1234,
      password: '1111',
      id: 260,
      start_order: 1,
      stop_order: 16,
    });
  });

  it('getZoneCount() sends a DATA-REQ with id=2148', async () => {
    await h!.driver.getZoneCount();
    await waitForRx(h!, 1);
    assert.deepEqual(h!.rxFromDriver[0], {
      frame_type: 'DATA-REQ',
      counter: 5000,
      account: 1234,
      password: '1111',
      id: 2148,
      start_order: 1,
      stop_order: 1,
    });
  });

  it('getSystemKeyStatus(2) sends a DATA-REQ with id=2310 using partition 2 code', async () => {
    await h!.driver.getSystemKeyStatus(2);
    await waitForRx(h!, 1);
    assert.deepEqual(h!.rxFromDriver[0], {
      frame_type: 'DATA-REQ',
      counter: 5000,
      account: 1234,
      password: '2222',
      id: 2310,
      start_order: 2,
      stop_order: 2,
    });
  });

  it('getSystemKeyStatus() rejects for an unconfigured partition', async () => {
    await assert.rejects(h!.driver.getSystemKeyStatus(99), /partition 99 not configured/);
  });
});

describe('PimaDriver — send without connection', () => {
  it('arm() rejects when no panel is connected', async () => {
    const driver = new PimaDriver({
      port: 0,
      account: 1234,
      partitions: [{ id: 1, userCode: '1111' }],
    });
    await driver.start();
    await assert.rejects(driver.arm(1), /no active panel connection/);
    await driver.stop();
  });
});
