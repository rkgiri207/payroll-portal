import assert from 'node:assert/strict';
import test from 'node:test';
import { FakeDb } from '../attendance/testSupport';
import { approveLeave, cancelLeave, decisionText, rejectLeave } from './decisionService';
import type { LeaveRequestRecord } from './leaveRequestStore';

const row = (over: Record<string, unknown> = {}) => ({
  id: 'req-1', status: 'PENDING', employee_id: 7, leave_type_id: 1, academic_year_id: 3, campus_id: 1,
  start_date: '2026-09-07', end_date: '2026-09-08', day_mode: 'FULL', reason: 'Family function',
  total_days: 2, paid_days: 2, lop_days: 0, submitted_via: 'WHATSAPP_LINK', decided_via: null, decision_note: null, ...over,
});

function build(opts: { status?: string; balance?: number; rule?: string; deduction?: number | null } = {}) {
  const db = new FakeDb()
    .on(/from leave_requests where id = \$1 for update/, { rows: [row({ status: opts.status ?? 'PENDING' })] })
    .on(/leave_balances/, { rows: [{ balance: opts.balance ?? 2 }] })
    .on(/from leave_types t left join leave_policies/, { rows: [{ name: 'Casual Leave', tracks_balance: true, insufficient_balance: opts.rule ?? 'LOP' }] })
    .on(/entry_type = 'DEDUCTION'/, { rows: opts.deduction === null ? [] : [{ amount: opts.deduction ?? 2 }] });
  return { db, pool: db.asPool() };
}
const inserts = (db: FakeDb) => db.where(/insert into leave_ledger/);

test('approving deducts the paid days once, fixes the split from the balance now, and locks the balance first', async () => {
  const { db, pool } = build({ balance: 1 });                       // 2 days asked, 1 available
  const r = await approveLeave(pool, { requestId: 'req-1', via: 'WEB', userId: 5 });
  assert.equal(r.status, 'DONE');
  const update = db.where(/update leave_requests/)[0];
  assert.deepEqual(update.params, ['req-1', 'WEB', 5, 1, 1]);        // paid 1, without pay 1
  assert.equal(inserts(db).length, 1);
  assert.match(inserts(db)[0].text, /'DEDUCTION'/);
  assert.equal(inserts(db)[0].params[3], -1);                        // negative amount: a deduction
  const order = db.calls.map(c => c.text);
  assert.ok(order.findIndex(t => /pg_advisory_xact_lock/.test(t)) < order.findIndex(t => /update leave_requests/.test(t)), 'the balance is locked before the decision is written');
});

test('with no balance left nothing is deducted; the whole leave is without pay', async () => {
  const { db, pool } = build({ balance: 0 });
  await approveLeave(pool, { requestId: 'req-1', via: 'WEB', userId: 5 });
  assert.deepEqual(db.where(/update leave_requests/)[0].params.slice(3), [0, 2]);
  assert.equal(inserts(db).length, 0);
});

test('a policy that refuses going beyond the balance blocks the approval and writes nothing', async () => {
  const { db, pool } = build({ balance: 1, rule: 'REJECT' });
  const r = await approveLeave(pool, { requestId: 'req-1', via: 'WEB', userId: 5 });
  assert.ok(r.status === 'REFUSED' && r.code === 'INSUFFICIENT_BALANCE' && /Only 1 day of Casual Leave is left/.test(r.message));
  assert.equal(db.where(/update leave_requests/).length, 0);
  assert.equal(inserts(db).length, 0);
});

test('an already-decided request is reported, not decided again', async () => {
  for (const status of ['APPROVED', 'REJECTED', 'CANCELLED']) {
    const { db, pool } = build({ status });
    const r = await approveLeave(pool, { requestId: 'req-1', via: 'WHATSAPP', userId: null });
    assert.equal(r.status, 'ALREADY', status);
    assert.equal(db.where(/update leave_requests|insert into leave_ledger/).length, 0);
  }
});

test('rejecting needs a reason of sensible length, and checks it before touching the database', async () => {
  for (const note of [undefined, '', '   ', 'x'.repeat(501)]) {
    const { db, pool } = build();
    const r = await rejectLeave(pool, { requestId: 'req-1', via: 'WEB', userId: 5, note });
    assert.ok(r.status === 'REFUSED' && r.code === 'INVALID_INPUT', String(note));
    assert.equal(db.calls.length, 0);
  }
  const { db, pool } = build();
  const ok = await rejectLeave(pool, { requestId: 'req-1', via: 'WEB', userId: 5, note: '  Exams   that week ' });
  assert.equal(ok.status, 'DONE');
  assert.equal(db.where(/update leave_requests/)[0].params[3], 'Exams that week');
  assert.equal(inserts(db).length, 0, 'rejecting never touches the ledger');
});

test('cancelling approved leave posts one reversal of exactly what was deducted', async () => {
  const { db, pool } = build({ status: 'APPROVED', deduction: 1.5 });
  const r = await cancelLeave(pool, { requestId: 'req-1', canceller: { by: 'DIRECTOR' }, reason: 'School event', today: '2026-09-02' });
  assert.equal(r.status, 'DONE');
  assert.equal(inserts(db).length, 1);
  assert.match(inserts(db)[0].text, /'REVERSAL'/);
  assert.equal(inserts(db)[0].params[3], 1.5);                       // positive: gives the days back
  assert.match(String(inserts(db)[0].params[6]), /Cancelled by director: School event/);
});

test('cancelling approved leave that had no paid days posts no reversal', async () => {
  const { db, pool } = build({ status: 'APPROVED', deduction: null });
  await cancelLeave(pool, { requestId: 'req-1', canceller: { by: 'ADMIN' }, reason: 'Mistake', today: '2026-09-02' });
  assert.equal(inserts(db).length, 0);
  assert.equal(db.where(/update leave_requests/).length, 1);
});

test('who may cancel what', async () => {
  const own = await cancelLeave(build().pool, { requestId: 'req-1', canceller: { by: 'EMPLOYEE', employeeId: 7 }, reason: '', today: '2026-09-02' });
  assert.equal(own.status, 'DONE');                                  // own pending request, no reason needed
  const other = await cancelLeave(build().pool, { requestId: 'req-1', canceller: { by: 'EMPLOYEE', employeeId: 8 }, reason: '', today: '2026-09-02' });
  assert.equal(other.status, 'NOT_FOUND');                           // someone else's request looks like it does not exist
  const approved = await cancelLeave(build({ status: 'APPROVED' }).pool, { requestId: 'req-1', canceller: { by: 'EMPLOYEE', employeeId: 7 }, reason: 'x', today: '2026-09-02' });
  assert.ok(approved.status === 'REFUSED' && approved.code === 'NOT_ALLOWED');
  const noWhy = await cancelLeave(build({ status: 'APPROVED' }).pool, { requestId: 'req-1', canceller: { by: 'DIRECTOR' }, reason: '', today: '2026-09-02' });
  assert.ok(noWhy.status === 'REFUSED' && noWhy.code === 'INVALID_INPUT');
  const rejected = await cancelLeave(build({ status: 'REJECTED' }).pool, { requestId: 'req-1', canceller: { by: 'DIRECTOR' }, reason: 'x', today: '2026-09-02' });
  assert.ok(rejected.status === 'REFUSED');
  const twice = await cancelLeave(build({ status: 'CANCELLED' }).pool, { requestId: 'req-1', canceller: { by: 'DIRECTOR' }, reason: 'x', today: '2026-09-02' });
  assert.equal(twice.status, 'ALREADY');
});

test('decision wording for the employee', () => {
  const r = (over: Partial<LeaveRequestRecord>): LeaveRequestRecord => ({
    id: 'x', status: 'APPROVED', employeeId: 1, leaveTypeId: 1, academicYearId: 1, campusId: 1, startDate: '2026-09-07', endDate: '2026-09-08',
    dayMode: 'FULL', reason: 'r', totalDays: 2, paidDays: 2, lopDays: 0, submittedVia: 'WHATSAPP_LINK', decidedVia: 'WEB', decisionNote: null, ...over,
  });
  assert.equal(decisionText(r({}), 'Casual Leave'), 'Your Casual Leave request for 07 Sep 2026 to 08 Sep 2026 (2 days) has been approved.');
  assert.match(decisionText(r({ paidDays: 1, lopDays: 1 }), 'Casual Leave'), /1 of these 2 days is without pay\./);
  assert.match(decisionText(r({ paidDays: 0, lopDays: 2 }), 'Casual Leave'), /All of these days are without pay\./);
  assert.match(decisionText(r({ startDate: '2026-09-07', endDate: '2026-09-07', totalDays: 1, paidDays: 0, lopDays: 1 }), 'Casual Leave'), /for 07 Sep 2026 \(1 day\) has been approved\. This day is without pay\./);
  assert.equal(decisionText(r({ status: 'REJECTED', decisionNote: 'Exams that week' }), 'Sick Leave'), 'Your Sick Leave request for 07 Sep 2026 to 08 Sep 2026 was not approved. Reason: Exams that week');
  assert.match(decisionText(r({ status: 'CANCELLED' }), 'Sick Leave'), /has been cancelled\.$/);
});
