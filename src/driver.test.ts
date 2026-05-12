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
  /**
   * Mutable flag controlling whether the fake alarm auto-ACKs OPERATIONs
   * (default true — mirrors real panel behaviour). Set to false in tests
   * that need to model "panel did not respond" / NAK manually.
   */
  autoAck: { enabled: boolean };
}

interface SetupOptions {
  /** Override the driver's per-request timeout. Useful for fast timeout tests. */
  requestTimeoutMs?: number;
  /** Initial value of the auto-ACK flag (default true). */
  autoAck?: boolean;
}

async function setupConnected(options: SetupOptions = {}): Promise<Harness> {
  const driver = new PimaDriver({
    port: 0, // random
    account: 1234,
    partitions: [
      { id: 1, userCode: '1111' },
      { id: 2, userCode: '2222' },
    ],
    opCounterStart: 5000,
    requestTimeoutMs: options.requestTimeoutMs,
  });
  await driver.start();
  const addr = driver.address() as net.AddressInfo;

  // Subscribe BEFORE initiating the connection — otherwise we can race the
  // server's 'connection' handler and miss the synchronous 'connected' emit.
  const connected = once(driver, 'connected');

  const alarm = net.createConnection({ host: '127.0.0.1', port: addr.port });
  const rxFromDriver: Array<Record<string, unknown>> = [];
  const autoAck = { enabled: options.autoAck ?? true };
  alarm.on('data', (buf) => {
    // TCP may deliver back-to-back writes as one chunk; split at JSON boundaries.
    const text = buf.toString('utf8');
    for (const part of text.split(/(?<=\})(?=\{)/)) {
      try {
        const frame = JSON.parse(part);
        rxFromDriver.push(frame);
        // Mirror real-panel behaviour: every valid OPERATION gets an ACK with
        // the matching counter. Tests that want to model "no response" or a
        // NAK toggle `harness.autoAck.enabled = false` and respond manually.
        if (frame?.frame_type === 'OPERATION' && autoAck.enabled) {
          alarm.write(JSON.stringify({
            frame_type: 'ACK',
            counter: frame.counter,
            account: '1234',
          }));
        }
      } catch {
        // ignore
      }
    }
  });

  await connected;
  return { driver, port: addr.port, alarm, rxFromDriver, autoAck };
}

/**
 * Like setupConnected, but also sends a heartbeat with the correct account
 * so panelVerified flips to true before the tests run. Clears rxFromDriver
 * so tests only see frames sent AFTER verification.
 */
async function setupVerified(options: SetupOptions = {}): Promise<Harness> {
  const h = await setupConnected(options);
  const verified = once(h.driver, 'verified');
  h.alarm.write('{"frame_type":"null","counter":1,"account":"1234"}');
  await verified;
  await waitForRx(h, 1); // wait for the ACK back to the alarm
  h.rxFromDriver.splice(0); // discard the ACK; tests start with a clean slate
  return h;
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

/**
 * Echo a DATA response back for the latest DATA-REQ the driver sent. Used
 * by tests to unblock `await driver.requestData(...)` (and its convenience
 * wrappers), which now resolves on the matching DATA frame rather than on
 * the write completing.
 */
function respondToLastDataReq(
  h: Harness,
  parameters: string[] = [],
  opts: { more?: boolean } = {},
): void {
  const req = [...h.rxFromDriver].reverse().find((f) => f.frame_type === 'DATA-REQ');
  if (!req) throw new Error('no DATA-REQ in rxFromDriver to respond to');
  const reply = {
    frame_type: 'DATA',
    counter: req.counter,
    account: '1234',
    id: req.id,
    start_order: req.start_order,
    parameters,
    more: opts.more ? 'yes' : 'no',
  };
  h.alarm.write(JSON.stringify(reply));
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

  it('closes connection if first frame has a non-string account', async () => {
    const errEvt = once(h!.driver, 'error');
    // Numeric account that numerically equals the configured account — must still be rejected.
    h!.alarm.write('{"frame_type":"null","counter":1,"account":1234}');
    const [err] = await errEvt;
    assert.match((err as Error).message, /1234/);
    await new Promise<void>((resolve) => {
      if (h!.alarm.destroyed) return resolve();
      h!.alarm.once('close', () => resolve());
    });
    assert.equal(h!.alarm.destroyed, true);
  });

  it('arm() rejects before panel is verified', async () => {
    await assert.rejects(h!.driver.arm(1), /not yet verified/);
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
  beforeEach(async () => { h = await setupVerified(); });
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
    const pending = h!.driver.getZoneNames(1, 16);
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
    respondToLastDataReq(h!, []);
    await pending;
  });

  it('getZoneCount() sends a DATA-REQ with id=2148', async () => {
    const pending = h!.driver.getZoneCount();
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
    respondToLastDataReq(h!, ['3']);
    await pending;
  });

  it('getSystemKeyStatus(2) sends a DATA-REQ with id=2310 using partition 2 code', async () => {
    const pending = h!.driver.getSystemKeyStatus(2);
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
    respondToLastDataReq(h!, ['2']);
    await pending;
  });

  it('getSystemKeyStatus() rejects for an unconfigured partition', async () => {
    await assert.rejects(h!.driver.getSystemKeyStatus(99), /partition 99 not configured/);
  });

  it('requestData uses params.password instead of partition userCode when both are present', async () => {
    const pending = h!.driver.requestData({ id: 260, startOrder: 1, stopOrder: 16, password: '9999' });
    await waitForRx(h!, 1);
    assert.equal(h!.rxFromDriver[0].password, '9999');
    assert.equal(h!.rxFromDriver[0].id, 260);
    respondToLastDataReq(h!, []);
    await pending;
  });

  it('requestData resolves with the DATA frame parameters', async () => {
    const pending = h!.driver.requestData({ id: 260, startOrder: 1, stopOrder: 3 });
    await waitForRx(h!, 1);
    respondToLastDataReq(h!, ['Front Door', 'Back Door', 'Kitchen PIR']);
    const res = await pending;
    assert.deepEqual(res, { parameters: ['Front Door', 'Back Door', 'Kitchen PIR'], more: false });
  });

  it('requestData propagates more:"yes" to the caller', async () => {
    const pending = h!.driver.requestData({ id: 260, startOrder: 1, stopOrder: 16 });
    await waitForRx(h!, 1);
    respondToLastDataReq(h!, ['a', 'b'], { more: true });
    const res = await pending;
    assert.equal(res.more, true);
    assert.deepEqual(res.parameters, ['a', 'b']);
  });

  it('serializes concurrent requestData calls (one DATA-REQ on the wire at a time)', async () => {
    const dataReqs = (): Array<Record<string, unknown>> =>
      h!.rxFromDriver.filter((f) => f.frame_type === 'DATA-REQ');
    const waitForDataReqs = async (n: number, timeoutMs = 1000): Promise<void> => {
      const deadline = Date.now() + timeoutMs;
      while (dataReqs().length < n) {
        if (Date.now() > deadline) {
          throw new Error(`timeout waiting for ${n} DATA-REQ(s); got ${dataReqs().length}: ${JSON.stringify(h!.rxFromDriver)}`);
        }
        await new Promise((r) => setTimeout(r, 5));
      }
    };

    const a = h!.driver.requestData({ id: 260, startOrder: 1, stopOrder: 1 });
    const b = h!.driver.requestData({ id: 260, startOrder: 2, stopOrder: 2 });
    await waitForDataReqs(1);
    // Give the queue a chance to leak a second DATA-REQ if our serialization
    // is broken — it shouldn't.
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(dataReqs().length, 1, `expected exactly one DATA-REQ on the wire; got ${dataReqs().length}: ${JSON.stringify(h!.rxFromDriver)}`);

    respondToLastDataReq(h!, ['Door A']);
    const resA = await a;
    assert.deepEqual(resA.parameters, ['Door A']);

    await waitForDataReqs(2);
    assert.equal(dataReqs()[1].start_order, 2);

    respondToLastDataReq(h!, ['Door B']);
    const resB = await b;
    assert.deepEqual(resB.parameters, ['Door B']);
  });

  it('requestData rejects with a NAK that matches its counter', async () => {
    const pending = h!.driver.requestData({ id: 260, startOrder: 1, stopOrder: 1 });
    await waitForRx(h!, 1);
    const req = h!.rxFromDriver[0];
    h!.alarm.write(JSON.stringify({
      frame_type: 'NAK',
      counter: req.counter,
      account: '1234',
      data: 'invalid password',
    }));
    await assert.rejects(pending, /invalid password/);
  });
});

describe('PimaDriver — OPERATION request/response semantics', () => {
  let h: Harness | null = null;
  beforeEach(async () => { h = await setupVerified(); });
  afterEach(async () => { await teardown(h); h = null; });

  it('arm() does not resolve until the panel ACKs', async () => {
    h!.autoAck.enabled = false;
    const armPromise = h!.driver.arm(2);

    await waitForRx(h!, 1);
    // Race the promise against a short timer. With no ACK, we expect the
    // timer to win — proving arm() is genuinely waiting on the panel.
    const settled = await Promise.race([
      armPromise.then(() => 'resolved', () => 'rejected'),
      new Promise<string>((r) => setTimeout(() => r('pending'), 30)),
    ]);
    assert.equal(settled, 'pending', 'arm() must not resolve before the ACK arrives');

    const op = h!.rxFromDriver[0];
    h!.alarm.write(JSON.stringify({
      frame_type: 'ACK',
      counter: op.counter,
      account: '1234',
    }));
    await armPromise;
  });

  it('arm() rejects when the panel NAKs the matching counter', async () => {
    h!.autoAck.enabled = false;
    const armPromise = h!.driver.arm(2);
    await waitForRx(h!, 1);
    const op = h!.rxFromDriver[0];
    h!.alarm.write(JSON.stringify({
      frame_type: 'NAK',
      counter: op.counter,
      account: '1234',
      data: 'Wrong User Code',
    }));
    await assert.rejects(armPromise, /Wrong User Code/);
  });

  it('serializes concurrent OPERATIONs (one on the wire at a time)', async () => {
    h!.autoAck.enabled = false;
    const ops = (): Array<Record<string, unknown>> =>
      h!.rxFromDriver.filter((f) => f.frame_type === 'OPERATION');

    const armP = h!.driver.arm(1);
    const disarmP = h!.driver.disarm(1);

    await waitForRx(h!, 1);
    // Give the queue a chance to leak a second OPERATION if our serialisation
    // is broken — it shouldn't.
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(ops().length, 1, `expected exactly one OPERATION on the wire; got ${ops().length}`);

    const first = ops()[0];
    h!.alarm.write(JSON.stringify({
      frame_type: 'ACK',
      counter: first.counter,
      account: '1234',
    }));
    await armP;

    await waitForRx(h!, 2);
    assert.equal(ops().length, 2);
    const second = ops()[1];
    assert.equal(second.optype, 17, 'second OPERATION should be the queued disarm');
    h!.alarm.write(JSON.stringify({
      frame_type: 'ACK',
      counter: second.counter,
      account: '1234',
    }));
    await disarmP;
  });

  it('does not block requestData behind an in-flight OPERATION beyond serialisation', async () => {
    // Sanity check that DATA-REQ and OPERATION share the queue: the second
    // call is queued until the first settles, regardless of frame_type.
    h!.autoAck.enabled = false;
    const armP = h!.driver.arm(1);
    const reqP = h!.driver.getZoneCount();
    await waitForRx(h!, 1);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(h!.rxFromDriver.length, 1, 'DATA-REQ must wait for OPERATION to settle');

    // ACK the arm — the DATA-REQ should now go out.
    const op = h!.rxFromDriver[0];
    h!.alarm.write(JSON.stringify({ frame_type: 'ACK', counter: op.counter, account: '1234' }));
    await armP;

    await waitForRx(h!, 2);
    const dataReq = h!.rxFromDriver[1];
    assert.equal(dataReq.frame_type, 'DATA-REQ');
    h!.alarm.write(JSON.stringify({
      frame_type: 'DATA',
      counter: dataReq.counter,
      account: '1234',
      id: 2148,
      start_order: 1,
      parameters: ['3'],
      more: 'no',
    }));
    await reqP;
  });
});

describe('PimaDriver — request timeout', () => {
  let h: Harness | null = null;
  // Use a short request timeout so tests don't wait the production-default 5s.
  beforeEach(async () => {
    h = await setupVerified({ requestTimeoutMs: 80, autoAck: false });
  });
  afterEach(async () => { await teardown(h); h = null; });

  it('rejects arm() when the panel does not respond within the timeout', async () => {
    await assert.rejects(
      h!.driver.arm(2),
      /timeout waiting for response to operation/,
    );
  });

  it('rejects requestData() when the panel does not respond within the timeout', async () => {
    await assert.rejects(
      h!.driver.getZoneCount(),
      /timeout waiting for response to data-req/,
    );
  });

  it('keeps the queue alive after a timeout — the next call still works', async () => {
    await assert.rejects(h!.driver.arm(2), /timeout/);

    // After the timeout settles the queue, a follow-up call should fire. Turn
    // auto-ACK back on so the next arm() actually resolves.
    h!.autoAck.enabled = true;
    await h!.driver.arm(1);
  });
});

describe('PimaDriver — config validation', () => {
  // Without validation, a `requestTimeoutMs` of `0` / negative / non-finite
  // would silently make every request time out almost immediately.
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    it(`rejects requestTimeoutMs=${bad} at construction`, () => {
      assert.throws(
        () => new PimaDriver({
          port: 0,
          account: 1234,
          partitions: [{ id: 1, userCode: '1111' }],
          requestTimeoutMs: bad,
        }),
        /requestTimeoutMs.*finite positive/,
      );
    });
  }

  it('accepts a positive finite requestTimeoutMs', () => {
    assert.doesNotThrow(() => new PimaDriver({
      port: 0,
      account: 1234,
      partitions: [{ id: 1, userCode: '1111' }],
      requestTimeoutMs: 100,
    }));
  });
});

describe('PimaDriver — inbound retransmit dedup', () => {
  let h: Harness | null = null;
  beforeEach(async () => { h = await setupVerified(); });
  afterEach(async () => { await teardown(h); h = null; });

  // Per spec §4.5.2 (and PROTOCOL.md): the panel resends an event with the
  // same counter if its previous send wasn't acknowledged. We must always
  // re-ACK so the panel knows the retransmit landed, but we must NOT re-emit
  // the typed driver event — that would fire HomeKit handlers (zone open,
  // alarm triggered, etc.) twice for a single physical event.
  it('emits a typed event only once for back-to-back retransmits, but ACKs each one', async () => {
    const zoneEvents: Array<{ zone: number; partition: number; active: boolean }> = [];
    h!.driver.on('zone', (e) => zoneEvents.push(e));

    const send = (): void => {
      h!.alarm.write('{"frame_type":"event","counter":50,"account":"1234","type":760,"qualifier":1,"zone":4,"partition":2}');
    };
    send();
    send();

    // Both ACKs go out (one per inbound frame), but only one zone event surfaces.
    await waitForRx(h!, 2);
    const acks = h!.rxFromDriver.filter((f) => f.frame_type === 'ACK' && Number(f.counter) === 50);
    assert.equal(acks.length, 2, `expected to re-ACK both retransmits; got ${acks.length}`);

    // Give the listener a moment to (incorrectly) re-fire if dedup is missing.
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(zoneEvents.length, 1, `expected exactly one typed zone event; got ${zoneEvents.length}: ${JSON.stringify(zoneEvents)}`);
  });

  it('does NOT dedup an event with a different counter', async () => {
    const zoneEvents: Array<{ zone: number; partition: number; active: boolean }> = [];
    h!.driver.on('zone', (e) => zoneEvents.push(e));

    h!.alarm.write('{"frame_type":"event","counter":50,"account":"1234","type":760,"qualifier":1,"zone":4,"partition":2}');
    h!.alarm.write('{"frame_type":"event","counter":51,"account":"1234","type":760,"qualifier":3,"zone":4,"partition":2}');

    await waitForRx(h!, 2);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(zoneEvents.length, 2, `expected both events to surface; got ${JSON.stringify(zoneEvents)}`);
  });
});

describe('PimaDriver — requestData password override', () => {
  it('requestData succeeds with params.password when no partitions configured', async () => {
    const driver = new PimaDriver({
      port: 0,
      account: 5678,
      partitions: [],
      opCounterStart: 1,
    });
    await driver.start();
    const addr = driver.address() as net.AddressInfo;
    const connected = once(driver, 'connected');
    const verified = once(driver, 'verified');
    const rxFromDriver: Array<Record<string, unknown>> = [];
    const sock = net.createConnection({ host: '127.0.0.1', port: addr.port });
    sock.on('data', (buf) => {
      const text = buf.toString('utf8');
      for (const part of text.split(/(?<=\})(?=\{)/)) {
        try { rxFromDriver.push(JSON.parse(part)); } catch { /* ignore */ }
      }
    });
    await connected;
    // Send a heartbeat with the matching account so the driver flips
    // `panelVerified=true` and will accept outbound DATA-REQs.
    sock.write('{"frame_type":"null","counter":1,"account":"5678"}');
    await verified;

    const pending = driver.requestData({ id: 260, startOrder: 1, password: 'override' });
    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 1000;
      const poll = (): void => {
        // First frame is the ACK to the heartbeat; the DATA-REQ is the second.
        if (rxFromDriver.length >= 2) return resolve();
        if (Date.now() > deadline) return reject(new Error('timeout waiting for DATA-REQ'));
        setTimeout(poll, 5);
      };
      poll();
    });
    const dataReq = rxFromDriver.find((f) => f.frame_type === 'DATA-REQ');
    assert.ok(dataReq, 'expected a DATA-REQ frame');
    assert.equal(dataReq!.password, 'override');
    assert.equal(dataReq!.id, 260);

    // Unblock the pending requestData so the test (and driver) can tear down.
    sock.write(JSON.stringify({
      frame_type: 'DATA',
      counter: dataReq!.counter,
      account: '5678',
      id: 260,
      start_order: 1,
      parameters: [],
      more: 'no',
    }));
    await pending;

    sock.destroy();
    await driver.stop();
  });

  it('requestData rejects when no partitions and no password', async () => {
    const driver = new PimaDriver({ port: 0, account: 5678, partitions: [] });
    await driver.start();
    await assert.rejects(
      driver.requestData({ id: 260, startOrder: 1 }),
      /no partition configured to derive a user code for DATA-REQ/,
    );
    await driver.stop();
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

describe('PimaDriver — reverseStrings option', () => {
  it('reverses every string parameter in DATA responses when enabled', async () => {
    const driver = new PimaDriver({
      port: 0,
      account: 1234,
      partitions: [{ id: 1, userCode: '1111' }],
      reverseStrings: true,
      opCounterStart: 5000,
    });
    await driver.start();
    const addr = driver.address() as net.AddressInfo;
    const connected = once(driver, 'connected');
    const sock = net.createConnection({ host: '127.0.0.1', port: addr.port });
    const rx: Array<Record<string, unknown>> = [];
    sock.on('data', (buf) => {
      for (const part of buf.toString('utf8').split(/(?<=\})(?=\{)/)) {
        try { rx.push(JSON.parse(part)); } catch { /* ignore */ }
      }
    });
    await connected;
    // Verify the panel so requestData is accepted.
    const verified = once(driver, 'verified');
    sock.write('{"frame_type":"null","counter":1,"account":"1234"}');
    await verified;

    const pending = driver.requestData({ id: 260, startOrder: 1, stopOrder: 2 });
    // Wait for the driver to send its DATA-REQ, then reply with a Hebrew payload.
    const deadline = Date.now() + 1000;
    while (!rx.find((f) => f.frame_type === 'DATA-REQ')) {
      if (Date.now() > deadline) throw new Error('timeout waiting for DATA-REQ');
      await new Promise((r) => setTimeout(r, 5));
    }
    const req = rx.find((f) => f.frame_type === 'DATA-REQ')!;
    sock.write(JSON.stringify({
      frame_type: 'DATA',
      counter: req.counter,
      account: '1234',
      id: 260,
      start_order: 1,
      parameters: ['abc', 'תלד'],
    }));
    const res = await pending;
    // 'abc' reversed → 'cba'; visual-order Hebrew 'תלד' (=ת,ל,ד) reversed
    // to logical-order 'דלת' (=ד,ל,ת).
    assert.deepEqual(res.parameters, ['cba', 'דלת']);

    sock.destroy();
    await driver.stop();
  });
});
