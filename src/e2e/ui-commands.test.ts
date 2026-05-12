/**
 * UI-initiated commands propagate to OPERATION frames on the wire:
 *   - HomeKit target state changes → arm / disarm OPERATIONs
 *   - Siren switch toggle → activate / de-activate output
 *   - Restricted partition (away-only) advertises and enforces its limits
 */
import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import {
  AWAY_ARM,
  DISARMED,
  NIGHT_ARM,
  OPTYPE_ACTIVATE_OUTPUT,
  OPTYPE_ARM_AWAY,
  OPTYPE_ARM_HOME1,
  OPTYPE_ARM_HOME2,
  OPTYPE_DEACTIVATE_OUTPUT,
  OPTYPE_DISARM,
  STAY_ARM,
} from '../test-support/constants.js';
import {
  type E2EFixture,
  connectAlarmSystem,
  homeBridgeFor,
  setupE2E,
} from '../test-support/e2e-fixture.js';
import { eventually } from '../test-support/eventually.js';
import { sirenActivated, sirenDeactivated } from '../test-support/frames.js';

describe('E2E: UI → panel commands', { timeout: 60_000 }, () => {
  let fix: E2EFixture;
  before(async () => {
    fix = await setupE2E();
    const hb = homeBridgeFor(fix);
    await eventually(async () => {
      const names = new Set((await hb.listAccessories()).map((a) => a.serviceName));
      for (const n of ['E2E Partition', 'E2E Restricted', 'E2E Siren']) {
        assert.ok(names.has(n));
      }
    }, { timeoutMs: 15_000 });
  });
  after(async () => { await fix?.stop(); });

  it('UI SecuritySystem AWAY target sends an AWAY-arm OPERATION', async () => {
    using alarm = await connectAlarmSystem(fix);
    const partition = homeBridgeFor(fix).partition('E2E Partition');
    // Force DISARM first so the AWAY transition is a real SET (SET handler
    // short-circuits when value already matches).
    await partition.setTarget(DISARMED);
    await partition.setTarget(AWAY_ARM);

    const op = await alarm.nextOperation({ optype: OPTYPE_ARM_AWAY, partition: 2 });
    assert.equal(op.partition, 2);
  });

  it('UI SecuritySystem STAY target sends a Home1 OPERATION', async () => {
    using alarm = await connectAlarmSystem(fix);
    const partition = homeBridgeFor(fix).partition('E2E Partition');
    await partition.setTarget(DISARMED);
    await partition.setTarget(STAY_ARM);

    const op = await alarm.nextOperation({ optype: OPTYPE_ARM_HOME1, partition: 2 });
    assert.equal(op.partition, 2);
  });

  it('UI SecuritySystem NIGHT target sends a Home2 OPERATION', async () => {
    using alarm = await connectAlarmSystem(fix);
    const partition = homeBridgeFor(fix).partition('E2E Partition');
    await partition.setTarget(DISARMED);
    await partition.setTarget(NIGHT_ARM);

    await alarm.nextOperation({ optype: OPTYPE_ARM_HOME2, partition: 2 });
  });

  it('UI SecuritySystem DISARM target sends disarm OPERATION', async () => {
    using alarm = await connectAlarmSystem(fix);
    const partition = homeBridgeFor(fix).partition('E2E Partition');
    // Force AWAY_ARM first so the DISARM transition actually triggers a SET.
    await partition.setTarget(AWAY_ARM);
    await partition.setTarget(DISARMED);

    const op = await alarm.nextOperation({ optype: OPTYPE_DISARM, partition: 2 });
    assert.equal(op.partition, 2);
  });

  it('toggling Switch OFF (while sounding) sends de-activate output OPERATION', async () => {
    using alarm = await connectAlarmSystem(fix);
    const siren = homeBridgeFor(fix).siren('E2E Siren');
    // First make the siren "sounding" so toggling OFF has work to do.
    await alarm.report(sirenActivated({ partition: 1 }));
    await eventually(async () => assert.equal(await siren.on(), true));

    await siren.setOn(false);

    const op = await alarm.nextOperation({ optype: OPTYPE_DEACTIVATE_OUTPUT });
    assert.equal(op.order, 1, 'external siren output number');
    assert.equal(op.partition, 0, 'panel-wide partition');
  });

  it('toggling Switch OFF still sends de-activate even when we never saw a 770 q=1', async () => {
    // Regression: previously the SET handler short-circuited when
    // `target === this.active`. If the panel sounded the siren without
    // emitting type=770 (or we missed it), `this.active` stayed false and
    // tapping OFF in the Home app silently sent nothing.
    using alarm = await connectAlarmSystem(fix);
    const siren = homeBridgeFor(fix).siren('E2E Siren');
    // Deliberately no `sirenActivated` event — simulates the panel
    // sounding without us ever seeing the 770 q=1.
    assert.equal(await siren.on(), false, 'precondition: switch is OFF');

    await siren.setOn(false);
    const op = await alarm.nextOperation({ optype: OPTYPE_DEACTIVATE_OUTPUT });
    assert.equal(op.order, 1);
  });

  it('toggling Switch ON (manual activation) is rejected — no OPERATION sent', async () => {
    using alarm = await connectAlarmSystem(fix);
    const siren = homeBridgeFor(fix).siren('E2E Siren');
    // Ensure siren is OFF first.
    await alarm.report(sirenDeactivated({ partition: 1 }));
    await eventually(async () => assert.equal(await siren.on(), false));

    const opsBefore = alarm.operations.length;
    await siren.setOn(true);

    // Wait briefly; assert NO output OPERATION arrived.
    await new Promise((r) => setTimeout(r, 500));
    const opAfter = alarm.operations.slice(opsBefore).find(
      (o) => o.optype === OPTYPE_ACTIVATE_OUTPUT || o.optype === OPTYPE_DEACTIVATE_OUTPUT,
    );
    assert.equal(opAfter, undefined, `no output OPERATION should be sent on manual activation; got: ${JSON.stringify(opAfter)}`);

    // And the switch should be back to OFF.
    assert.equal(await siren.on(), false);
  });

  it('restricted partition advertises only DISARM and AWAY as valid targets', async () => {
    // The UI exposes `validValues` for the characteristic (the values the
    // Home app picker offers). For the partition with
    // armModes={away:true, stay:false, night:false} we expect [DISARM, AWAY].
    const restricted = homeBridgeFor(fix).partition('E2E Restricted');
    const allowed = await restricted.validTargetStates();
    assert.ok(allowed.length > 0, 'expected validValues to be advertised');
    assert.deepEqual(
      [...allowed].sort((a, b) => a - b),
      [AWAY_ARM, DISARMED],
      `expected validValues [AWAY=${AWAY_ARM}, DISARM=${DISARMED}], got ${JSON.stringify(allowed)}`,
    );
  });

  it('disabled mode SET on restricted partition does not send an arm OPERATION', async () => {
    using alarm = await connectAlarmSystem(fix);
    const restricted = homeBridgeFor(fix).partition('E2E Restricted');
    const opsBefore = alarm.operations.length;
    // STAY is disabled. HAP / platform defense-in-depth should reject the SET.
    await restricted.setTarget(STAY_ARM).catch(() => { /* expected error */ });

    await new Promise((r) => setTimeout(r, 300));
    const op = alarm.operations.slice(opsBefore).find(
      (o) => o.optype === OPTYPE_ARM_HOME1 || o.optype === OPTYPE_ARM_HOME2,
    );
    assert.equal(op, undefined, `disabled mode should not send Home1/Home2; got: ${JSON.stringify(op)}`);
  });

  it('enabled mode SET on restricted partition still works (AWAY arm)', async () => {
    using alarm = await connectAlarmSystem(fix);
    const restricted = homeBridgeFor(fix).partition('E2E Restricted');
    // Force DISARM first so the AWAY transition fires SET.
    await restricted.setTarget(DISARMED);
    await restricted.setTarget(AWAY_ARM);

    const op = await alarm.nextOperation({ optype: OPTYPE_ARM_AWAY, partition: 3 });
    assert.equal(op.partition, 3);
  });
});
