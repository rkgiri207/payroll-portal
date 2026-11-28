import assert from 'node:assert/strict';
import test from 'node:test';
import type { ShiftRow } from '../attendance/shift';
import { splitPaidLop } from './balance';
import {
  countWorkingDays, dayStatus, isSecondSaturday, leaveDays, type HolidayKind, type HolidayRow, type WorkdayContext,
} from './calendar';

const shift: ShiftRow = {
  id: 1, loginTime: '09:00', logoutTime: '16:00', graceMinutes: 10,
  weekdays: [1, 2, 3, 4, 5, 6], effectiveFrom: '2026-06-12',
};
const h = (kind: HolidayKind, startDate: string, endDate = startDate, extra: Partial<HolidayRow> = {}): HolidayRow =>
  ({ kind, status: 'CONFIRMED', startDate, endDate, campusId: null, ...extra });
const ctx = (holidays: HolidayRow[], extra: Partial<WorkdayContext> = {}): WorkdayContext =>
  ({ shifts: [shift], holidays, campusId: 1, reportsDuringVacations: false, ...extra });

// The official AP 2026-27 primary calendar (same dates as supabase/data/ap_academic_2026_27_holidays.sql).
const closures = (): HolidayRow[] => [
  ...['2026-06-26', '2026-08-15', '2026-08-21', '2026-08-25', '2026-09-04', '2026-09-14', '2026-10-02', '2026-11-08',
    '2026-12-25', '2027-01-26', '2027-03-06', '2027-03-10', '2027-03-22', '2027-03-26', '2027-04-05', '2027-04-07',
    '2027-04-14', '2027-04-15'].map(d => h('HOLIDAY', d)),
  h('VACATION', '2026-10-12', '2026-10-21'), h('VACATION', '2027-01-11', '2027-01-17'),
  ...['2026-06-13', '2026-07-11', '2026-08-08', '2026-09-12', '2026-10-10', '2026-11-14', '2026-12-12', '2027-01-09',
    '2027-02-13', '2027-03-13'].map(d => h('WEEKLY_OFF', d)),
  ...['2026-06-25', '2026-07-16', '2026-08-04', '2026-09-22', '2026-10-27', '2026-11-24', '2026-12-24', '2026-12-26',
    '2027-01-01', '2027-01-25', '2027-02-28', '2027-03-01', '2027-03-03', '2027-04-19'].map(d => h('OPTIONAL', d)),
];

test('calendar reproduces the printed 229 working days, month by month', () => {
  const c = ctx(closures());
  const months: Array<[string, string, number]> = [
    ['2026-06-12', '2026-06-30', 14], ['2026-07-01', '2026-07-31', 26], ['2026-08-01', '2026-08-31', 22],
    ['2026-09-01', '2026-09-30', 23], ['2026-10-01', '2026-10-31', 16], ['2026-11-01', '2026-11-30', 24],
    ['2026-12-01', '2026-12-31', 25], ['2027-01-01', '2027-01-31', 18], ['2027-02-01', '2027-02-28', 23],
    ['2027-03-01', '2027-03-31', 22], ['2027-04-01', '2027-04-23', 16],
  ];
  for (const [from, to, expected] of months) assert.equal(countWorkingDays(from, to, c), expected, from);
  assert.equal(countWorkingDays('2026-06-12', '2027-04-23', c), 229);
});

test('draft holidays never count', () => {
  const c = ctx([h('HOLIDAY', '2026-10-02', '2026-10-02', { status: 'DRAFT' })]);
  assert.equal(dayStatus('2026-10-02', c).working, true);
});

test('optional holidays never close a day; Sundays and shift-less days do', () => {
  assert.equal(dayStatus('2026-07-16', ctx([h('OPTIONAL', '2026-07-16')])).working, true);
  assert.deepEqual(dayStatus('2026-07-12', ctx([])), { working: false, reason: 'NO_SHIFT' }); // Sunday
});

test('vacation closes the day unless the employee reports during vacations', () => {
  const vac = [h('VACATION', '2026-10-12', '2026-10-21')];
  assert.equal(dayStatus('2026-10-14', ctx(vac)).reason, 'VACATION');
  assert.equal(dayStatus('2026-10-14', ctx(vac, { reportsDuringVacations: true })).working, true);
  // a real public holiday inside a vacation still closes the day for them
  const both = [...vac, h('HOLIDAY', '2026-10-14')];
  assert.equal(dayStatus('2026-10-14', ctx(both, { reportsDuringVacations: true })).reason, 'HOLIDAY');
});

test('special working day overrides a Sunday and a holiday', () => {
  assert.equal(dayStatus('2026-07-12', ctx([h('SPECIAL_WORKING_DAY', '2026-07-12')])).working, true);
  assert.equal(dayStatus('2026-10-02', ctx([h('HOLIDAY', '2026-10-02'), h('SPECIAL_WORKING_DAY', '2026-10-02')])).working, true);
});

test('campus-specific holidays apply only to that campus', () => {
  const rows = [h('HOLIDAY', '2026-09-01', '2026-09-01', { campusId: 2 })];
  assert.equal(dayStatus('2026-09-01', ctx(rows, { campusId: 1 })).working, true);
  assert.equal(dayStatus('2026-09-01', ctx(rows, { campusId: 2 })).working, false);
});

test('second Saturday helper', () => {
  assert.equal(isSecondSaturday('2026-07-11'), true);
  assert.equal(isSecondSaturday('2026-07-04'), false);
  assert.equal(isSecondSaturday('2026-07-18'), false);
  assert.equal(isSecondSaturday('2027-04-10'), true); // helper only; the calendar chose not to close it
});

test('leaveDays skips closures and handles half days', () => {
  const c = ctx(closures());
  // Fri 2 Oct (Gandhi Jayanthi) to Mon 5 Oct: Sat 3 and Mon 5 are working
  assert.deepEqual(leaveDays('2026-10-02', '2026-10-05', false, c).map(d => d.date), ['2026-10-03', '2026-10-05']);
  assert.deepEqual(leaveDays('2026-10-05', '2026-10-05', true, c), [{ date: '2026-10-05', days: 0.5 }]);
  assert.throws(() => leaveDays('2026-10-05', '2026-10-06', true, c));
  assert.deepEqual(leaveDays('2026-10-02', '2026-10-02', false, c), []); // nothing to take
});

test('invalid dates are rejected', () => {
  assert.throws(() => dayStatus('2026-02-30', ctx([])));
  assert.throws(() => dayStatus('2026-2-3', ctx([])));
});

test('paid/LOP split', () => {
  const base = { tracksBalance: true };
  assert.deepEqual(splitPaidLop({ ...base, requestedDays: 2, balance: 5, insufficientBalance: 'LOP' }), { ok: true, paidDays: 2, lopDays: 0 });
  assert.deepEqual(splitPaidLop({ ...base, requestedDays: 3, balance: 1.5, insufficientBalance: 'LOP' }), { ok: true, paidDays: 1.5, lopDays: 1.5 });
  assert.deepEqual(splitPaidLop({ ...base, requestedDays: 2, balance: 0, insufficientBalance: 'LOP' }), { ok: true, paidDays: 0, lopDays: 2 });
  assert.deepEqual(splitPaidLop({ ...base, requestedDays: 2, balance: -3, insufficientBalance: 'LOP' }), { ok: true, paidDays: 0, lopDays: 2 });
  assert.deepEqual(splitPaidLop({ ...base, requestedDays: 3, balance: 1, insufficientBalance: 'REJECT' }), { ok: false, reason: 'INSUFFICIENT_BALANCE', availableDays: 1 });
  assert.deepEqual(splitPaidLop({ ...base, requestedDays: 3, balance: 1, insufficientBalance: 'NEGATIVE' }), { ok: true, paidDays: 3, lopDays: 0 });
  assert.deepEqual(splitPaidLop({ tracksBalance: false, requestedDays: 2, balance: 9, insufficientBalance: 'REJECT' }), { ok: true, paidDays: 0, lopDays: 2 });
  assert.deepEqual(splitPaidLop({ ...base, requestedDays: 0.5, balance: 0.5, insufficientBalance: 'REJECT' }), { ok: true, paidDays: 0.5, lopDays: 0 });
  assert.throws(() => splitPaidLop({ ...base, requestedDays: 0.3, balance: 1, insufficientBalance: 'LOP' }));
  assert.throws(() => splitPaidLop({ ...base, requestedDays: 0, balance: 1, insufficientBalance: 'LOP' }));
});
