import assert from 'node:assert/strict';
import test from 'node:test';
import { FakeDb } from '../attendance/testSupport';
import { runAccrual, runAccrualOncePerDay } from './accrualService';
import { validateOpeningEntries } from './openingBalances';

const year = { id: 1, label: '2026-27', start_date: '2026-06-12', end_date: '2027-04-23', accrual_from: '2026-12-01' };

/** A database with one academic year, one monthly leave type at 1.25 days, and the given employees. */
function build(employees: { id: number; code: string; name: string; joined: string | null }[], ledger: Record<string, unknown>[] = []) {
  return new FakeDb()
    .on(/from academic_years where \$1::date between/, { rows: [year] })
    .on(/from leave_types t join leave_policies p/, { rows: [{ type_id: 1, name: 'Casual Leave', credit_mode: 'MONTHLY', yearly: 0, monthly: 1.25 }] })
    .on(/from employees where status = 'ACTIVE'/, { rows: employees.map(e => ({ id: e.id, employee_code: e.code, employee_name: e.name, joining_date: e.joined })) })
    .on(/from leave_allocations where academic_year_id/, { rows: [] })
    .on(/from leave_ledger where academic_year_id = \$1 group by/, { rows: ledger })
    .on(/insert into leave_ledger/, { rowCount: 1 })
    .on(/insert into attendance_audit_log/, { rowCount: 1 });
}
const A = { id: 7, code: 'A', name: 'Asha', joined: '2024-04-01' };

test('a preview posts nothing, and the real run posts the credit with the right values', async () => {
  const dry = build([A]);
  const preview = await runAccrual(dry.asPool(), { today: '2026-12-01', dryRun: true, userId: null });
  assert.equal(dry.where(/insert into leave_ledger|insert into attendance_audit_log/).length, 0);
  assert.deepEqual([preview.dryRun, preview.creditsPosted, preview.lines.length], [true, 1, 1]);
  assert.deepEqual(preview.lines[0].entries.map(e => [e.period, e.amount, e.effectiveDate]), [['2026-12', 1.25, '2026-12-01']]);

  const real = build([A]);
  const done = await runAccrual(real.asPool(), { today: '2026-12-01', dryRun: false, userId: null });
  assert.deepEqual([done.creditsPosted, done.adjustmentsPosted, done.daysPosted, done.employeesConsidered], [1, 0, 1.25, 1]);
  const insert = real.where(/insert into leave_ledger/)[0];
  assert.match(insert.text, /on conflict do nothing/, 'a month already credited is never posted twice');
  assert.deepEqual(insert.params, [7, 1, 1, 'CREDIT', 1.25, '2026-12-01', '2026-12', 'Accrual: monthly credit', null]);
  assert.equal(real.where(/insert into attendance_audit_log/).length, 1, 'the run is audited');
  assert.match(real.calls.map(c => c.text).join('\n'), /pg_advisory_xact_lock/, 'two runs cannot overlap');
});

test('a month that is already in the ledger is not credited again', async () => {
  const db = build([A], [{ employee_id: 7, leave_type_id: 1, months: ['2026-12'], posted: 1.25 }]);
  const r = await runAccrual(db.asPool(), { today: '2026-12-15', dryRun: false, userId: null });
  assert.equal(r.creditsPosted, 0);
  assert.equal(db.where(/insert into leave_ledger/).length, 0);
  assert.equal(db.where(/insert into attendance_audit_log/).length, 0, 'nothing posted, nothing audited');
});

test('employees without a joining date are listed, not credited; the joining month earns nothing', async () => {
  const db = build([A, { id: 8, code: 'D', name: 'Dev', joined: null }, { id: 9, code: 'C', name: 'Chitra', joined: '2026-12-10' }]);
  const r = await runAccrual(db.asPool(), { today: '2026-12-20', dryRun: true, userId: null });
  assert.deepEqual(r.lines.map(l => l.employeeCode), ['A'], 'only A is due (C is in her joining month)');
  assert.deepEqual(r.missingJoiningDate.map(m => m.employeeCode), ['D']);
});

test('outside every academic year nothing happens', async () => {
  const db = new FakeDb().on(/from academic_years where \$1::date between/, { rows: [] });
  const r = await runAccrual(db.asPool(), { today: '2027-08-01', dryRun: false, userId: null });
  assert.equal(r.year, null);
  assert.equal(r.creditsPosted, 0);
  assert.equal(db.where(/insert into/).length, 0);
});

test('the daily wrapper runs once per IST day and remembers the day', async () => {
  const done = new FakeDb().on(/select value from attendance_settings where key = \$1/, { rows: [{ value: '2026-12-01' }] });
  assert.equal(await runAccrualOncePerDay(done.asPool(), '2026-12-01'), null);
  assert.equal(done.where(/from academic_years/).length, 0);

  const fresh = build([A]).on(/select value from attendance_settings where key = \$1/, { rows: [] }).on(/insert into attendance_settings/, { rowCount: 1 });
  const summary = await runAccrualOncePerDay(fresh.asPool(), '2026-12-01');
  assert.equal(summary?.creditsPosted, 1);
  assert.deepEqual(fresh.where(/insert into attendance_settings/)[0].params, ['leave_accrual_last_run', '2026-12-01']);
});

test('opening balances: days with two decimals, no duplicates, sensible limits', () => {
  assert.deepEqual(validateOpeningEntries({ entries: [{ employeeId: 3, days: '4.25' }, { employeeId: 4, days: 0 }] }), { ok: true, value: [{ employeeId: 3, days: 4.25 }, { employeeId: 4, days: 0 }] });
  for (const body of [null, {}, { entries: [] }, { entries: [{ employeeId: 3, days: -1 }] }, { entries: [{ employeeId: 3, days: 4.123 }] },
    { entries: [{ employeeId: 3, days: 400 }] }, { entries: [{ employeeId: 3, days: 'lots' }] }, { entries: [{ employeeId: 0, days: 1 }] },
    { entries: [{ employeeId: 1.5, days: 1 }] }, { entries: [{ employeeId: 3, days: 1 }, { employeeId: 3, days: 2 }] },
    { entries: Array.from({ length: 2001 }, (_, i) => ({ employeeId: i + 1, days: 1 })) }]) {
    assert.ok(!validateOpeningEntries(body).ok, JSON.stringify(body)?.slice(0, 60));
  }
});
