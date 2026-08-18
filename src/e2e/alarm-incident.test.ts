/**
 * Regression for the 2026-08-17 19:41 incident: a smoke detector (zone 12,
 * a 24-hour zone) tripped the alarm on an already-disarmed partition. From
 * the Home app the user could neither silence the siren nor disarm — both
 * controls were dead — and had to walk to the keypad.
 *
 * What the journal showed:
 *
 *   19:41:45  partition 3 ALARM TRIGGERED (zone 12)
 *   19:41:45  output 1 (partition 1) → ACTIVE
 *   19:42:08  requested mute of output 1 (de-activate-output sent to panel)
 *   19:42:58  output 1 (partition 1) → inactive      ← 50s later, after the
 *                                                       keypad disarm
 *
 * Two separate defects, one per describe block below. Note what is *absent*
 * from the journal: not one disarm OPERATION for partition 3, even though
 * the user was tapping "Off". The only commands that reached the panel were
 * AWAY_ARM attempts (the user tapping around after "Off" did nothing), and
 * those NAKed with "סגור/בטל אזורים!" because the smoke zone was still open.
 */
import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import {
  ALARM_TRIGGERED,
  DISARM,
  DISARMED,
  OPTYPE_DEACTIVATE_OUTPUT,
  OPTYPE_DISARM,
  OUTPUT_EXTERNAL_SIREN,
  PARAM_ID_SYSTEM_KEY_STATUS,
  PARTITION_DISARMED,
} from '../test-support/constants.js';
import { consistently } from '../test-support/consistently.js';
import { type E2EHarness, setupE2E } from '../test-support/e2e-fixture.js';
import { eventually } from '../test-support/eventually.js';
import {
  burglaryAlarm,
  partitionStatus,
  sirenActivated,
  sirenDeactivated,
} from '../test-support/frames.js';
import { aPartition, aPluginConfig, aZone } from '../test-support/plugin-config.js';

/** The panel tags its output (770) events with a partition even though outputs are panel-wide. */
const SIREN_PARTITION = 1;

/**
 * Verbatim NAK the live panel returns for a disarm it treats as a no-op
 * ("all partitions are disarmed"). Not in Appendix D — captured from the
 * panel on 2026-08-18 while investigating this incident.
 */
const PANEL_NAK_ALL_DISARMED = 'כל המדורים מנוטרלים';

const partition = aPartition({ id: 3, name: 'Incident Partition' });
const smoke = aZone({ zone: 12, name: 'Incident Smoke', type: 'smoke' });
const SIREN_NAME = 'Incident Siren';

async function setupIncidentHarness(): Promise<E2EHarness> {
  const harness = await setupE2E({
    config: aPluginConfig({
      partitions: [partition],
      zones: [smoke],
      siren: { enabled: true, name: SIREN_NAME },
    }),
  });
  await eventually(async () => {
    const names = new Set((await harness.homebridge.listAccessories()).map((a) => a.serviceName));
    for (const n of [partition.name, smoke.name, SIREN_NAME]) assert.ok(names.has(n));
  }, { timeoutMs: 15_000 });
  return harness;
}

describe('E2E: 2026-08-17 incident — disarming a triggered but already-disarmed partition', { timeout: 60_000 }, () => {
  let harness: E2EHarness;
  before(async () => { harness = await setupIncidentHarness(); });
  after(async () => { await harness?.stop(); });

  /**
   * Zone 12 alarmed while partition 3 was disarmed — the panel raised CID
   * 130 for a partition it had itself reported disarmed five minutes
   * earlier. Whatever the panel-side reason (see the bypass discussion in
   * the incident notes), the plugin has to cope with the resulting state:
   *   TargetState  = DISARM         (nobody armed anything)
   *   CurrentState = ALARM_TRIGGERED
   * and the user's "Off" tap sets TargetState to the value it already holds.
   *
   * `handleSetTarget` short-circuits on `target === this.targetState`, so
   * that tap never becomes an OPERATION — the panel is never told to
   * disarm, and disarm is exactly what silences a 24-hour-zone alarm. The
   * Home app looks like it did nothing because it did nothing.
   *
   * DISARM must always reach the panel. It is idempotent there, and it
   * doubles as the alarm acknowledgement — the same reasoning that already
   * makes the siren's de-activate unconditional.
   */
  it('sends DISARM to the panel even when HomeKit already believes the partition is disarmed', async () => {
    using alarm = await harness.connectAlarm();

    // Startup state query: the partition is disarmed, as it was at 19:36.
    const stateQ = await alarm.nextQuery({ id: PARAM_ID_SYSTEM_KEY_STATUS, startOrder: partition.id });
    alarm.respond(stateQ, partitionStatus({ status: PARTITION_DISARMED }));

    const inHomeKit = harness.homebridge.partition(partition.name);
    await eventually(async () => assert.equal(await inHomeKit.currentState(), DISARMED));
    await eventually(async () => assert.equal(await inHomeKit.targetState(), DISARM));

    // 19:41:45 — the smoke detector trips the alarm on the disarmed partition.
    await alarm.report(burglaryAlarm({ zone: smoke.zone, partition: partition.id }));
    await eventually(async () => assert.equal(await inHomeKit.currentState(), ALARM_TRIGGERED));
    // TargetState is untouched by the alarm — still DISARM. This is the trap.
    assert.equal(await inHomeKit.targetState(), DISARM);

    // The user taps "Off" in the Home app.
    await inHomeKit.setTarget(DISARM);

    // It must reach the panel as a disarm OPERATION (optype 17).
    await alarm.nextOperation({ optype: OPTYPE_DISARM, partition: partition.id });
  });
});

describe('E2E: 2026-08-17 incident — panel rejects the redundant disarm', { timeout: 60_000 }, () => {
  let harness: E2EHarness;
  before(async () => { harness = await setupIncidentHarness(); });
  after(async () => { await harness?.stop(); });

  /**
   * Sending DISARM unconditionally is only half the fix. Verified against
   * the real panel: optype 17 aimed at an already-disarmed partition is
   * NAKed with "כל המדורים מנוטרלים" ("all partitions are disarmed"), and
   * a 2310 read either side confirms nothing changed.
   *
   * If that NAK propagated, tapping "Off" during a 24-hour-zone alarm would
   * show "No Response" in the Home app — swapping a silent no-op for a
   * scary one. It must be absorbed, while a disarm rejected on a partition
   * we believe is armed still surfaces.
   */
  it('absorbs the no-op NAK instead of surfacing "No Response"', async () => {
    using alarm = await harness.connectAlarm();
    // The panel NAKs OPERATIONs instead of ACKing them for this test.
    alarm.autoAck.operations = false;

    const stateQ = await alarm.nextQuery({ id: PARAM_ID_SYSTEM_KEY_STATUS, startOrder: partition.id });
    alarm.respond(stateQ, partitionStatus({ status: PARTITION_DISARMED }));

    const inHomeKit = harness.homebridge.partition(partition.name);
    await eventually(async () => assert.equal(await inHomeKit.currentState(), DISARMED));

    await alarm.report(burglaryAlarm({ zone: smoke.zone, partition: partition.id }));
    await eventually(async () => assert.equal(await inHomeKit.currentState(), ALARM_TRIGGERED));

    // NAK the disarm the moment it arrives, exactly as the panel did.
    const nakker = (async () => {
      const op = await alarm.nextOperation({ optype: OPTYPE_DISARM, partition: partition.id }, { timeoutMs: 8000 });
      alarm.sendRaw({
        frame_type: 'NAK',
        counter: op.counter,
        account: String(harness.account),
        data: PANEL_NAK_ALL_DISARMED,
      });
    })();

    await inHomeKit.setTarget(DISARM);
    await nakker;

    // config-ui-x's PUT returns 200 whether or not the SET handler threw, so
    // the HTTP call can't tell us anything — assert on what the plugin did.
    // The no-op NAK must be absorbed at INFO...
    await eventually(() => {
      const logs = harness.logs();
      assert.ok(
        logs.includes('rejected a redundant disarm'),
        `expected the redundant-disarm NAK to be absorbed; log tail:\n${logs.split('\n').slice(-30).join('\n')}`,
      );
    }, { timeoutMs: 10_000 });

    // ...and must NOT have surfaced as a characteristic failure, which is
    // what the Home app renders as "No Response".
    const logs = harness.logs();
    assert.ok(
      !logs.includes(`partition ${partition.id} target=${DISARM} failed`),
      `redundant disarm must not surface as a SET failure; log tail:\n${logs.split('\n').slice(-30).join('\n')}`,
    );

    // The partition must still read triggered-but-disarmed, not wedged.
    await eventually(async () => assert.equal(await inHomeKit.targetState(), DISARM));
    assert.equal(await inHomeKit.currentState(), ALARM_TRIGGERED);
  });
});

describe('E2E: 2026-08-17 incident — siren switch while the panel keeps sounding', { timeout: 60_000 }, () => {
  let harness: E2EHarness;
  before(async () => { harness = await setupIncidentHarness(); });
  after(async () => { await harness?.stop(); });

  /**
   * At 19:42:08 the plugin logged "requested mute of output 1
   * (de-activate-output sent to panel)" and flipped the switch to Off. The
   * siren went on sounding for another 50 seconds; the panel only reported
   * output 1 inactive at 19:42:58, after the keypad disarm.
   *
   * The panel ACKs the *frame*, not the effect — while an alarm is latched
   * it can ignore a de-activate on the siren output. Treating the ACK as
   * confirmation makes the switch lie, and a lying switch is a dead switch:
   * HomeKit won't emit another SET for a value already false, and turning it
   * back On is rejected by design. The user is left with a control that does
   * nothing, which is what "it didn't respond to the click" means.
   *
   * The switch must keep reporting On until the panel's 770 de-activate
   * arrives — the panel is the source of truth for accessory state.
   */
  it('keeps the siren switch On until the panel confirms the output went inactive', async () => {
    using alarm = await harness.connectAlarm();
    const siren = harness.homebridge.siren(SIREN_NAME);

    // 19:41:45 — external siren output goes active.
    await alarm.report(sirenActivated({ partition: SIREN_PARTITION, output: OUTPUT_EXTERNAL_SIREN }));
    await eventually(async () => assert.equal(await siren.on(), true));

    // 19:42:08 — the user taps the switch Off. The panel ACKs the OPERATION
    // (autoAck, as the real one did) but sends no 770 de-activate: the siren
    // is still sounding.
    await siren.setOn(false);
    await alarm.nextOperation({ optype: OPTYPE_DEACTIVATE_OUTPUT, order: OUTPUT_EXTERNAL_SIREN });

    // An ACK is not a confirmation. The siren is audibly still on, so
    // HomeKit must still show On — otherwise the control goes dead.
    await consistently(async () => assert.equal(await siren.on(), true), {
      durationMs: 750,
      intervalMs: 50,
      message: 'siren switch must not report Off before the panel confirms',
    });

    // A second Off tap must still reach the panel — the user mashing the
    // button while the siren screams is the whole point of the control.
    await siren.setOn(false);
    await eventually(() => assert.ok(
      alarm.operations.filter(
        (op) => Number(op.optype) === OPTYPE_DEACTIVATE_OUTPUT
          && Number(op.order) === OUTPUT_EXTERNAL_SIREN,
      ).length >= 2,
      `expected a second de-activate OPERATION, saw ${JSON.stringify(alarm.operations)}`,
    ));

    // 19:42:58 — the panel finally reports the output inactive. Only now
    // does the switch flip.
    await alarm.report(sirenDeactivated({ partition: SIREN_PARTITION, output: OUTPUT_EXTERNAL_SIREN }));
    await eventually(async () => assert.equal(await siren.on(), false));
  });
});
