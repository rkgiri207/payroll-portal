import assert from 'node:assert/strict';
import test from 'node:test';
import { ACCRUAL_PREFIX, eligibleMonths, monthsBetween, nextMonth, planAccrual, type AccrualInput } from './accrual';
import { isTwoDecimals, round2, splitPaidLop } from './balance';

const base = (over: Partial<AccrualInput> = {}): AccrualInput => ({
  today: '2026-12-01', year: { startDate: '2026-06-12', endDate: '2027-04-23', accrualFrom: '2026-12-01' }, joiningDate: '2024-04-01',
  mode: 'MONTHLY', monthlyDays: 1, yearlyDays: 12, creditedMonths: [], postedTotal: 0, ...over,
});
/** Apply a plan to the "ledger" the way the job does, so the next plan sees what was posted. */
const apply = (a: AccrualInput): AccrualInput => {
  const plan = planAccrual(a);
  return {
    ...a,
    creditedMonths: [...a.creditedMonths, ...plan.entries.filter(e => e.entryType === 'CREDIT').map(e => e.period)],
    postedTotal: round2(a.postedTotal + plan.entries.reduce((s, e) => s + e.amount, 0)),
  };
};
const credits = (a: AccrualInput) => planAccrual(a).entries.map(e => `${e.period}:${e.amount}:${e.entryType === 'CREDIT' ? 'credit' : 'adjust'}`);

test('months: next month wraps the year, ranges are inclusive', () => {
  assert.equal(nextMonth('2026-11'), '2026-12');
  assert.equal(nextMonth('2026-12'), '2027-01');
  assert.deepEqual(monthsBetween('2026-11', '2027-02'), ['2026-11', '2026-12', '2027-01', '2027-02']);
  assert.deepEqual(monthsBetween('2026-12', '2026-12'), ['2026-12']);
  assert.deepEqual(monthsBetween('2027-01', '2026-12'), []);
  assert.throws(() => nextMonth('2026-1'));
});

test('going live on 1 December: December is credited that day, and nothing before December ever is', () => {
  const day1 = planAccrual(base());
  assert.deepEqual(day1.entries.map(e => [e.period, e.amount, e.effectiveDate]), [['2026-12', 1, '2026-12-01']]);
  assert.deepEqual(day1.eligibleMonths, ['2026-12']);
  // Run daily: nothing more until the next month.
  assert.equal(planAccrual(apply(base({ today: '2026-12-01' }))).skipped, 'NOTHING_DUE');
  assert.equal(planAccrual(apply(base({ today: '2026-12-20' }))).skipped, 'NOTHING_DUE');
  // Each later month posts its own credit on the 1st.
  let a = apply(base());
  a = { ...a, today: '2027-01-01' };
  assert.deepEqual(credits(a), ['2027-01:1:credit']);
  a = apply(a);
  a = { ...a, today: '2027-04-23' };
  assert.deepEqual(credits({ ...a, today: '2027-03-01' }), ['2027-02:1:credit', '2027-03:1:credit'], 'a missed day is caught up');
  assert.deepEqual(eligibleMonths({ ...a, today: '2027-04-23' }), ['2026-12', '2027-01', '2027-02', '2027-03', '2027-04']);
});

test('a staff member who joined years ago and one who joined in November both start in December', () => {
  assert.deepEqual(eligibleMonths(base({ today: '2026-12-15', joiningDate: '2024-04-01' })), ['2026-12']);
  assert.deepEqual(eligibleMonths(base({ today: '2026-12-15', joiningDate: '2026-11-15' })), ['2026-12']);
  assert.deepEqual(eligibleMonths(base({ today: '2026-12-15', joiningDate: '2026-11-30' })), ['2026-12']);
});

test('the joining month earns nothing; credits start on the 1st of the next month', () => {
  // Joins 10 December: no December credit, the first credit is 1 January.
  const dec = base({ today: '2026-12-20', joiningDate: '2026-12-10' });
  assert.equal(planAccrual(dec).skipped, 'NOT_STARTED');
  assert.deepEqual(planAccrual(dec).entries, []);
  const jan = base({ today: '2027-01-01', joiningDate: '2026-12-10' });
  assert.deepEqual(credits(jan), ['2027-01:1:credit']);
  // Joining on the 1st or the last day of a month makes no difference: the joining month never earns.
  assert.deepEqual(eligibleMonths(base({ today: '2027-01-05', joiningDate: '2026-12-01' })), ['2027-01']);
  assert.deepEqual(eligibleMonths(base({ today: '2027-01-05', joiningDate: '2026-12-31' })), ['2027-01']);
  // Joined across New Year.
  assert.deepEqual(eligibleMonths(base({ today: '2027-02-10', joiningDate: '2027-01-31' })), ['2027-02']);
  // Joined after today: nothing yet.
  assert.deepEqual(eligibleMonths(base({ today: '2026-12-15', joiningDate: '2027-02-01' })), []);
});

test('no joining date, no accrual', () => {
  const p = planAccrual(base({ joiningDate: null }));
  assert.equal(p.skipped, 'NO_JOINING_DATE');
  assert.deepEqual(p.entries, []);
  assert.deepEqual(eligibleMonths(base({ joiningDate: null })), []);
});

test('a year with no "accrue from" starts crediting in its first month, dated its first day', () => {
  const year = { startDate: '2026-06-12', endDate: '2027-04-23', accrualFrom: null };
  const june = planAccrual(base({ today: '2026-06-12', year }));
  assert.deepEqual(june.entries.map(e => [e.period, e.effectiveDate]), [['2026-06', '2026-06-12']], 'dated the first day of the year, not 1 June (before it began)');
  const aug = planAccrual(base({ today: '2026-08-01', year }));
  assert.deepEqual(aug.entries.map(e => [e.period, e.effectiveDate]), [['2026-06', '2026-06-12'], ['2026-07', '2026-07-01'], ['2026-08', '2026-08-01']]);
});

test('nothing is credited outside the academic year or before it starts accruing', () => {
  assert.equal(planAccrual(base({ today: '2026-11-30' })).skipped, 'NOT_STARTED', 'before the accrue-from month');
  assert.equal(planAccrual(base({ today: '2026-05-01' })).skipped, 'NOT_STARTED', 'before the year');
  assert.equal(planAccrual(base({ today: '2027-05-01' })).skipped, 'NOT_STARTED', 'after the year');
  assert.deepEqual(eligibleMonths(base({ today: '2027-04-23' })).at(-1), '2027-04', 'the last month is credited on 1 April');
  // A mid-month "accrue from" means that month.
  assert.deepEqual(eligibleMonths(base({ today: '2026-12-20', year: { startDate: '2026-06-12', endDate: '2027-04-23', accrualFrom: '2026-12-15' } })), ['2026-12']);
});

test('two decimal places add up exactly', () => {
  let a = base({ monthlyDays: 1.25, today: '2026-12-01' });
  for (const today of ['2026-12-01', '2027-01-01', '2027-02-01']) a = apply({ ...a, today });
  assert.equal(a.postedTotal, 3.75);
  assert.equal(planAccrual({ ...a, today: '2027-02-15' }).skipped, 'NOTHING_DUE');
  let b = base({ monthlyDays: 1.1 });
  for (const today of ['2026-12-01', '2027-01-01', '2027-02-01']) b = apply({ ...b, today });
  assert.equal(b.postedTotal, 3.3, '1.1 three times is 3.3, not 3.3000000000000003');
});

test('raising the monthly days adds the missing part for the months already credited, once', () => {
  // Dec and Jan were credited at 1 day. In February the Director changes it to 1.5.
  let a = base({ today: '2027-02-01', creditedMonths: ['2026-12', '2027-01'], postedTotal: 2, monthlyDays: 1.5 });
  const p = planAccrual(a);
  assert.deepEqual(p.entries.map(e => [e.entryType, e.period, e.amount]), [['CREDIT', '2027-02', 1.5], ['ADJUSTMENT', '2027-02', 1]]);
  assert.ok(p.entries[1].reason.startsWith(ACCRUAL_PREFIX) && /catch-up/.test(p.entries[1].reason));
  a = apply(a);
  assert.equal(a.postedTotal, 4.5, '3 months at 1.5');
  assert.equal(planAccrual(a).skipped, 'NOTHING_DUE', 'a second run changes nothing');
  assert.equal(planAccrual({ ...a, today: '2027-03-01' }).entries.map(e => e.amount).join(), '1.5');
});

test('lowering the monthly days never takes days back', () => {
  const a = base({ today: '2027-02-01', creditedMonths: ['2026-12', '2027-01'], postedTotal: 2, monthlyDays: 0.5 });
  const p = planAccrual(a);
  assert.deepEqual(p.entries.map(e => [e.entryType, e.amount]), [['CREDIT', 0.5]], 'only the new month, at the new number');
  assert.equal(p.entries.some(e => e.amount < 0), false);
  assert.equal(planAccrual(apply(a)).skipped, 'NOTHING_DUE');
});

test('a zero monthly number credits nothing', () => {
  const p = planAccrual(base({ monthlyDays: 0 }));
  assert.deepEqual(p.entries, []);
  assert.equal(p.skipped, 'NOTHING_DUE');
});

test('"all at the start": the yearly days once, in the first eligible month; a later increase is added, a decrease ignored', () => {
  const up = base({ mode: 'UPFRONT', today: '2026-12-01', yearlyDays: 12 });
  assert.deepEqual(planAccrual(up).entries.map(e => [e.entryType, e.period, e.amount, e.effectiveDate]), [['CREDIT', '2026-12', 12, '2026-12-01']]);
  let a = apply(up);
  assert.equal(planAccrual({ ...a, today: '2027-02-01' }).skipped, 'NOTHING_DUE', 'later months add nothing');
  const raised = planAccrual({ ...a, today: '2027-02-01', yearlyDays: 14.5 });
  assert.deepEqual(raised.entries.map(e => [e.entryType, e.amount]), [['ADJUSTMENT', 2.5]]);
  assert.match(raised.entries[0].reason, /^Accrual: yearly days changed/);
  assert.equal(planAccrual({ ...apply({ ...a, today: '2027-02-01', yearlyDays: 14.5 }), today: '2027-03-01', yearlyDays: 14.5 }).skipped, 'NOTHING_DUE');
  assert.equal(planAccrual({ ...a, today: '2027-02-01', yearlyDays: 8 }).skipped, 'NOTHING_DUE', 'a decrease never takes days back');
  // A joiner gets their yearly days in their first eligible month.
  assert.deepEqual(planAccrual(base({ mode: 'UPFRONT', today: '2027-02-10', joiningDate: '2027-01-15', yearlyDays: 12 })).entries.map(e => e.period), ['2027-02']);
});

test('"only when I add it" credits nothing', () => {
  assert.equal(planAccrual(base({ mode: 'MANUAL' })).skipped, 'MANUAL');
  assert.deepEqual(planAccrual(base({ mode: 'MANUAL' })).entries, []);
});

test('balances with two decimals work in the paid / without-pay split', () => {
  assert.ok(isTwoDecimals(1.25) && isTwoDecimals(0.1 + 0.2) && !isTwoDecimals(1.234) && !isTwoDecimals(Number.NaN));
  assert.equal(round2(1.1 - 0.8), 0.3);
  assert.deepEqual(splitPaidLop({ requestedDays: 2, balance: 1.25, tracksBalance: true, insufficientBalance: 'LOP' }), { ok: true, paidDays: 1.25, lopDays: 0.75 });
  assert.deepEqual(splitPaidLop({ requestedDays: 1, balance: 0.3, tracksBalance: true, insufficientBalance: 'LOP' }), { ok: true, paidDays: 0.3, lopDays: 0.7 });
  assert.deepEqual(splitPaidLop({ requestedDays: 0.5, balance: 3.75, tracksBalance: true, insufficientBalance: 'REJECT' }), { ok: true, paidDays: 0.5, lopDays: 0 });
  assert.deepEqual(splitPaidLop({ requestedDays: 3, balance: 2.6, tracksBalance: true, insufficientBalance: 'REJECT' }), { ok: false, reason: 'INSUFFICIENT_BALANCE', availableDays: 2.6 });
  assert.throws(() => splitPaidLop({ requestedDays: 1, balance: 1.234, tracksBalance: true, insufficientBalance: 'LOP' }));
  assert.throws(() => splitPaidLop({ requestedDays: 0.25, balance: 1, tracksBalance: true, insufficientBalance: 'LOP' }), 'a request is still counted in half days');
});
