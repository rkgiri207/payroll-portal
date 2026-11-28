import assert from 'node:assert/strict';
import test from 'node:test';
import type { ShiftRow } from '../attendance/shift';
import type { HolidayRow } from './calendar';
import { AP_2026_27 } from './calendarTemplates';
import { cleanReason, DEFAULT_RULES, evaluateLeave, mainCampusOn, type AssignmentRow, type EvalContext, type EvalInput } from './leaveEvaluate';

const shift: ShiftRow = { id: 1, loginTime: '09:00', logoutTime: '16:00', graceMinutes: 10, weekdays: [1, 2, 3, 4, 5, 6], effectiveFrom: '2026-06-12' };
const holidays: HolidayRow[] = AP_2026_27.holidays.map(h => ({ kind: h.kind, status: 'CONFIRMED', startDate: h.startDate, endDate: h.endDate, campusId: null }));
const primary: AssignmentRow = { campusId: 1, kind: 'PRIMARY', mode: 'REPLACE', startDate: '2026-06-01', endDate: null };

const ctx = (over: Partial<EvalContext> = {}): EvalContext => ({
  type: { name: 'Casual Leave', tracksBalance: true, isActive: true },
  year: { label: '2026-27', startDate: '2026-06-12', endDate: '2027-04-23' },
  rules: DEFAULT_RULES, assignments: [primary], shiftsByCampus: { 1: [shift], 2: [shift] }, holidays,
  reportsDuringVacations: false, availableBalance: 5, existingLeaveDates: [], ...over,
});
const input = (startDate: string, endDate = startDate, over: Partial<EvalInput> = {}): EvalInput =>
  ({ startDate, endDate, dayMode: 'FULL', today: '2026-09-01', byAdmin: false, ...over });
const failure = (r: ReturnType<typeof evaluateLeave>) => { assert.ok(!r.ok, 'expected a refusal'); return r; };
const plan = (r: ReturnType<typeof evaluateLeave>) => { assert.ok(r.ok, r.ok ? '' : r.message); return r.plan; };

test('a normal request counts its working days and is fully paid when the balance covers it', () => {
  const p = plan(evaluateLeave(ctx(), input('2026-09-07', '2026-09-09'))); // Mon-Wed
  assert.deepEqual(p.days.map(d => d.date), ['2026-09-07', '2026-09-08', '2026-09-09']);
  assert.deepEqual([p.totalDays, p.paidDays, p.lopDays, p.campusId], [3, 3, 0, 1]);
});

test('holidays, second Saturdays and Sundays are not counted', () => {
  // Thu 1 Oct to Tue 6 Oct 2026: Fri 2 Oct is Gandhi Jayanthi, Sun 4 Oct is off. Working: 1, 3, 5, 6.
  const p = plan(evaluateLeave(ctx(), input('2026-10-01', '2026-10-06')));
  assert.deepEqual(p.days.map(d => d.date), ['2026-10-01', '2026-10-03', '2026-10-05', '2026-10-06']);
  // 10 Oct 2026 is a second Saturday (off); 9 Oct and 12 Oct would be the neighbours (12 Oct starts Dasara vacation)
  assert.equal(failure(evaluateLeave(ctx(), input('2026-10-10'))).code, 'NO_WORKING_DAYS');
  assert.equal(failure(evaluateLeave(ctx(), input('2026-10-04'))).code, 'NO_WORKING_DAYS');
});

test('vacation days are free for most staff, but not for staff who report during vacations', () => {
  assert.equal(failure(evaluateLeave(ctx(), input('2026-10-14'))).code, 'NO_WORKING_DAYS');
  const p = plan(evaluateLeave(ctx({ reportsDuringVacations: true }), input('2026-10-13', '2026-10-14')));
  assert.equal(p.totalDays, 2);
});

test('draft holidays do not shorten a leave', () => {
  const drafts = holidays.map(h => ({ ...h, status: 'DRAFT' as const }));
  assert.equal(plan(evaluateLeave(ctx({ holidays: drafts }), input('2026-10-02'))).totalDays, 1);
});

test('a request must sit inside one academic year', () => {
  const spans = failure(evaluateLeave(ctx(), input('2027-04-20', '2027-06-15')));
  assert.equal(spans.code, 'SPANS_YEARS');
  assert.match(spans.message, /one request for each academic year/);
  const none = failure(evaluateLeave(ctx({ year: null }), input('2026-09-07')));
  assert.equal(none.code, 'NO_ACADEMIC_YEAR');
});

test('employees cannot ask for past dates; an admin can', () => {
  assert.equal(failure(evaluateLeave(ctx(), input('2026-08-31'))).code, 'PAST_DATE');
  assert.equal(plan(evaluateLeave(ctx(), input('2026-08-31', '2026-08-31', { byAdmin: true }))).totalDays, 1);
  assert.equal(plan(evaluateLeave(ctx(), input('2026-09-01'))).totalDays, 1);     // today is fine
});

test('minimum notice applies to employees only', () => {
  const rules = { ...DEFAULT_RULES, minNoticeDays: 2 };
  const tooSoon = failure(evaluateLeave(ctx({ rules }), input('2026-09-02')));
  assert.equal(tooSoon.code, 'NOTICE');
  assert.match(tooSoon.message, /03 Sep 2026/);                                    // earliest allowed date
  assert.equal(plan(evaluateLeave(ctx({ rules }), input('2026-09-03'))).totalDays, 1);
  assert.equal(plan(evaluateLeave(ctx({ rules }), input('2026-09-02', '2026-09-02', { byAdmin: true }))).totalDays, 1);
});

test('half-days: single date only, counts 0.5, and the policy can forbid them', () => {
  const half = plan(evaluateLeave(ctx(), input('2026-09-07', '2026-09-07', { dayMode: 'FIRST_HALF' })));
  assert.deepEqual([half.totalDays, half.days[0].fraction], [0.5, 0.5]);
  assert.equal(failure(evaluateLeave(ctx(), input('2026-09-07', '2026-09-08', { dayMode: 'SECOND_HALF' }))).code, 'INVALID_INPUT');
  const banned = failure(evaluateLeave(ctx({ rules: { ...DEFAULT_RULES, allowHalfDay: false } }), input('2026-09-07', '2026-09-07', { dayMode: 'FIRST_HALF' })));
  assert.equal(banned.code, 'HALF_DAY_NOT_ALLOWED');
});

test('the longest single leave is checked against working days', () => {
  const rules = { ...DEFAULT_RULES, maxConsecutiveDays: 3 };
  assert.equal(plan(evaluateLeave(ctx({ rules }), input('2026-09-07', '2026-09-09'))).totalDays, 3);
  assert.equal(failure(evaluateLeave(ctx({ rules }), input('2026-09-07', '2026-09-10'))).code, 'TOO_LONG');
  // Sunday and a holiday inside the range do not count towards the limit.
  assert.equal(plan(evaluateLeave(ctx({ rules }), input('2026-10-01', '2026-10-03'))).totalDays, 2);
});

test('overlapping an existing leave is refused and names the dates', () => {
  const r = failure(evaluateLeave(ctx({ existingLeaveDates: ['2026-09-08'] }), input('2026-09-07', '2026-09-09')));
  assert.equal(r.code, 'OVERLAP');
  assert.deepEqual(r.dates, ['2026-09-08']);
  // Leave on a day that would not have counted anyway (Sunday) is no conflict.
  assert.ok(evaluateLeave(ctx({ existingLeaveDates: ['2026-09-06'] }), input('2026-09-05', '2026-09-07')).ok);
});

test('the paid and without-pay split follows the policy', () => {
  const short = plan(evaluateLeave(ctx({ availableBalance: 1.5 }), input('2026-09-07', '2026-09-09')));
  assert.deepEqual([short.paidDays, short.lopDays], [1.5, 1.5]);
  const none = plan(evaluateLeave(ctx({ availableBalance: -2 }), input('2026-09-07')));
  assert.deepEqual([none.paidDays, none.lopDays], [0, 1]);

  const refused = failure(evaluateLeave(ctx({ availableBalance: 1, rules: { ...DEFAULT_RULES, insufficientBalance: 'REJECT' } }), input('2026-09-07', '2026-09-09')));
  assert.equal(refused.code, 'INSUFFICIENT_BALANCE');
  assert.equal(refused.availableDays, 1);
  assert.match(refused.message, /only 1 day is available/);

  const negative = plan(evaluateLeave(ctx({ availableBalance: 0, rules: { ...DEFAULT_RULES, insufficientBalance: 'NEGATIVE' } }), input('2026-09-07', '2026-09-08')));
  assert.deepEqual([negative.paidDays, negative.lopDays], [2, 0]);

  const unpaid = plan(evaluateLeave(ctx({ type: { name: 'Unpaid Leave', tracksBalance: false, isActive: true }, availableBalance: 99 }), input('2026-09-07', '2026-09-08')));
  assert.deepEqual([unpaid.paidDays, unpaid.lopDays], [0, 2]);
});

test('an inactive leave type cannot be requested', () => {
  assert.equal(failure(evaluateLeave(ctx({ type: { name: 'Old', tracksBalance: true, isActive: false } }), input('2026-09-07'))).code, 'TYPE_UNAVAILABLE');
});

test('invalid dates are refused', () => {
  for (const [s, e] of [['2026-02-30', '2026-03-01'], ['2026-09-09', '2026-09-07'], ['soon', 'later'], ['2026-9-7', '2026-9-8']]) {
    assert.equal(failure(evaluateLeave(ctx(), input(s, e))).code, 'INVALID_INPUT', `${s} ${e}`);
  }
});

test('the campus follows the employee: a temporary REPLACE campus takes over for its dates', () => {
  const temp: AssignmentRow = { campusId: 2, kind: 'TEMPORARY', mode: 'REPLACE', startDate: '2026-09-08', endDate: '2026-09-09' };
  const p = plan(evaluateLeave(ctx({ assignments: [primary, temp] }), input('2026-09-07', '2026-09-10')));
  assert.deepEqual(p.days.map(d => [d.date, d.campusId]), [['2026-09-07', 1], ['2026-09-08', 2], ['2026-09-09', 2], ['2026-09-10', 1]]);
  assert.equal(p.campusId, 1);
  // An ADDITIONAL temporary campus does not change where leave is counted.
  const extra: AssignmentRow = { ...temp, mode: 'ADDITIONAL' };
  assert.ok(plan(evaluateLeave(ctx({ assignments: [primary, extra] }), input('2026-09-08'))).days.every(d => d.campusId === 1));
});

test('mainCampusOn and a missing assignment', () => {
  assert.equal(mainCampusOn('2026-09-07', [primary]), 1);
  assert.equal(mainCampusOn('2026-05-01', [primary]), null);                       // before the assignment began
  const r = failure(evaluateLeave(ctx({ assignments: [{ ...primary, startDate: '2026-09-08' }] }), input('2026-09-07', '2026-09-08')));
  assert.equal(r.code, 'NO_CAMPUS');
  assert.deepEqual(r.dates, ['2026-09-07']);
});

test('the reason is required, trimmed and limited', () => {
  assert.deepEqual(cleanReason('  Family   function '), { ok: true, value: 'Family function' });
  for (const bad of [undefined, null, '', '   ', 5, 'x'.repeat(501)]) assert.ok(!cleanReason(bad).ok, String(bad));
  assert.ok(cleanReason('x'.repeat(500)).ok);
});
