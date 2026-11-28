import assert from 'node:assert/strict';
import test from 'node:test';
import { FakeDb } from '../attendance/testSupport';
import { applyAllocation, copyPolicies, createLeaveType, updateLeaveType, upsertAllocation, upsertPolicy } from './policyStore';
import {
  validateAllocation, validateBulkAllocation, validateLeaveType, validateLeaveTypeChanges, validatePolicy,
} from './policyValidation';

const tracked = { tracksBalance: true };
const goodPolicy = {
  creditMode: 'MONTHLY', defaultAnnualDays: '12', monthlyAccrualDays: '1.25', carryForwardMode: 'LIMIT', carryForwardLimit: 5, encashmentAllowed: true,
  encashmentLimitDays: 3, insufficientBalance: 'LOP', allowHalfDay: true, minNoticeDays: 2, maxConsecutiveDays: 10,
};

test('a full policy is accepted and cleaned', () => {
  const r = validatePolicy(goodPolicy, tracked);
  assert.deepEqual(r, { ok: true, value: {
    creditMode: 'MONTHLY', defaultAnnualDays: 12, monthlyAccrualDays: 1.25, carryForwardMode: 'LIMIT', carryForwardLimit: 5, encashmentAllowed: true,
    encashmentLimitDays: 3, insufficientBalance: 'LOP', allowHalfDay: true, minNoticeDays: 2, maxConsecutiveDays: 10,
  } });
});

test('carry-forward limit is only kept for LIMIT; the encashment limit only when encashment is allowed', () => {
  const none = validatePolicy({ ...goodPolicy, carryForwardMode: 'ALL', carryForwardLimit: 9 }, tracked);
  assert.ok(none.ok && none.value.carryForwardLimit === null);
  const noEncash = validatePolicy({ ...goodPolicy, encashmentAllowed: false, encashmentLimitDays: 3 }, tracked);
  assert.ok(noEncash.ok && noEncash.value.encashmentLimitDays === null);
  const open = validatePolicy({ ...goodPolicy, maxConsecutiveDays: '', encashmentLimitDays: '' }, tracked);
  assert.ok(open.ok && open.value.maxConsecutiveDays === null && open.value.encashmentLimitDays === null);
});

test('policy errors are specific', () => {
  const cases: [Record<string, unknown>, string][] = [
    [{ ...goodPolicy, creditMode: 'WEEKLY' }, 'How leave is credited'],
    [{ ...goodPolicy, defaultAnnualDays: '12.345' }, '2 decimal places'],
    [{ ...goodPolicy, monthlyAccrualDays: '1.234' }, 'Days credited each month'],
    [{ ...goodPolicy, monthlyAccrualDays: -1 }, 'Days credited each month'],
    [{ ...goodPolicy, monthlyAccrualDays: 'lots' }, 'Days credited each month'],
    [{ ...goodPolicy, defaultAnnualDays: -1 }, 'from 0 to 366'],
    [{ ...goodPolicy, defaultAnnualDays: 400 }, 'from 0 to 366'],
    [{ ...goodPolicy, carryForwardMode: 'LIMIT', carryForwardLimit: '' }, 'most days that can be carried'],
    [{ ...goodPolicy, carryForwardMode: 'SOME' }, 'Carry forward'],
    [{ ...goodPolicy, insufficientBalance: 'SHRUG' }, 'balance is not enough'],
    [{ ...goodPolicy, allowHalfDay: 'yes' }, 'on or off'],
    [{ ...goodPolicy, minNoticeDays: -2 }, 'Minimum notice'],
    [{ ...goodPolicy, maxConsecutiveDays: 0 }, 'Longest single leave'],
    [{ ...goodPolicy, encashmentAllowed: 'no' }, 'Encashment'],
  ];
  for (const [body, fragment] of cases) {
    const r = validatePolicy(body, tracked);
    assert.ok(!r.ok && r.error.includes(fragment), `${JSON.stringify(body)} -> ${r.ok ? 'accepted' : r.error}`);
  }
  assert.ok(!validatePolicy(null, tracked).ok);
});

test('a leave type with no balance (unpaid) keeps only its request rules; balance options are forced inert', () => {
  const r = validatePolicy(goodPolicy, { tracksBalance: false });
  assert.deepEqual(r, { ok: true, value: {
    creditMode: 'MANUAL', defaultAnnualDays: 0, monthlyAccrualDays: 0, carryForwardMode: 'NONE', carryForwardLimit: null, encashmentAllowed: false,
    encashmentLimitDays: null, insufficientBalance: 'LOP', allowHalfDay: true, minNoticeDays: 2, maxConsecutiveDays: 10,
  } });
  // The balance options are not even required for such a type.
  assert.ok(validatePolicy({ allowHalfDay: false }, { tracksBalance: false }).ok);
});

test('leave type input and changes', () => {
  assert.deepEqual(validateLeaveType({ code: ' maternity ', name: ' Maternity Leave ', isPaid: true, tracksBalance: true }),
    { ok: true, value: { code: 'MATERNITY', name: 'Maternity Leave', isPaid: true, tracksBalance: true } });
  for (const body of [null, { code: 'A', name: 'x', isPaid: true, tracksBalance: true }, { code: 'OK', name: '', isPaid: true, tracksBalance: true },
    { code: 'bad code', name: 'x', isPaid: true, tracksBalance: true }, { code: 'OK', name: 'x', isPaid: 'y', tracksBalance: true }]) {
    assert.ok(!validateLeaveType(body).ok, JSON.stringify(body));
  }
  assert.deepEqual(validateLeaveTypeChanges({ name: ' New ', isActive: false, sortOrder: '3' }), { ok: true, value: { name: 'New', isActive: false, sortOrder: 3 } });
  assert.ok(!validateLeaveTypeChanges({}).ok);
  assert.ok(!validateLeaveTypeChanges({ isActive: 'no' }).ok);
});

const noOverrides = { creditModeOverride: null, carryForwardOverride: null, carryForwardLimitOverride: null, monthlyAccrualOverride: null, encashmentOverride: null, encashmentLimitOverride: null };

test('allocation input: days with two decimals, optional overrides', () => {
  assert.deepEqual(validateAllocation({ annualDays: 10.5 }), { ok: true, value: { annualDays: 10.5, ...noOverrides } });
  assert.deepEqual(validateAllocation({ annualDays: '10.25' }), { ok: true, value: { annualDays: 10.25, ...noOverrides } });
  assert.deepEqual(validateAllocation({ annualDays: '8', creditModeOverride: 'UPFRONT', carryForwardOverride: 'LIMIT', carryForwardLimitOverride: '2' }),
    { ok: true, value: { ...noOverrides, annualDays: 8, creditModeOverride: 'UPFRONT', carryForwardOverride: 'LIMIT', carryForwardLimitOverride: 2 } });
  assert.deepEqual(validateAllocation({ annualDays: 12, monthlyAccrualOverride: '1.5', encashmentOverride: true, encashmentLimitOverride: '3.25' }),
    { ok: true, value: { ...noOverrides, annualDays: 12, monthlyAccrualOverride: 1.5, encashmentOverride: true, encashmentLimitOverride: 3.25 } });
  // Encashment switched off for one employee keeps no limit; an empty override follows the policy.
  assert.deepEqual(validateAllocation({ annualDays: 12, encashmentOverride: false, encashmentLimitOverride: 5 }), { ok: true, value: { ...noOverrides, annualDays: 12, encashmentOverride: false } });
  assert.deepEqual(validateAllocation({ annualDays: 12, monthlyAccrualOverride: '', encashmentOverride: '' }), { ok: true, value: { ...noOverrides, annualDays: 12 } });
  for (const body of [{ annualDays: 10.345 }, { annualDays: 12, monthlyAccrualOverride: 1.234 }, { annualDays: 12, monthlyAccrualOverride: -1 }, { annualDays: 12, encashmentOverride: 'yes' },
    { annualDays: 12, encashmentOverride: true, encashmentLimitOverride: -2 }, { annualDays: -1 }, { annualDays: 'x' }, { annualDays: 1, creditModeOverride: 'X' },
    { annualDays: 1, carryForwardOverride: 'LIMIT' }]) {
    assert.ok(!validateAllocation(body).ok, JSON.stringify(body));
  }
});

test('bulk allocation needs a clear target and an explicit overwrite choice', () => {
  assert.deepEqual(validateBulkAllocation({ annualDays: 12, employeeIds: 'ALL', overwrite: false }), { ok: true, value: { annualDays: 12, employeeIds: 'ALL', overwrite: false } });
  const some = validateBulkAllocation({ annualDays: 12, employeeIds: [3, 3, 5], overwrite: true });
  assert.ok(some.ok && JSON.stringify(some.value.employeeIds) === '[3,5]');
  for (const body of [{ annualDays: 12, employeeIds: [], overwrite: true }, { annualDays: 12, employeeIds: [1.5], overwrite: true },
    { annualDays: 12, employeeIds: 'ALL' }, { annualDays: 12.222, employeeIds: 'ALL', overwrite: true }, { employeeIds: 'ALL', overwrite: true }]) {
    assert.ok(!validateBulkAllocation(body).ok, JSON.stringify(body));
  }
});

const pgError = (code: string) => Object.assign(new Error('db'), { code });

test('duplicate leave type code gives a friendly message', async () => {
  const q = { query: async () => { throw pgError('23505'); } };
  const r = await createLeaveType(q as never, { code: 'CASUAL', name: 'x', isPaid: true, tracksBalance: true });
  assert.ok(!r.ok && r.status === 409 && /already exists/.test(r.error));
});

test('pay and balance behaviour of a leave type is frozen once it is used', async () => {
  const type = { id: 1, code: 'CASUAL', name: 'Casual', is_paid: true, tracks_balance: true, is_active: true, sort_order: 1 };
  const used = new FakeDb().on(/from leave_types where id/, { rows: [type] }).on(/exists \(select 1 from leave_requests/, { rows: [{ used: true }] });
  const refused = await updateLeaveType(used, 1, { isPaid: false });
  assert.ok(!refused.ok && refused.status === 409 && /already used/.test(refused.error));
  assert.equal(used.where(/update leave_types/).length, 0);

  // Renaming or deactivating is always fine, even when used.
  const rename = await updateLeaveType(used, 1, { name: 'Casual Leave (CL)', isActive: false });
  assert.ok(rename.ok && rename.value.after.name === 'Casual Leave (CL)' && !rename.value.after.isActive);

  // Setting the same value is not a behaviour change.
  assert.ok((await updateLeaveType(used, 1, { isPaid: true })).ok);

  const unused = new FakeDb().on(/from leave_types where id/, { rows: [type] }).on(/exists \(select 1 from leave_requests/, { rows: [{ used: false }] });
  assert.ok((await updateLeaveType(unused, 1, { tracksBalance: false })).ok);
  assert.ok(!(await updateLeaveType(new FakeDb(), 99, { name: 'x' })).ok);
});

test('policy upsert, copy and allocation SQL carry the right parameters', async () => {
  const policy = validatePolicy(goodPolicy, tracked);
  assert.ok(policy.ok);
  const db = new FakeDb().on(/insert into leave_policies/, { rows: [{
    credit_mode: 'MONTHLY', default_annual_days: '12.0', carry_forward_mode: 'LIMIT', carry_forward_limit: '5.0', encashment_allowed: true,
    encashment_limit_days: '3.0', insufficient_balance: 'LOP', allow_half_day: true, min_notice_days: 2, max_consecutive_days: 10, updated_at: 'now',
  }] });
  const saved = await upsertPolicy(db, 4, 2, policy.value, 9);
  assert.ok(saved.ok && saved.value.defaultAnnualDays === 12 && saved.value.carryForwardLimit === 5);
  assert.deepEqual(db.calls[0].params.slice(0, 2), [2, 4]);          // type, year
  assert.equal(db.calls[0].params[12], 9);                            // who saved it
  assert.equal(db.calls[0].params[13], 1.25);                         // days credited each month
  assert.match(db.calls[0].text, /monthly_accrual_days/);

  const fk = await upsertPolicy({ query: async () => { throw pgError('23503'); } } as never, 4, 2, policy.value, 9);
  assert.ok(!fk.ok && fk.status === 404);

  const copyDb = new FakeDb().on(/insert into leave_policies/, { rowCount: 3 });
  assert.equal(await copyPolicies(copyDb, 1, 2, 9), 3);
  assert.match(copyDb.calls[0].text, /on conflict \(leave_type_id, academic_year_id\) do nothing/);
  assert.deepEqual(copyDb.calls[0].params, [1, 2, 9]);

  const allocDb = new FakeDb().on(/select annual_days::text/, { rows: [{ annual_days: '6.0' }] });
  const alloc = await upsertAllocation(allocDb, 4, 2, 77, { annualDays: 8, ...noOverrides, monthlyAccrualOverride: 1.5, encashmentOverride: true, encashmentLimitOverride: 2 }, 9);
  assert.ok(alloc.ok && alloc.value.before === 6);
  const insert = allocDb.where(/insert into leave_allocations/)[0];
  assert.deepEqual(insert.params.slice(7), [9, 1.5, true, 2], 'who saved it, then the three new per-employee overrides');

  const keep = new FakeDb().on(/insert into leave_allocations/, { rowCount: 5 });
  assert.equal(await applyAllocation(keep, 4, 2, { annualDays: 12, employeeIds: 'ALL', overwrite: false }, 9), 5);
  assert.match(keep.calls[0].text, /do nothing/);
  assert.equal(keep.calls[0].params[4], null);                        // null = every active employee
  const replace = new FakeDb().on(/insert into leave_allocations/, { rowCount: 2 });
  await applyAllocation(replace, 4, 2, { annualDays: 12, employeeIds: [3, 5], overwrite: true }, 9);
  assert.match(replace.calls[0].text, /do update set annual_days/);
  assert.deepEqual(replace.calls[0].params[4], [3, 5]);
});
