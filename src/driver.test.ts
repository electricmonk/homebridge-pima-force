import { strict as assert } from 'node:assert';
import { once } from 'node:events';
import { describe, it } from 'node:test';
import { PimaDriver } from './driver.js';
import { anAlarmSystem, type AlarmSystem } from './test-support/alarm-system.js';
import { consistently } from './test-support/consistently.js';
import { eventually } from './test-support/eventually.js';
import {
  EVENT_TYPE_ZONE,
  OPTYPE_ARM_AWAY,
  OPTYPE_DISARM,
  PARAM_ID_NUMBER_OF_INSTALLED_ZONES,
  PARAM_ID_SYSTEM_KEY_STATUS,
  PARAM_ID_ZONE_NAMES,
  PARTITION_DISARMED,
  QUALIFIER_NEW,
} from './test-support/constants.js';
import {
  armedFromRemote,
  armedLocally,
  commPathOk,
  commPathTrouble,
  disarmedFromRemote,
  nakWithReason,
  partitionStatus,
  zoneClosed,
  zoneCount,
  zoneNames,
  zoneOpened,
} from './test-support/frames.js';

/**
 * Integration tests: spin up the driver on a random port, dial in with the
 * `alarmSystem` fake-panel driver, and assert end-to-end behavior.
 */

interface SetupDriverOpts {
  /** Override the driver's per-request timeout. Useful for fast timeout tests. */
  requestTimeoutMs?: number;
  partitions?: Array<{ id: number; userCode: string }>;
  account?: number;
  opCounterStart?: number;
}

async function setupDriver(opts: SetupDriverOpts = {}): Promise<PimaDriver> {
  const driver = new PimaDriver({
    port: 0, // random
    account: opts.account ?? 1234,
    partitions: opts.partitions ?? [
      { id: 1, userCode: '1111' },
      { id: 2, userCode: '2222' },
    ],
    opCounterStart: opts.opCounterStart ?? 5000,
    requestTimeoutMs: opts.requestTimeoutMs,
  });
  await driver.start();
  return driver;
}

/**
 * Open an `alarmSystem` connection to the given driver and (by default)
 * complete the verification handshake. Tests that want to inspect the
 * pre-verified state pass `verify: false`.
 *
 * Awaits both the client-side TCP `connect` AND the driver's `connected`
 * event before returning — these fire on independent event-loop ticks
 * and order isn't guaranteed.
 */
async function connectAlarm(
  driver: PimaDriver,
  opts: { account?: number; verify?: boolean } = {},
): Promise<AlarmSystem> {
  const alarm = anAlarmSystem({ port: driver.port(), account: opts.account ?? 1234 });
  const driverConnected = once(driver, 'connected');
  await alarm.connect();
  await driverConnected;
  if (opts.verify !== false) await alarm.verify();
  return alarm;
}

describe('PimaDriver — connection lifecycle', () => {
  it('emits connected when the alarm dials in', async () => {
    await using driver = await setupDriver();
    using _alarm = await connectAlarm(driver, { verify: false });
    assert.equal(driver.isConnected(), true);
  });

  it('emits verified after first frame with matching account', async () => {
    await using driver = await setupDriver();
    using alarm = await connectAlarm(driver, { verify: false });
    const verified = once(driver, 'verified');
    await alarm.verify();
    await verified;
  });

  it('closes connection if first frame has wrong account', async () => {
    await using driver = await setupDriver();
    using alarm = await connectAlarm(driver, { verify: false });
    const errEvt = once(driver, 'error');
    alarm.sendRaw({ frame_type: 'null', counter: 1, account: '9999' });
    const [err] = await errEvt;
    assert.match((err as Error).message, /9999/);
    await eventually(() => assert.equal(driver.isConnected(), false));
  });

  it('closes connection if first frame has a non-string account', async () => {
    await using driver = await setupDriver();
    using alarm = await connectAlarm(driver, { verify: false });
    const errEvt = once(driver, 'error');
    // Numeric account that numerically equals the configured account — must still be rejected.
    alarm.sendRaw({ frame_type: 'null', counter: 1, account: 1234 });
    const [err] = await errEvt;
    assert.match((err as Error).message, /1234/);
    await eventually(() => assert.equal(driver.isConnected(), false));
  });

  it('arm() rejects before panel is verified', async () => {
    await using driver = await setupDriver();
    using _alarm = await connectAlarm(driver, { verify: false });
    await assert.rejects(driver.arm(1), /not yet verified/);
  });

  it('emits disconnected when the alarm drops', async () => {
    await using driver = await setupDriver();
    using alarm = await connectAlarm(driver, { verify: false });
    const off = once(driver, 'disconnected');
    alarm.close();
    await off;
    assert.equal(driver.isConnected(), false);
  });
});

describe('PimaDriver — receive side', () => {
  it('ACKs a null heartbeat', async () => {
    await using driver = await setupDriver();
    using alarm = await connectAlarm(driver, { verify: false });
    // verify() sends a null heartbeat with our account, then awaits the
    // driver's ACK. Asserting on its presence + counter checks the ACK shape.
    await alarm.verify();
    const ack = alarm.received.find((f) => f.frame_type === 'ACK');
    assert.deepEqual(ack, { account: 1234, counter: 1, frame_type: 'ACK', kc: 1 });
  });

  it('does NOT ACK a NAK (would feedback-loop)', async () => {
    await using driver = await setupDriver();
    using alarm = await connectAlarm(driver, { verify: false });
    alarm.sendRaw({ frame_type: 'NAK', counter: 0, account: '1234', data: 'JSON frame' });
    await consistently(() => assert.equal(alarm.received.length, 0), { durationMs: 50 });
  });

  it('emits zone active=true when zone opens', async () => {
    await using driver = await setupDriver();
    using alarm = await connectAlarm(driver);
    const off = once(driver, 'zone');
    await alarm.report(zoneOpened({ zone: 4, partition: 2 }));
    const [event] = await off;
    assert.deepEqual(event, { zone: 4, partition: 2, active: true });
  });

  it('emits zone active=false when zone closes', async () => {
    await using driver = await setupDriver();
    using alarm = await connectAlarm(driver);
    const off = once(driver, 'zone');
    await alarm.report(zoneClosed({ zone: 4, partition: 2 }));
    const [event] = await off;
    assert.deepEqual(event, { zone: 4, partition: 2, active: false });
  });

  it('emits arm with source=remote on remote arm event', async () => {
    await using driver = await setupDriver();
    using alarm = await connectAlarm(driver);
    const off = once(driver, 'arm');
    await alarm.report(armedFromRemote({ partition: 2, user: 2 }));
    const [event] = await off;
    assert.deepEqual(event, { partition: 2, source: 'remote' });
  });

  it('emits disarm with source=remote on remote disarm event', async () => {
    await using driver = await setupDriver();
    using alarm = await connectAlarm(driver);
    const off = once(driver, 'disarm');
    await alarm.report(disarmedFromRemote({ partition: 2, user: 2 }));
    const [event] = await off;
    assert.deepEqual(event, { partition: 2, source: 'remote' });
  });

  it('emits arm with source=local on keypad arm event', async () => {
    await using driver = await setupDriver();
    using alarm = await connectAlarm(driver);
    const off = once(driver, 'arm');
    await alarm.report(armedLocally({ partition: 1, user: 3 }));
    const [event] = await off;
    assert.deepEqual(event, { partition: 1, source: 'local' });
  });

  it('emits unknown for unrecognized event types', async () => {
    await using driver = await setupDriver();
    using alarm = await connectAlarm(driver);
    const off = once(driver, 'unknown');
    // Type 999 isn't in the CID table — the driver surfaces it as `unknown`.
    await alarm.report({ type: 999, qualifier: 1, zone: 1, partition: 1 });
    const [frame] = await off;
    assert.equal(frame.type, 999);
  });

  it('emits system commPath ok=true on comm-path restore', async () => {
    await using driver = await setupDriver();
    using alarm = await connectAlarm(driver);
    const off = once(driver, 'system');
    await alarm.report(commPathOk({ partition: 1, channel: 4 }));
    const [event] = await off;
    assert.deepEqual(event, { kind: 'commPath', ok: true, channel: 4, partition: 1 });
  });

  it('emits system commPath ok=false on comm-path trouble', async () => {
    await using driver = await setupDriver();
    using alarm = await connectAlarm(driver);
    const off = once(driver, 'system');
    await alarm.report(commPathTrouble({ partition: 1, channel: 4 }));
    const [event] = await off;
    assert.deepEqual(event, { kind: 'commPath', ok: false, channel: 4, partition: 1 });
  });
});

describe('PimaDriver — send side (arm/disarm)', () => {
  it('arm() sends an AWAY-arm OPERATION authenticated with that partition\'s user code', async () => {
    await using driver = await setupDriver();
    using alarm = await connectAlarm(driver);
    await driver.arm(2);
    const op = await alarm.nextOperation({ optype: OPTYPE_ARM_AWAY, partition: 2 });
    assert.equal(op.password, '2222');
    assert.equal(op.opclass, 1);
    assert.equal(op.order, 0);
    assert.equal(op.account, 1234);
  });

  it('disarm() uses the partition\'s user code and a fresh counter', async () => {
    await using driver = await setupDriver();
    using alarm = await connectAlarm(driver);
    await driver.arm(1);
    const armed = await alarm.nextOperation({ optype: OPTYPE_ARM_AWAY });
    await driver.disarm(1);
    const disarmed = await alarm.nextOperation({ optype: OPTYPE_DISARM });
    assert.equal(armed.password, '1111');
    assert.equal(disarmed.password, '1111');
    assert.equal(Number(disarmed.counter), Number(armed.counter) + 1);
  });

  it('arm() rejects for an unknown partition', async () => {
    await using driver = await setupDriver();
    using _alarm = await connectAlarm(driver);
    await assert.rejects(driver.arm(99), /partition 99 not configured/);
  });

  it('getZoneNames() sends a DATA-REQ for the zone-names range', async () => {
    await using driver = await setupDriver();
    using alarm = await connectAlarm(driver);
    const pending = driver.getZoneNames(1, 16);
    const q = await alarm.nextQuery({ id: PARAM_ID_ZONE_NAMES, startOrder: 1 });
    assert.equal(q.stop_order, 16);
    assert.equal(q.password, '1111');
    alarm.respond(q, zoneNames({ names: [] }));
    await pending;
  });

  it('getZoneCount() sends a DATA-REQ for the installed zone count', async () => {
    await using driver = await setupDriver();
    using alarm = await connectAlarm(driver);
    const pending = driver.getZoneCount();
    const q = await alarm.nextQuery({ id: PARAM_ID_NUMBER_OF_INSTALLED_ZONES });
    assert.equal(q.start_order, 1);
    assert.equal(q.stop_order, 1);
    assert.equal(q.password, '1111');
    alarm.respond(q, zoneCount({ count: 3 }));
    await pending;
  });

  it('getSystemKeyStatus() queries the partition\'s status using its own user code', async () => {
    await using driver = await setupDriver();
    using alarm = await connectAlarm(driver);
    const pending = driver.getSystemKeyStatus(2);
    const q = await alarm.nextQuery({ id: PARAM_ID_SYSTEM_KEY_STATUS, startOrder: 2 });
    assert.equal(q.stop_order, 2);
    assert.equal(q.password, '2222');
    alarm.respond(q, partitionStatus({ status: PARTITION_DISARMED }));
    await pending;
  });

  it('getSystemKeyStatus() rejects for an unconfigured partition', async () => {
    await using driver = await setupDriver();
    using _alarm = await connectAlarm(driver);
    await assert.rejects(driver.getSystemKeyStatus(99), /partition 99 not configured/);
  });

  it('requestData uses params.password when both that and a default user code are available', async () => {
    await using driver = await setupDriver();
    using alarm = await connectAlarm(driver);
    const pending = driver.requestData({ id: 260, startOrder: 1, stopOrder: 16, password: '9999' });
    const q = await alarm.nextQuery({ id: 260 });
    assert.equal(q.password, '9999');
    alarm.respond(q, zoneNames({ names: [] }));
    await pending;
  });

  it('requestData resolves with the DATA frame parameters', async () => {
    await using driver = await setupDriver();
    using alarm = await connectAlarm(driver);
    const pending = driver.requestData({ id: 260, startOrder: 1, stopOrder: 3 });
    const q = await alarm.nextQuery({ id: 260 });
    alarm.respond(q, zoneNames({ names: ['Front Door', 'Back Door', 'Kitchen PIR'] }));
    const res = await pending;
    assert.deepEqual(res, { parameters: ['Front Door', 'Back Door', 'Kitchen PIR'], more: false });
  });

  it('requestData propagates more:"yes" to the caller', async () => {
    await using driver = await setupDriver();
    using alarm = await connectAlarm(driver);
    const pending = driver.requestData({ id: 260, startOrder: 1, stopOrder: 16 });
    const q = await alarm.nextQuery({ id: 260 });
    alarm.respond(q, zoneNames({ names: ['a', 'b'], more: true }));
    const res = await pending;
    assert.equal(res.more, true);
    assert.deepEqual(res.parameters, ['a', 'b']);
  });

  it('serializes concurrent requestData calls (one DATA-REQ on the wire at a time)', async () => {
    await using driver = await setupDriver();
    using alarm = await connectAlarm(driver);

    const a = driver.requestData({ id: 260, startOrder: 1, stopOrder: 1 });
    const b = driver.requestData({ id: 260, startOrder: 2, stopOrder: 2 });

    const firstQuery = await alarm.nextQuery({ id: 260, startOrder: 1 });
    // Give the queue a chance to leak a second DATA-REQ if serialization is
    // broken — it shouldn't.
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(alarm.dataReqs.length, 1, `expected exactly one DATA-REQ on the wire; got ${alarm.dataReqs.length}`);

    alarm.respond(firstQuery, zoneNames({ names: ['Door A'] }));
    assert.deepEqual((await a).parameters, ['Door A']);

    const secondQuery = await alarm.nextQuery({ id: 260, startOrder: 2 });
    alarm.respond(secondQuery, zoneNames({ names: ['Door B'] }));
    assert.deepEqual((await b).parameters, ['Door B']);
  });

  it('requestData rejects with a NAK that matches its counter', async () => {
    await using driver = await setupDriver();
    using alarm = await connectAlarm(driver);
    const pending = driver.requestData({ id: 260, startOrder: 1, stopOrder: 1 });
    const q = await alarm.nextQuery({ id: 260 });
    alarm.reject(q, nakWithReason('invalid password'));
    await assert.rejects(pending, /invalid password/);
  });
});

describe('PimaDriver — OPERATION request/response semantics', () => {
  it('arm() does not resolve until the panel ACKs', async () => {
    await using driver = await setupDriver();
    using alarm = await connectAlarm(driver);
    alarm.autoAck.operations = false;

    const armPromise = driver.arm(2);
    const op = await alarm.nextOperation({ optype: OPTYPE_ARM_AWAY });

    // Race the promise against a short timer. With no ACK, we expect the
    // timer to win — proving arm() is genuinely waiting on the panel.
    const settled = await Promise.race([
      armPromise.then(() => 'resolved', () => 'rejected'),
      new Promise<string>((r) => setTimeout(() => r('pending'), 30)),
    ]);
    assert.equal(settled, 'pending', 'arm() must not resolve before the ACK arrives');

    alarm.sendRaw({ frame_type: 'ACK', counter: op.counter, account: '1234' });
    await armPromise;
  });

  it('arm() rejects when the panel NAKs the matching counter', async () => {
    await using driver = await setupDriver();
    using alarm = await connectAlarm(driver);
    alarm.autoAck.operations = false;

    const armPromise = driver.arm(2);
    const op = await alarm.nextOperation({ optype: OPTYPE_ARM_AWAY });
    alarm.sendRaw({
      frame_type: 'NAK',
      counter: op.counter,
      account: '1234',
      data: 'Wrong User Code',
    });
    await assert.rejects(armPromise, /Wrong User Code/);
  });

  it('serializes concurrent OPERATIONs (one on the wire at a time)', async () => {
    await using driver = await setupDriver();
    using alarm = await connectAlarm(driver);
    alarm.autoAck.operations = false;

    const armP = driver.arm(1);
    const disarmP = driver.disarm(1);

    const armOp = await alarm.nextOperation({ optype: OPTYPE_ARM_AWAY });
    // Give the queue a chance to leak a second OPERATION if our serialisation
    // is broken — it shouldn't.
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(alarm.operations.length, 1, `expected exactly one OPERATION on the wire; got ${alarm.operations.length}`);

    alarm.sendRaw({ frame_type: 'ACK', counter: armOp.counter, account: '1234' });
    await armP;

    const disarmOp = await alarm.nextOperation({ optype: OPTYPE_DISARM });
    alarm.sendRaw({ frame_type: 'ACK', counter: disarmOp.counter, account: '1234' });
    await disarmP;
  });

  it('shares the queue between OPERATION and DATA-REQ — DATA-REQ waits for the prior OPERATION to settle', async () => {
    await using driver = await setupDriver();
    using alarm = await connectAlarm(driver);
    alarm.autoAck.operations = false;

    const armP = driver.arm(1);
    const reqP = driver.getZoneCount();

    const armOp = await alarm.nextOperation({ optype: OPTYPE_ARM_AWAY });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(alarm.dataReqs.length, 0, 'DATA-REQ must wait for OPERATION to settle');

    alarm.sendRaw({ frame_type: 'ACK', counter: armOp.counter, account: '1234' });
    await armP;

    const q = await alarm.nextQuery({ id: PARAM_ID_NUMBER_OF_INSTALLED_ZONES });
    alarm.respond(q, zoneCount({ count: 3 }));
    await reqP;
  });
});

describe('PimaDriver — request timeout', () => {
  // Use a short request timeout so tests don't wait the production-default 5s.
  const shortTimeout = { requestTimeoutMs: 80 };

  it('rejects arm() when the panel does not respond within the timeout', async () => {
    await using driver = await setupDriver(shortTimeout);
    using alarm = await connectAlarm(driver);
    alarm.autoAck.operations = false;
    await assert.rejects(driver.arm(2), /timeout waiting for response to operation/);
  });

  it('rejects requestData() when the panel does not respond within the timeout', async () => {
    await using driver = await setupDriver(shortTimeout);
    using alarm = await connectAlarm(driver);
    alarm.autoAck.operations = false;
    await assert.rejects(driver.getZoneCount(), /timeout waiting for response to data-req/);
  });

  it('keeps the queue alive after a timeout — the next call still works', async () => {
    await using driver = await setupDriver(shortTimeout);
    using alarm = await connectAlarm(driver);
    alarm.autoAck.operations = false;
    await assert.rejects(driver.arm(2), /timeout/);

    // After the timeout settles the queue, a follow-up call should fire.
    // Turn auto-ACK back on so the next arm() actually resolves.
    alarm.autoAck.operations = true;
    await driver.arm(1);
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
  // Per spec §4.5.2 (and PROTOCOL.md): the panel resends an event with the
  // same counter if its previous send wasn't acknowledged. We must always
  // re-ACK so the panel knows the retransmit landed, but we must NOT re-emit
  // the typed driver event — that would fire HomeKit handlers (zone open,
  // alarm triggered, etc.) twice for a single physical event.
  it('emits a typed event only once for back-to-back retransmits, but ACKs each one', async () => {
    await using driver = await setupDriver();
    using alarm = await connectAlarm(driver);
    const zoneEvents: Array<{ zone: number; partition: number; active: boolean }> = [];
    driver.on('zone', (e) => zoneEvents.push(e));

    // Same counter both times — simulates the panel retrying a frame because
    // it didn't see our ACK.
    const retransmit = (): void => {
      alarm.sendRaw({
        frame_type: 'event',
        counter: 50,
        account: '1234',
        type: EVENT_TYPE_ZONE,
        qualifier: QUALIFIER_NEW,
        zone: 4,
        partition: 2,
      });
    };
    retransmit();
    retransmit();

    await eventually(() => {
      const acks = alarm.received.filter((f) => f.frame_type === 'ACK' && Number(f.counter) === 50);
      assert.equal(acks.length, 2, `expected to re-ACK both retransmits; got ${acks.length}`);
    });

    // Give the listener a moment to (incorrectly) re-fire if dedup is missing.
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(zoneEvents.length, 1, `expected exactly one typed zone event; got ${zoneEvents.length}: ${JSON.stringify(zoneEvents)}`);
  });

  it('does NOT dedup an event with a different counter', async () => {
    await using driver = await setupDriver();
    using alarm = await connectAlarm(driver);
    const zoneEvents: Array<{ zone: number; partition: number; active: boolean }> = [];
    driver.on('zone', (e) => zoneEvents.push(e));

    await alarm.report(zoneOpened({ zone: 4, partition: 2 }));
    await alarm.report(zoneClosed({ zone: 4, partition: 2 }));

    await eventually(() => assert.equal(zoneEvents.length, 2));
  });
});

describe('PimaDriver — requestData password override', () => {
  it('requestData succeeds with params.password when no partitions configured', async () => {
    await using driver = await setupDriver({ partitions: [], account: 5678, opCounterStart: 1 });
    using alarm = await connectAlarm(driver, { account: 5678 });
    const pending = driver.requestData({ id: 260, startOrder: 1, password: 'override' });
    const q = await alarm.nextQuery({ id: 260 });
    assert.equal(q.password, 'override');
    assert.equal(q.id, 260);
    alarm.respond(q, zoneNames({ names: [] }));
    await pending;
  });

  it('requestData rejects when no partitions and no password', async () => {
    await using driver = await setupDriver({ partitions: [], account: 5678 });
    await assert.rejects(
      driver.requestData({ id: 260, startOrder: 1 }),
      /no partition configured to derive a user code for DATA-REQ/,
    );
  });
});

describe('PimaDriver — send without connection', () => {
  it('arm() rejects when no panel is connected', async () => {
    await using driver = await setupDriver({ partitions: [{ id: 1, userCode: '1111' }] });
    await assert.rejects(driver.arm(1), /no active panel connection/);
  });
});

describe('PimaDriver — reverseStrings option', () => {
  it('reverses every string parameter in DATA responses when enabled', async () => {
    // setupDriver doesn't expose `reverseStrings` (it's deprecated), so
    // construct directly here.
    await using driver = new PimaDriver({
      port: 0,
      account: 1234,
      partitions: [{ id: 1, userCode: '1111' }],
      reverseStrings: true,
      opCounterStart: 5000,
    });
    await driver.start();
    using alarm = await connectAlarm(driver);
    const pending = driver.requestData({ id: 260, startOrder: 1, stopOrder: 2 });
    const q = await alarm.nextQuery({ id: 260 });
    alarm.respond(q, zoneNames({ names: ['abc', 'תלד'] }));
    const res = await pending;
    // 'abc' reversed → 'cba'; visual-order Hebrew 'תלד' (=ת,ל,ד) reversed
    // to logical-order 'דלת' (=ד,ל,ת).
    assert.deepEqual(res.parameters, ['cba', 'דלת']);
  });
});
