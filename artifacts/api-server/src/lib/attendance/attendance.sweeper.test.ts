import assert from 'node:assert/strict';
import test from 'node:test';
import type { ServiceDeps } from './attendanceService';
import { asPoolLike } from './db';
import { SETTING_DEFAULTS, type AttendanceSettings } from './settings';
import { flagMissingOuts, isMissingOutDue, maybeQueueDigest, maybeSweep, runSweep, shiftDate } from './sweeper';
import { FakeDb } from './testSupport';
import { istParts } from './time';
import type { WhatsAppConfig } from './whatsappSender';

const wa: WhatsAppConfig = { mode: 'stub', accessToken: null, phoneNumberId: null, graphVersion: null };
const NOW = new Date('2026-03-02T05:30:00Z'); // 11:00 IST, Monday 2 March 2026
const ist = istParts(NOW);
const settings = (over: Partial<AttendanceSettings> = {}): AttendanceSettings =>
  ({ ...SETTING_DEFAULTS, directorWhatsapp: '919000000001', ...over });
const depsFor = (db: FakeDb, now = NOW): ServiceDeps =>
  ({ pool: asPoolLike(db.asPool()), wa, env: { APP_BASE_URL: 'https://portal.test' }, now: () => now });
const outbox = (db: FakeDb) => db.where(/insert into notification_outbox/).map(c => ({
  kind: String(c.params[5]), key: String(c.params[10]), payload: String(c.params[9]),
}));

// ── Date and timing helpers ───────────────────────────────────────────────────
test('shiftDate steps back across month and year boundaries', () => {
  assert.equal(shiftDate('2026-03-01', -1), '2026-02-28');
  assert.equal(shiftDate('2026-01-01', -1), '2025-12-31');
  assert.equal(shiftDate('2026-03-02', 1), '2026-03-03');
});

test('a missing OUT is due 60 minutes after logout today, and always for earlier days', () => {
  const at = (minuteOfDay: number) => ({ workDate: '2026-03-02', weekday: 1, minuteOfDay });
  assert.equal(isMissingOutDue('2026-03-02', '16:00:00', 60, at(16 * 60 + 59)), false);
  assert.equal(isMissingOutDue('2026-03-02', '16:00:00', 60, at(17 * 60)), true);
  assert.equal(isMissingOutDue('2026-03-01', '16:00:00', 60, at(8 * 60)), true);   // yesterday
  assert.equal(isMissingOutDue('2026-03-03', '16:00:00', 60, at(23 * 60)), false); // future
  assert.equal(isMissingOutDue('2026-03-02', '16:00:00', 0, at(16 * 60)), true);   // zero delay
});

// ── Missing check-outs ────────────────────────────────────────────────────────
const candidate = (over: Record<string, unknown>) => ({
  event_id: 'e1', employee_id: 7, employee_code: 'T001', employee_name: 'Asha Rao', campus_id: 2,
  campus_name: 'Main', work_date: '2026-03-01', shift_logout_time: '16:00:00', ...over,
});

test('missing OUTs are flagged once each and alert the Director with the missed day', async () => {
  const db = new FakeDb()
    .on(/from attendance_events ev/, { rows: [
      candidate({ event_id: 'old', work_date: '2026-03-01' }),                                  // yesterday: due
      candidate({ event_id: 'soon', employee_id: 8, work_date: '2026-03-02', shift_logout_time: '16:00:00' }), // today 11:00: not yet
      candidate({ event_id: 'done', employee_id: 9, work_date: '2026-03-01' }),                  // already flagged
    ] })
    .on(/insert into attendance_exceptions/, params => ({ rows: params[0] === 9 ? [] : [{ id: 'x1' }] }))
    .on(/insert into notification_outbox/, { rows: [{ id: 'm' }] });

  const count = await flagMissingOuts(depsFor(db), settings(), ist);
  assert.equal(count, 1);
  const exceptions = db.where(/insert into attendance_exceptions/);
  assert.deepEqual(exceptions.map(c => [c.params[0], c.params[3]]), [[7, 'MISSING_OUT'], [9, 'MISSING_OUT']]);
  assert.deepEqual(outbox(db).map(m => m.kind), ['DIRECTOR_MISSING_OUT']);        // none for the already-flagged one
  assert.ok(outbox(db)[0].payload.includes('01 Mar 2026'));                        // the day that was missed
});

test('no flags when everyone has a check-out or no shift was recorded', async () => {
  const db = new FakeDb().on(/from attendance_events ev/, { rows: [] });
  assert.equal(await flagMissingOuts(depsFor(db), settings(), ist), 0);
  assert.equal(db.where(/insert into attendance_exceptions/).length, 0);
});

// ── Digest ────────────────────────────────────────────────────────────────────
const summaryRow = { expected: 50, present: 41, late: 3, unmarked: 9, open_exceptions: 1 };
function digestDb(over: { lastSent?: string | null; activity?: number; summary?: typeof summaryRow } = {}) {
  return new FakeDb()
    .on(/select value #>> '\{\}' as v/, { rows: [{ v: over.lastSent ?? null }] })
    .on(/as total/, { rows: [{ total: over.activity ?? 3 }] })
    .on(/with expected as/, { rows: [over.summary ?? summaryRow] })
    .on(/insert into notification_outbox/, { rows: [{ id: 'm' }] })
    .on(/update attendance_settings/, { rowCount: 1 });
}

test('digest mode queues a summary with the day totals and records when it was sent', async () => {
  const db = digestDb();
  assert.equal(await maybeQueueDigest(depsFor(db), settings({ alertMode: 'digest' }), ist), true);
  const [message] = outbox(db);
  assert.equal(message.kind, 'DIRECTOR_DIGEST');
  assert.equal(message.key, `digest:2026-03-02:${Math.floor((11 * 60) / 60)}`);
  assert.deepEqual(JSON.parse(message.payload).params.slice(0, 6), ['02 Mar 2026', '11:00 AM', '41', '3', '9', '1']);
  const stamp = db.where(/update attendance_settings/)[0];
  assert.equal(stamp.params[0], 'digest_last_sent_at');
  assert.equal(stamp.params[1], NOW.toISOString());
});

test('no digest unless digest mode is on and a Director number is set', async () => {
  for (const s of [settings({ alertMode: 'individual' }), settings({ alertMode: 'mute_normal' }), settings({ alertMode: 'digest', directorWhatsapp: null })]) {
    const db = digestDb();
    assert.equal(await maybeQueueDigest(depsFor(db), s, ist), false);
    assert.equal(outbox(db).length, 0);
  }
});

test('no digest before the interval has passed, when nothing happened, or when there is no one to report', async () => {
  const tooSoon = digestDb({ lastSent: new Date(NOW.getTime() - 10 * 60_000).toISOString() });
  assert.equal(await maybeQueueDigest(depsFor(tooSoon), settings({ alertMode: 'digest' }), ist), false);

  const idle = digestDb({ activity: 0 });
  assert.equal(await maybeQueueDigest(depsFor(idle), settings({ alertMode: 'digest' }), ist), false);

  const empty = digestDb({ summary: { expected: 0, present: 0, late: 0, unmarked: 0, open_exceptions: 0 } });
  assert.equal(await maybeQueueDigest(depsFor(empty), settings({ alertMode: 'digest' }), ist), false);
});

test('a digest is sent again once the interval has passed', async () => {
  const db = digestDb({ lastSent: new Date(NOW.getTime() - 61 * 60_000).toISOString() });
  assert.equal(await maybeQueueDigest(depsFor(db), settings({ alertMode: 'digest' }), ist), true);
});

// ── The whole pass ────────────────────────────────────────────────────────────
test('a sweep runs every step and reports counts', async () => {
  const db = new FakeDb()
    .on(/from attendance_settings/, { rows: [] })
    .on(/from attendance_events ev/, { rows: [] })
    .on(/with due as/, { rows: [] });
  const result = await runSweep(depsFor(db));
  assert.deepEqual(result, {
    outbox: { claimed: 0, sent: 0, stubbed: 0, retried: 0, failed: 0 },
    missingOutFlagged: 0, digestQueued: false, failedSteps: [],
    accrual: { credits: 0, adjustments: 0 },        // the daily leave accrual ran (nothing was due)
  });
});

test('the leave accrual runs once a day: a second pass the same day skips it', async () => {
  const today = istParts(NOW).workDate;
  const db = new FakeDb()
    .on(/select value from attendance_settings where key = \$1/, { rows: [{ value: today }] })
    .on(/from attendance_settings/, { rows: [] })
    .on(/from attendance_events ev/, { rows: [] })
    .on(/with due as/, { rows: [] });
  const result = await runSweep(depsFor(db));
  assert.equal(result.accrual, undefined, 'already done today');
  assert.equal(db.where(/from academic_years/).length, 0, 'and nothing was even loaded for it');
  assert.equal(db.where(/insert into attendance_settings/).length, 0, 'the marker is left as it was');
});

test('a failing leave accrual does not stop the other steps', async () => {
  const db = new FakeDb()
    .on(/select value from attendance_settings where key = \$1/, () => { throw new Error('boom'); })
    .on(/from attendance_settings/, { rows: [] })
    .on(/from attendance_events ev/, { rows: [] })
    .on(/with due as/, { rows: [{
      id: 'm1', recipient_type: 'EMPLOYEE', recipient_e164: '919849136605', kind: 'HELP', delivery_mode: 'TEXT',
      template_name: null, template_language: null, payload: { body: 'x' }, attempts: 1, max_attempts: 5,
    }] });
  const result = await runSweep(depsFor(db));
  assert.deepEqual(result.failedSteps, ['leaveAccrual']);
  assert.equal(result.outbox.claimed, 1);
});

test('one failing step does not stop the others', async () => {
  const db = new FakeDb()
    .on(/from attendance_settings/, { rows: [] })
    .on(/from attendance_events ev/, () => { throw new Error('boom'); })
    .on(/with due as/, { rows: [{
      id: 'm1', recipient_type: 'EMPLOYEE', recipient_e164: '919849136605', kind: 'HELP', delivery_mode: 'TEXT',
      template_name: null, template_language: null, payload: { body: 'x' }, attempts: 1, max_attempts: 5,
    }] });
  const result = await runSweep(depsFor(db));
  assert.deepEqual(result.failedSteps, ['missingOut']);
  assert.equal(result.outbox.claimed, 1);   // the outbox was still processed
  assert.equal(result.outbox.stubbed, 1);   // stub mode
});

test('if settings cannot be read the sweep stops cleanly', async () => {
  const db = new FakeDb().on(/from attendance_settings/, () => { throw new Error('db down'); });
  assert.deepEqual((await runSweep(depsFor(db))).failedSteps, ['settings']);
});

test('the throttled sweep runs only when it wins the time slot', async () => {
  const lost = new FakeDb().on(/update attendance_settings/, { rows: [] });
  assert.equal(await maybeSweep(depsFor(lost), 60), null);
  assert.equal(lost.calls.length, 1);

  const won = new FakeDb()
    .on(/update attendance_settings/, { rows: [{ key: 'sweeper_last_run_at' }] })
    .on(/from attendance_settings/, { rows: [] })
    .on(/from attendance_events ev/, { rows: [] })
    .on(/with due as/, { rows: [] });
  const result = await maybeSweep(depsFor(won), 60);
  assert.ok(result);
  assert.deepEqual(result.failedSteps, []);
});
