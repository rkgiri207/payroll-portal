import { pickShift, type ShiftRow } from '../attendance/shift';
import { timeToMinutes } from '../attendance/time';
import { dayStatus, weekdayOf, type HolidayRow } from './calendar';
import { mainCampusOn, niceDay, type AssignmentRow } from './leaveEvaluate';

/**
 * Permission: a short absence within one working day (for example 10:00 to 11:00). It uses no leave
 * balance. Pure rules, no database access; the data is loaded elsewhere.
 *
 * A permission must fall inside the organisation's academic year, on one of the employee's working
 * days, within their shift hours, and not on a day they are on leave.
 */

export type PermissionErrorCode =
  | 'INVALID_INPUT' | 'NO_ACADEMIC_YEAR' | 'PAST_DATE' | 'TIME_PASSED' | 'NO_CAMPUS' | 'NOT_WORKING_DAY'
  | 'ON_LEAVE' | 'OUTSIDE_SHIFT' | 'TOO_LONG' | 'TOO_SHORT' | 'MONTH_LIMIT' | 'OVERLAP';

export interface PermissionContext {
  /** Whether the date falls inside an academic year. */
  inAcademicYear: boolean;
  assignments: AssignmentRow[];
  shiftsByCampus: Record<number, ShiftRow[]>;
  holidays: HolidayRow[];
  reportsDuringVacations: boolean;
  /** The employee has an active (pending or approved) leave on the date. */
  onLeave: boolean;
  /** Active permissions the employee already has on the date, as minutes since midnight. */
  existing: { startMinutes: number; endMinutes: number }[];
  /** Active permissions the employee already has in the same calendar month. */
  monthCount: number;
  maxMinutes: number | null;
  maxPerMonth: number | null;
}

export interface PermissionInput {
  date: string; startTime: string; endTime: string;
  today: string; /** Minutes since midnight now in IST. */ nowMinutes: number;
  /** An admin may enter a permission for a time that has passed. */
  byAdmin: boolean;
}

export interface PermissionPlan { campusId: number; startTime: string; endTime: string; minutes: number }

export type PermissionResult =
  | { ok: true; plan: PermissionPlan }
  | { ok: false; code: PermissionErrorCode; message: string };

const fail = (code: PermissionErrorCode, message: string): PermissionResult => ({ ok: false, code, message });
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const validDate = (d: string) => DATE_RE.test(d) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;
const hhmm = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
const clock = (t: string) => {
  const m = timeToMinutes(t);
  const h12 = m / 60 >= 13 ? Math.floor(m / 60) - 12 : Math.floor(m / 60) === 0 ? 12 : Math.floor(m / 60);
  return `${h12}:${String(m % 60).padStart(2, '0')} ${m >= 720 ? 'PM' : 'AM'}`;
};
const mins = (n: number) => `${n} minute${n === 1 ? '' : 's'}`;

export const MIN_PERMISSION_MINUTES = 5;

export function evaluatePermission(ctx: PermissionContext, input: PermissionInput): PermissionResult {
  const { date, startTime, endTime } = input;
  if (!validDate(date)) return fail('INVALID_INPUT', 'Please choose a valid date.');
  if (!TIME_RE.test(startTime) || !TIME_RE.test(endTime)) return fail('INVALID_INPUT', 'Please choose a start time and an end time.');
  const start = timeToMinutes(startTime);
  const end = timeToMinutes(endTime);
  if (end <= start) return fail('INVALID_INPUT', 'The end time must be after the start time.');

  if (!ctx.inAcademicYear) return fail('NO_ACADEMIC_YEAR', `There is no academic year set up for ${niceDay(date)}. Please contact the school administration.`);
  if (!input.byAdmin) {
    if (date < input.today) return fail('PAST_DATE', 'Permission can only be requested for today or a future date.');
    if (date === input.today && end <= input.nowMinutes) return fail('TIME_PASSED', 'That time has already passed. Please choose a later time.');
  }

  const campusId = mainCampusOn(date, ctx.assignments);
  if (campusId === null) return fail('NO_CAMPUS', 'You are not assigned to a campus on this date. Please contact the school administration.');
  const status = dayStatus(date, {
    shifts: ctx.shiftsByCampus[campusId] ?? [], holidays: ctx.holidays, campusId, reportsDuringVacations: ctx.reportsDuringVacations,
  });
  if (!status.working) return fail('NOT_WORKING_DAY', `${niceDay(date)} is not a working day for you, so no permission is needed.`);
  if (ctx.onLeave) return fail('ON_LEAVE', `You already have leave on ${niceDay(date)}, so no permission is needed.`);

  const shift = pickShift(ctx.shiftsByCampus[campusId] ?? [], date, weekdayOf(date));
  if (shift) {
    const open = timeToMinutes(shift.loginTime);
    const close = timeToMinutes(shift.logoutTime);
    if (start < open || end > close) {
      return fail('OUTSIDE_SHIFT', `Permission must be within your working hours on ${niceDay(date)}, ${clock(shift.loginTime)} to ${clock(shift.logoutTime)}.`);
    }
  }

  const minutes = end - start;
  if (minutes < MIN_PERMISSION_MINUTES) return fail('TOO_SHORT', `A permission must be at least ${mins(MIN_PERMISSION_MINUTES)}.`);
  if (ctx.maxMinutes !== null && minutes > ctx.maxMinutes) {
    return fail('TOO_LONG', `A single permission can be at most ${mins(ctx.maxMinutes)}. For a longer absence, please apply for a half-day leave.`);
  }
  if (ctx.existing.some(e => start < e.endMinutes && end > e.startMinutes)) {
    return fail('OVERLAP', `You already have a permission on ${niceDay(date)} that overlaps these times.`);
  }
  if (ctx.maxPerMonth !== null && ctx.monthCount >= ctx.maxPerMonth) {
    return fail('MONTH_LIMIT', `You have already used ${ctx.maxPerMonth} permission${ctx.maxPerMonth === 1 ? '' : 's'} this month, which is the most allowed.`);
  }
  return { ok: true, plan: { campusId, startTime: hhmm(start), endTime: hhmm(end), minutes } };
}

/** "10:00 AM to 11:00 AM", for messages and screens. */
export const timeRangeText = (startTime: string, endTime: string): string => `${clock(startTime)} to ${clock(endTime)}`;
export { clock as clockText };
