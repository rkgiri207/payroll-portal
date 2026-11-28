import assert from 'node:assert/strict';
import test from 'node:test';
import type { ShiftRow } from '../attendance/shift';
import type { HolidayRow } from './calendar';
import { AP_2026_27 } from './calendarTemplates';
import type { AssignmentRow } from './leaveEvaluate';
import { clockText, evaluatePermission, timeRangeText, type PermissionContext, type PermissionInput } from './permissionEvaluate';

const shift: ShiftRow = { id: 1, loginTime: '09:00:00', logoutTime: '16:00:00', graceMinutes: 10, weekdays: [1, 2, 3, 4, 5, 6], effectiveFrom: '2026-06-12' };
const holidays: HolidayRow[] = AP_2026_27.holidays.map(h => ({ kind: h.kind, status: 'CONFIRMED', startDate: h.startDate, endDate: h.endDate, campusId: null }));
const primary: AssignmentRow = { campusId: 1, kind: 'PRIMARY', mode: 'REPLACE', startDate: '2026-06-01', endDate: null };

const ctx = (over: Partial<PermissionContext> = {}): PermissionContext => ({
  inAcademicYear: true, assignments: [primary], shiftsByCampus: { 1: [shift], 2: [shift] }, holidays, reportsDuringVacations: false,
  onLeave: false, existing: [], monthCount: 0, maxMinutes: null, maxPerMonth: null, ...over,
});
// Tuesday 1 Sep 2026, 10:30 IST
const input = (date: string, startTime: string, endTime: string, over: Partial<PermissionInput> = {}): PermissionInput =>
  ({ date, startTime, endTime, today: '2026-09-01', nowMinutes: 10 * 60 + 30, byAdmin: false, ...over });
const refusal = (r: ReturnType<typeof evaluatePermission>) => { assert.ok(!r.ok, 'expected a refusal'); return r; };

test('a normal permission is accepted with its length and campus', () => {
  const r = evaluatePermission(ctx(), input('2026-09-08', '10:00', '11:30'));
  assert.ok(r.ok);
  assert.deepEqual(r.plan, { campusId: 1, startTime: '10:00', endTime: '11:30', minutes: 90 });
});

test('times and dates must make sense', () => {
  for (const [d, s, e] of [['2026-02-30', '10:00', '11:00'], ['2026-09-08', '10:00', '10:00'], ['2026-09-08', '11:00', '10:00'],
    ['2026-09-08', '25:00', '26:00'], ['2026-09-08', '10:00', ''], ['2026-09-08', '9:00', '10:00'], ['soon', '10:00', '11:00']]) {
    assert.equal(refusal(evaluatePermission(ctx(), input(d, s, e))).code, 'INVALID_INPUT', `${d} ${s} ${e}`);
  }
});

test('past days and times that have already passed are refused for employees, not for an admin', () => {
  assert.equal(refusal(evaluatePermission(ctx(), input('2026-08-31', '10:00', '11:00'))).code, 'PAST_DATE');
  assert.equal(refusal(evaluatePermission(ctx(), input('2026-09-01', '09:30', '10:30'))).code, 'TIME_PASSED', 'today, ending at or before now');
  assert.ok(evaluatePermission(ctx(), input('2026-09-01', '10:00', '11:30')).ok, 'today, still going on');
  assert.ok(evaluatePermission(ctx(), input('2026-09-01', '14:00', '15:00')).ok, 'today, later');
  assert.ok(evaluatePermission(ctx(), input('2026-08-31', '10:00', '11:00', { byAdmin: true })).ok);
  assert.ok(evaluatePermission(ctx(), input('2026-09-01', '09:30', '10:30', { byAdmin: true })).ok);
});

test('it must be inside the academic year, on a working day, and not on a leave day', () => {
  assert.equal(refusal(evaluatePermission(ctx({ inAcademicYear: false }), input('2026-09-08', '10:00', '11:00'))).code, 'NO_ACADEMIC_YEAR');
  assert.equal(refusal(evaluatePermission(ctx(), input('2026-09-06', '10:00', '11:00'))).code, 'NOT_WORKING_DAY');     // Sunday
  assert.equal(refusal(evaluatePermission(ctx(), input('2026-10-02', '10:00', '11:00'))).code, 'NOT_WORKING_DAY');     // Gandhi Jayanthi
  assert.equal(refusal(evaluatePermission(ctx(), input('2026-10-10', '10:00', '11:00'))).code, 'NOT_WORKING_DAY');     // second Saturday
  assert.equal(refusal(evaluatePermission(ctx(), input('2026-10-14', '10:00', '11:00'))).code, 'NOT_WORKING_DAY');     // Dasara vacation
  assert.ok(evaluatePermission(ctx({ reportsDuringVacations: true }), input('2026-10-14', '10:00', '11:00')).ok, 'staff who report in vacations');
  assert.equal(refusal(evaluatePermission(ctx({ onLeave: true }), input('2026-09-08', '10:00', '11:00'))).code, 'ON_LEAVE');
});

test('it must be within the shift hours', () => {
  const early = refusal(evaluatePermission(ctx(), input('2026-09-08', '08:30', '09:30')));
  assert.equal(early.code, 'OUTSIDE_SHIFT');
  assert.match(early.message, /9:00 AM to 4:00 PM/);
  assert.equal(refusal(evaluatePermission(ctx(), input('2026-09-08', '15:30', '16:30'))).code, 'OUTSIDE_SHIFT');
  assert.ok(evaluatePermission(ctx(), input('2026-09-08', '09:00', '16:00')).ok, 'the whole shift is allowed');
  assert.ok(evaluatePermission(ctx(), input('2026-09-08', '15:00', '16:00')).ok, 'ending exactly at closing time');
});

test('length limits: at least 5 minutes, and the configured maximum', () => {
  assert.equal(refusal(evaluatePermission(ctx(), input('2026-09-08', '10:00', '10:04'))).code, 'TOO_SHORT');
  assert.ok(evaluatePermission(ctx(), input('2026-09-08', '10:00', '10:05')).ok);
  assert.ok(evaluatePermission(ctx({ maxMinutes: 120 }), input('2026-09-08', '10:00', '12:00')).ok, 'exactly the maximum');
  const long = refusal(evaluatePermission(ctx({ maxMinutes: 120 }), input('2026-09-08', '10:00', '12:01')));
  assert.equal(long.code, 'TOO_LONG');
  assert.match(long.message, /at most 120 minutes/);
  assert.ok(evaluatePermission(ctx({ maxMinutes: null }), input('2026-09-08', '09:00', '16:00')).ok, 'no limit when none is set');
});

test('overlaps are refused, neighbours are fine', () => {
  const existing = [{ startMinutes: 600, endMinutes: 660 }];          // 10:00 to 11:00
  assert.equal(refusal(evaluatePermission(ctx({ existing }), input('2026-09-08', '10:30', '11:30'))).code, 'OVERLAP');
  assert.equal(refusal(evaluatePermission(ctx({ existing }), input('2026-09-08', '09:30', '10:30'))).code, 'OVERLAP');
  assert.equal(refusal(evaluatePermission(ctx({ existing }), input('2026-09-08', '10:15', '10:45'))).code, 'OVERLAP');
  assert.ok(evaluatePermission(ctx({ existing }), input('2026-09-08', '11:00', '12:00')).ok, 'starting when the other ends');
  assert.ok(evaluatePermission(ctx({ existing }), input('2026-09-08', '09:00', '10:00')).ok, 'ending when the other starts');
});

test('the monthly limit counts what the employee already has this month', () => {
  assert.ok(evaluatePermission(ctx({ maxPerMonth: 3, monthCount: 2 }), input('2026-09-08', '10:00', '11:00')).ok);
  const r = refusal(evaluatePermission(ctx({ maxPerMonth: 3, monthCount: 3 }), input('2026-09-08', '10:00', '11:00')));
  assert.equal(r.code, 'MONTH_LIMIT');
  assert.match(r.message, /already used 3 permissions this month/);
  assert.match(refusal(evaluatePermission(ctx({ maxPerMonth: 1, monthCount: 1 }), input('2026-09-08', '10:00', '11:00'))).message, /used 1 permission this month/);
  assert.ok(evaluatePermission(ctx({ maxPerMonth: null, monthCount: 99 }), input('2026-09-08', '10:00', '11:00')).ok, 'no limit when none is set');
});

test('the campus follows the employee on that date', () => {
  const temp: AssignmentRow = { campusId: 2, kind: 'TEMPORARY', mode: 'REPLACE', startDate: '2026-09-08', endDate: '2026-09-09' };
  const r = evaluatePermission(ctx({ assignments: [primary, temp] }), input('2026-09-08', '10:00', '11:00'));
  assert.ok(r.ok && r.plan.campusId === 2);
  assert.equal(refusal(evaluatePermission(ctx({ assignments: [] }), input('2026-09-08', '10:00', '11:00'))).code, 'NO_CAMPUS');
});

test('times read naturally', () => {
  assert.equal(clockText('00:30'), '12:30 AM');
  assert.equal(clockText('09:05'), '9:05 AM');
  assert.equal(clockText('12:00'), '12:00 PM');
  assert.equal(clockText('13:45:00'), '1:45 PM');
  assert.equal(timeRangeText('10:00', '11:30'), '10:00 AM to 11:30 AM');
});

test('the longest permission is set in 5-minute steps (or none), and the server enforces it', async () => {
  const { validateSettingValue, parseSettings } = await import('../attendance/settings');
  for (const ok of [null, 5, 10, 55, 60, 90, 480]) assert.equal(validateSettingValue('permission_max_minutes', ok), null, String(ok));
  for (const bad of [0, 4, 7, 12, 61, 485, 720, -5, 4.5, '15', undefined, NaN]) {
    assert.match(validateSettingValue('permission_max_minutes', bad) ?? '', /steps of 5/, String(bad));
  }
  assert.equal(parseSettings([{ key: 'permission_max_minutes', value: 90 }]).permissionMaxMinutes, 90);
  assert.equal(parseSettings([{ key: 'permission_max_minutes', value: 7 }]).permissionMaxMinutes, null, 'a stored value outside the steps falls back to no limit');
  assert.equal(parseSettings([]).permissionMaxMinutes, null);
});
