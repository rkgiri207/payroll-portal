import assert from 'node:assert/strict';
import test from 'node:test';
import type { PoolLike } from '../attendance/db';
import { FakeDb } from '../attendance/testSupport';
import { capReachedText, previewLeave, submitLeaveRequest, type SubmitInput } from './leaveService';

/** A recording fake that answers the loader's queries for one employee who works Mon-Sat at campus 1. */
function build(opts: { dateFull?: boolean; existingKey?: boolean } = {}) {
  let saved = false;
  let rejected = false;
  const record = () => ({
    id: 'req-1', status: rejected ? 'REJECTED' : 'PENDING', employee_id: 7, leave_type_id: 1, academic_year_id: 3, campus_id: 1,
    start_date: '2026-09-15', end_date: '2026-09-15', day_mode: 'FULL', reason: 'Family function', total_days: 1, paid_days: 1,
    lop_days: 0, submitted_via: 'WHATSAPP_LINK', decided_via: rejected ? 'SYSTEM' : null,
    decision_note: rejected ? 'Campus limit of 2 reached on 2026-09-15' : null,
  });
  const db = new FakeDb()
    .on(/from leave_requests where idempotency_key/, () => ({ rows: saved || opts.existingKey ? [record()] : [] }))
    .on(/from employees e left join attendance_employees/, { rows: [{ id: 7, employee_name: 'Asha', employee_code: 'E1', status: 'ACTIVE', reports: false }] })
    .on(/from leave_types where id/, { rows: [{ id: 1, code: 'CASUAL', name: 'Casual Leave', is_paid: true, tracks_balance: true, is_active: true, sort_order: 1 }] })
    .on(/from academic_years where \$1::date between/, { rows: [{ id: 3, label: '2026-27', start_date: '2026-06-12', end_date: '2027-04-23' }] })
    .on(/from employee_campus_assignments/, { rows: [{ campus_id: 1, kind: 'PRIMARY', mode: 'REPLACE', start_date: '2026-06-01', end_date: null }] })
    .on(/from campus_shifts/, { rows: [{ id: 1, login_time: '09:00:00', logout_time: '16:00:00', grace_minutes: 10, weekdays: [1, 2, 3, 4, 5, 6], effective_from: '2026-06-12' }] })
    .on(/from holidays where academic_year_id/, { rows: [] })
    .on(/from leave_policies where leave_type_id/, { rows: [] })
    .on(/leave_balances/, { rows: [{ available: 5 }] })
    .on(/from leave_request_days\s+where employee_id/, { rows: [] })
    .on(/insert into leave_requests/, params => {
      saved = true;
      rejected = /'SYSTEM'/.test(db.calls.at(-1)?.text ?? '') && params.length === 15;
      return { rows: [{ id: 'req-1' }] };
    })
    .on(/from attendance_settings/, { rows: [{ value: 2 }] })
    .on(/select distinct to_char\(d\.leave_date/, { rows: [{ leave_date: '2026-09-15' }] });

  const guarded = (text: string, params?: unknown[]) => {
    if (opts.dateFull && /insert into leave_request_days/.test(text)) throw Object.assign(new Error('LEAVE_CAP_EXCEEDED'), { code: 'LC001' });
    return db.query(text, params);
  };
  const pool: PoolLike = { query: guarded as PoolLike['query'], connect: async () => ({ query: guarded as PoolLike['query'], release() {} }) };
  return { db, pool };
}

const input = (over: Partial<SubmitInput> = {}): SubmitInput => ({
  employeeId: 7, leaveTypeId: 1, startDate: '2026-09-15', endDate: '2026-09-15', dayMode: 'FULL', reason: 'Family function',
  submittedVia: 'WHATSAPP_LINK', enteredByUserId: null, idempotencyKey: 'form-1', today: '2026-09-01', ...over,
});

test('a request with room is saved as pending, with its day rows, and nothing is deducted', async () => {
  const { db, pool } = build();
  const r = await submitLeaveRequest(pool, input());
  assert.equal(r.status, 'SUBMITTED');
  assert.equal(db.where(/insert into leave_requests/).length, 1);
  assert.equal(db.where(/insert into leave_request_days/).length, 1);
  assert.equal(db.where(/insert into leave_ledger/).length, 0, 'submitting never touches the ledger');
  assert.ok(!/status|decided/.test(db.where(/insert into leave_requests/)[0].text.replace('return', '')), 'a normal request leaves status and decision to the database defaults (PENDING)');
});

test('a full date rejects the whole request, keeps an audit record and reports the dates', async () => {
  const { db, pool } = build({ dateFull: true });
  const r = await submitLeaveRequest(pool, input());
  assert.equal(r.status, 'CAP_REACHED');
  if (r.status !== 'CAP_REACHED') return;
  assert.deepEqual([r.cap, r.fullDates, r.request.status, r.request.decidedVia], [2, ['2026-09-15'], 'REJECTED', 'SYSTEM']);
  const rejection = db.where(/insert into leave_requests/).at(-1)!;
  assert.match(rejection.text, /'REJECTED', 'SYSTEM'/);
  assert.match(String(rejection.params.at(-1)), /Campus limit of 2 reached on 2026-09-15/);
});

test('the same key is answered from the saved request, creating nothing', async () => {
  const { db, pool } = build({ existingKey: true });
  const r = await submitLeaveRequest(pool, input());
  assert.equal(r.status, 'DUPLICATE');
  assert.equal(db.where(/insert into leave_requests/).length, 0);
  assert.equal(db.where(/from employees e/).length, 0, 'nothing else is even loaded');
});

test('refusals happen before anything is saved', async () => {
  for (const [over, code] of [
    [{ reason: '  ' }, 'INVALID_INPUT'], [{ startDate: '2026-08-01', endDate: '2026-08-01' }, 'PAST_DATE'],
    [{ startDate: '2027-04-20', endDate: '2027-06-15' }, 'SPANS_YEARS'], [{ startDate: '2026-09-13', endDate: '2026-09-13' }, 'NO_WORKING_DAYS'],
  ] as [Partial<SubmitInput>, string][]) {
    const { db, pool } = build();
    const r = await submitLeaveRequest(pool, input(over));
    assert.equal(r.status === 'REFUSED' ? r.code : r.status, code, JSON.stringify(over));
    assert.equal(db.where(/insert into/).length, 0);
  }
});

test('an admin may enter a past date; an employee may not', async () => {
  const past = { startDate: '2026-08-31', endDate: '2026-08-31' };
  assert.equal((await submitLeaveRequest(build().pool, input({ ...past, submittedVia: 'MANUAL', enteredByUserId: 1 }))).status, 'SUBMITTED');
  const refused = await submitLeaveRequest(build().pool, input(past));
  assert.ok(refused.status === 'REFUSED' && refused.code === 'PAST_DATE');
});

test('preview saves nothing and reports the cost', async () => {
  const { db, pool } = build();
  const r = await previewLeave(pool, { employeeId: 7, leaveTypeId: 1, startDate: '2026-09-15', endDate: '2026-09-16', dayMode: 'FULL', today: '2026-09-01', byAdmin: false });
  assert.ok(r.ok && r.plan.totalDays === 2 && r.plan.paidDays === 2 && r.yearLabel === '2026-27' && r.availableBalance === 5);
  assert.equal(db.where(/insert into/).length, 0);
});

test('the full-date message uses the configured limit and names the dates', () => {
  const two = capReachedText(2, ['2026-09-15']);
  assert.match(two, /^Sorry, leave applications for this date have reached the maximum permitted limit of two employees for your campus\./);
  assert.match(two, /Full on: 15 Sep 2026\./);
  assert.match(two, /Your leave application has not been forwarded to the Director\./);
  assert.match(two, /Please select another date or contact the school administration\.$/);
  assert.match(capReachedText(1, []), /limit of one employee for/);
  assert.match(capReachedText(3, ['2026-09-15', '2026-09-16']), /limit of three employees.*15 Sep 2026, 16 Sep 2026/s);
  assert.match(capReachedText(25, []), /limit of 25 employees/);
  assert.ok(!/Full on/.test(capReachedText(2, [])));
});
