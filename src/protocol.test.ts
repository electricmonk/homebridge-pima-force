import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  buildAck,
  buildOperation,
  OPTYPE_ARM,
  OPTYPE_DISARM,
  parseFrame,
  parseFrames,
  shouldAck,
} from './protocol.js';

describe('parseFrame', () => {
  it('parses a natural-length JSON frame', () => {
    const buf = Buffer.from('{"frame_type":"event","counter":1,"account":"1234"}');
    const frame = parseFrame(buf);
    assert.deepEqual(frame, { frame_type: 'event', counter: 1, account: '1234' });
  });

  it('strips trailing 0x00 padding from heartbeat frames', () => {
    const json = '{"frame_type":"null","counter":11,"account":"1234"}';
    const buf = Buffer.alloc(250, 0);
    buf.write(json, 0, 'utf8');
    const frame = parseFrame(buf);
    assert.deepEqual(frame, { frame_type: 'null', counter: 11, account: '1234' });
  });

  it('returns null on malformed JSON', () => {
    assert.equal(parseFrame(Buffer.from('not json')), null);
  });

  it('returns null on empty buffer', () => {
    assert.equal(parseFrame(Buffer.alloc(0)), null);
  });

  it('returns null on all-zero buffer', () => {
    assert.equal(parseFrame(Buffer.alloc(250, 0)), null);
  });
});

describe('parseFrames', () => {
  it('returns one frame for one JSON object', () => {
    const buf = Buffer.from('{"frame_type":"event","counter":1}');
    assert.deepEqual(parseFrames(buf), [{ frame_type: 'event', counter: 1 }]);
  });

  it('returns multiple frames for back-to-back JSON objects (TCP coalescing)', () => {
    const buf = Buffer.from('{"frame_type":"event","counter":1}{"frame_type":"null","counter":2}');
    assert.deepEqual(parseFrames(buf), [
      { frame_type: 'event', counter: 1 },
      { frame_type: 'null', counter: 2 },
    ]);
  });

  it('handles a padded heartbeat frame followed by an event', () => {
    const heartbeat = Buffer.alloc(250, 0);
    heartbeat.write('{"frame_type":"null","counter":3}', 0, 'utf8');
    const event = Buffer.from('{"frame_type":"event","counter":4}');
    const combined = Buffer.concat([heartbeat, event]);
    assert.deepEqual(parseFrames(combined), [
      { frame_type: 'null', counter: 3 },
      { frame_type: 'event', counter: 4 },
    ]);
  });

  it('returns empty array for all-zero or empty input', () => {
    assert.deepEqual(parseFrames(Buffer.alloc(0)), []);
    assert.deepEqual(parseFrames(Buffer.alloc(250, 0)), []);
  });
});

describe('shouldAck', () => {
  it('does not ACK ACK frames (no echo)', () => {
    assert.equal(shouldAck({ frame_type: 'ACK' }), false);
  });
  it('does not ACK NAK frames (no feedback loop)', () => {
    assert.equal(shouldAck({ frame_type: 'NAK' }), false);
  });
  it('ACKs null heartbeats', () => {
    assert.equal(shouldAck({ frame_type: 'null' }), true);
  });
  it('ACKs event frames', () => {
    assert.equal(shouldAck({ frame_type: 'event' }), true);
  });
});

describe('buildAck', () => {
  it('matches the wire format observed from the Chowmain C4 driver', () => {
    // Captured from /tmp/pima-c4-arm.pcap, from the C4 driver replying to
    // the panel's null heartbeat counter:166, account:"9999".
    const expected = '{"account":9999,"counter":166,"frame_type":"ACK","kc":1}';
    const frame = { frame_type: 'event', counter: 166, account: '9999' };
    assert.equal(buildAck(frame).toString('utf8'), expected);
  });

  it('coerces account from string to number (the panel sends it as string)', () => {
    const ack = buildAck({ frame_type: 'null', counter: 1, account: '1234' });
    const parsed = JSON.parse(ack.toString('utf8'));
    assert.equal(parsed.account, 1234);
    assert.equal(typeof parsed.account, 'number');
  });

  it('preserves field order required by the panel', () => {
    // The panel observably tolerates re-ordering, but the C4 driver and our
    // working captures use this exact order. Lock it in to avoid drift.
    const ack = buildAck({ frame_type: 'null', counter: 5, account: 1234 });
    assert.equal(
      ack.toString('utf8'),
      '{"account":1234,"counter":5,"frame_type":"ACK","kc":1}',
    );
  });

  it('always sets kc:1 (purpose unknown but required)', () => {
    const ack = JSON.parse(buildAck({ frame_type: 'event', counter: 0, account: 0 }).toString('utf8'));
    assert.equal(ack.kc, 1);
  });
});

describe('buildOperation', () => {
  it('matches the ARM wire format observed from C4 driver', () => {
    // Wire format reference: ARM partition 2.
    const expected =
      '{"account":9999,"counter":4572,"frame_type":"OPERATION","opclass":1,"optype":12,"order":0,"partition":2,"password":"2222"}';
    const buf = buildOperation({
      account: 9999,
      counter: 4572,
      optype: OPTYPE_ARM,
      partition: 2,
      password: '2222',
    });
    assert.equal(buf.toString('utf8'), expected);
  });

  it('matches the DISARM wire format observed from C4 driver', () => {
    const expected =
      '{"account":9999,"counter":4573,"frame_type":"OPERATION","opclass":1,"optype":17,"order":0,"partition":2,"password":"2222"}';
    const buf = buildOperation({
      account: 9999,
      counter: 4573,
      optype: OPTYPE_DISARM,
      partition: 2,
      password: '2222',
    });
    assert.equal(buf.toString('utf8'), expected);
  });
});
