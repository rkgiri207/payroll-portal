import { pickShift, type ShiftRow } from '../attendance/shift';

/**
 * Pure working-day rules for leave. No database access here.
 *
 *  - Only CONFIRMED holidays count. DRAFT rows are ignored.
 *  - HOLIDAY, VACATION and WEEKLY_OFF close the day. VACATION does not close it for employees
 *    flagged "reports during vacations".
 *  - OPTIONAL is informational and never closes a day.
 *  - SPECIAL_WORKING_DAY forces a working day (even a Sunday or a holiday).
 *  - Otherwise the day must be one the campus shift covers (its weekdays, effective by that date).
 */

export type HolidayKind = 'HOLIDAY' | 'VACATION' | 'WEEKLY_OFF' | 'OPTIONAL' | 'SPECIAL_WORKING_DAY';

export interface HolidayRow {
  kind: HolidayKind;
  status: 'DRAFT' | 'CONFIRMED';
  startDate: string; // YYYY-MM-DD
  endDate: string;   // YYYY-MM-DD, inclusive
  campusId: number | null; // null = all campuses
}

export interface WorkdayContext {
  shifts: ShiftRow[];
  holidays: HolidayRow[];
  campusId: number | null;
  reportsDuringVacations: boolean;
}

export type DayReason =
  | 'WORKING' | 'SPECIAL_WORKING_DAY' | 'HOLIDAY' | 'VACATION' | 'WEEKLY_OFF' | 'NO_SHIFT';

export interface DayStatus { working: boolean; reason: DayReason }

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function toUtc(date: string): Date {
  if (!DATE_RE.test(date)) throw new Error(`Invalid date: ${date}`);
  const [y, m, d] = date.split('-').map(Number);
  const value = new Date(Date.UTC(y, m - 1, d));
  if (value.getUTCFullYear() !== y || value.getUTCMonth() !== m - 1 || value.getUTCDate() !== d) {
    throw new Error(`Invalid date: ${date}`);
  }
  return value;
}

export function addDays(date: string, days: number): string {
  const value = toUtc(date);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/** 0 = Sunday ... 6 = Saturday */
export function weekdayOf(date: string): number {
  return toUtc(date).getUTCDay();
}

/** The second Saturday of the month (day 8 to 14, a Saturday). */
export function isSecondSaturday(date: string): boolean {
  const day = Number(date.slice(8, 10));
  return weekdayOf(date) === 6 && day >= 8 && day <= 14;
}

export function datesBetween(start: string, end: string): string[] {
  if (end < start) throw new Error('End date is before start date');
  const out: string[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) out.push(d);
  return out;
}

export function dayStatus(date: string, ctx: WorkdayContext): DayStatus {
  const active = ctx.holidays.filter(
    h => h.status === 'CONFIRMED'
      && h.startDate <= date && date <= h.endDate
      && (h.campusId === null || h.campusId === ctx.campusId),
  );
  if (active.some(h => h.kind === 'SPECIAL_WORKING_DAY')) {
    return { working: true, reason: 'SPECIAL_WORKING_DAY' };
  }
  if (active.some(h => h.kind === 'HOLIDAY')) return { working: false, reason: 'HOLIDAY' };
  if (active.some(h => h.kind === 'WEEKLY_OFF')) return { working: false, reason: 'WEEKLY_OFF' };
  if (active.some(h => h.kind === 'VACATION') && !ctx.reportsDuringVacations) {
    return { working: false, reason: 'VACATION' };
  }
  if (!pickShift(ctx.shifts, date, weekdayOf(date))) return { working: false, reason: 'NO_SHIFT' };
  return { working: true, reason: 'WORKING' };
}

export interface LeaveDay { date: string; days: number }

/**
 * The days a leave request consumes: one entry per working day in the range.
 * A half-day is allowed on a single date only and counts 0.5.
 */
export function leaveDays(
  start: string, end: string, halfDay: boolean, ctx: WorkdayContext,
): LeaveDay[] {
  if (halfDay && start !== end) throw new Error('A half-day can only be on a single date');
  return datesBetween(start, end)
    .filter(date => dayStatus(date, ctx).working)
    .map(date => ({ date, days: halfDay ? 0.5 : 1 }));
}

/**
 * Working days per month for a calendar preview, using a plain Mon-Sat week like the printed
 * calendars. DRAFT holidays are treated as confirmed, so the admin can compare the figures with
 * the official calendar BEFORE confirming.
 */
export function monthlyWorkingDays(
  start: string, end: string, holidays: HolidayRow[], weekdays: number[] = [1, 2, 3, 4, 5, 6],
): { month: string; workingDays: number }[] {
  const shifts: ShiftRow[] = [{
    id: 0, loginTime: '00:00', logoutTime: '00:00', graceMinutes: 0, weekdays, effectiveFrom: start,
  }];
  const ctx: WorkdayContext = {
    shifts, campusId: null, reportsDuringVacations: false,
    holidays: holidays.map(h => ({ ...h, status: 'CONFIRMED' as const })),
  };
  const totals = new Map<string, number>();
  for (const date of datesBetween(start, end)) {
    const month = date.slice(0, 7);
    totals.set(month, (totals.get(month) ?? 0) + (dayStatus(date, ctx).working ? 1 : 0));
  }
  return [...totals].map(([month, workingDays]) => ({ month, workingDays }));
}

export function countWorkingDays(start: string, end: string, ctx: WorkdayContext): number {
  return datesBetween(start, end).filter(date => dayStatus(date, ctx).working).length;
}
