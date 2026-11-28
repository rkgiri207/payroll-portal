import { resolveAllowedCampuses } from '../attendance/campusData';
import type { ShiftRow } from '../attendance/shift';
import { splitPaidLop, type InsufficientBalance } from './balance';
import { addDays, dayStatus, datesBetween, type HolidayRow } from './calendar';

/**
 * Everything that decides whether a leave request is acceptable and what it will cost. Pure: the
 * data is loaded elsewhere, so every rule here is easy to test. Nothing here writes anything.
 *
 * All rules follow the organisation's own academic year. A request must sit inside one year.
 */

export type DayMode = 'FULL' | 'FIRST_HALF' | 'SECOND_HALF';

export type LeaveErrorCode =
  | 'INVALID_INPUT' | 'TYPE_UNAVAILABLE' | 'NO_ACADEMIC_YEAR' | 'SPANS_YEARS' | 'PAST_DATE' | 'HALF_DAY_NOT_ALLOWED'
  | 'NOTICE' | 'NO_CAMPUS' | 'NO_WORKING_DAYS' | 'TOO_LONG' | 'OVERLAP' | 'INSUFFICIENT_BALANCE';

export interface AssignmentRow {
  campusId: number; kind: 'PRIMARY' | 'TEMPORARY'; mode: 'REPLACE' | 'ADDITIONAL';
  startDate: string; endDate: string | null;
}

export interface LeavePolicyRules {
  allowHalfDay: boolean; minNoticeDays: number; maxConsecutiveDays: number | null; insufficientBalance: InsufficientBalance;
}

/** Used until an admin saves a policy: nothing blocks, and a shortfall becomes loss of pay. */
export const DEFAULT_RULES: LeavePolicyRules = { allowHalfDay: true, minNoticeDays: 0, maxConsecutiveDays: null, insufficientBalance: 'LOP' };

export interface EvalContext {
  type: { name: string; tracksBalance: boolean; isActive: boolean };
  /** The academic year containing the first day, or null if there is none. */
  year: { label: string; startDate: string; endDate: string } | null;
  rules: LeavePolicyRules;
  assignments: AssignmentRow[];
  shiftsByCampus: Record<number, ShiftRow[]>;
  holidays: HolidayRow[];
  reportsDuringVacations: boolean;
  /** Balance minus the paid days already promised to other pending requests. May be negative. */
  availableBalance: number;
  /** Dates this employee already has an active (pending or approved) leave on, within the range. */
  existingLeaveDates: string[];
}

export interface EvalInput {
  startDate: string; endDate: string; dayMode: DayMode;
  /** IST date today. */
  today: string;
  /** An admin entering leave on someone's behalf may use past dates and skips the notice rule. */
  byAdmin: boolean;
}

export interface LeavePlanDay { date: string; campusId: number; fraction: 0.5 | 1 }
export interface LeavePlan { days: LeavePlanDay[]; totalDays: number; paidDays: number; lopDays: number; campusId: number }

export type EvalResult =
  | { ok: true; plan: LeavePlan }
  | { ok: false; code: LeaveErrorCode; message: string; dates?: string[]; availableDays?: number };

const fail = (code: LeaveErrorCode, message: string, extra: { dates?: string[]; availableDays?: number } = {}): EvalResult =>
  ({ ok: false, code, message, ...extra });

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (d: string) => DATE_RE.test(d) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;
const daysBetweenDates = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "04 Sep 2026". A fixed list, so the wording never depends on the Node version's locale data. */
export const niceDay = (d: string) => `${d.slice(8, 10)} ${MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`;

/** The campus a leave counts against on a date: a temporary REPLACE campus if there is one, else the primary. */
export function mainCampusOn(date: string, assignments: AssignmentRow[]): number | null {
  const active = assignments
    .filter(a => a.startDate <= date && (a.endDate === null || a.endDate >= date))
    .map(a => ({ campusId: a.campusId, campusCode: '', campusName: '', kind: a.kind, mode: a.mode }));
  return resolveAllowedCampuses(active)[0]?.campusId ?? null;
}

export function evaluateLeave(ctx: EvalContext, input: EvalInput): EvalResult {
  const { startDate, endDate, dayMode, today, byAdmin } = input;
  if (!validDate(startDate) || !validDate(endDate) || endDate < startDate) {
    return fail('INVALID_INPUT', 'Please choose a valid start and end date, with the end date on or after the start date.');
  }
  if (!ctx.type.isActive) return fail('TYPE_UNAVAILABLE', `${ctx.type.name} is not available right now. Please choose another leave type.`);

  if (!ctx.year) {
    return fail('NO_ACADEMIC_YEAR', `There is no academic year set up for ${niceDay(startDate)}. Please contact the school administration.`);
  }
  if (endDate > ctx.year.endDate) {
    return fail('SPANS_YEARS', `These dates run past the end of the academic year ${ctx.year.label} (${niceDay(ctx.year.endDate)}). Please submit one request for each academic year.`);
  }

  if (!byAdmin && startDate < today) return fail('PAST_DATE', 'Leave can only be requested for today or a future date. For an earlier date, please contact the school administration.');

  if (dayMode !== 'FULL') {
    if (startDate !== endDate) return fail('INVALID_INPUT', 'A half-day can only be on a single date.');
    if (!ctx.rules.allowHalfDay) return fail('HALF_DAY_NOT_ALLOWED', `Half-days are not allowed for ${ctx.type.name}.`);
  }

  if (!byAdmin && daysBetweenDates(today, startDate) < ctx.rules.minNoticeDays) {
    return fail('NOTICE', `${ctx.type.name} needs at least ${plural(ctx.rules.minNoticeDays, 'day')} notice. The earliest date you can choose is ${niceDay(addDays(today, ctx.rules.minNoticeDays))}.`);
  }

  // The working days this leave would take, each counted against that day's campus.
  const days: LeavePlanDay[] = [];
  const noCampus: string[] = [];
  for (const date of datesBetween(startDate, endDate)) {
    const campusId = mainCampusOn(date, ctx.assignments);
    if (campusId === null) { noCampus.push(date); continue; }
    const status = dayStatus(date, {
      shifts: ctx.shiftsByCampus[campusId] ?? [], holidays: ctx.holidays, campusId, reportsDuringVacations: ctx.reportsDuringVacations,
    });
    if (status.working) days.push({ date, campusId, fraction: dayMode === 'FULL' ? 1 : 0.5 });
  }
  if (noCampus.length > 0) {
    return fail('NO_CAMPUS', 'You are not assigned to a campus for some of these dates. Please contact the school administration.', { dates: noCampus });
  }
  if (days.length === 0) {
    return fail('NO_WORKING_DAYS', 'Those dates are holidays or weekly offs, so no leave is needed.');
  }

  const totalDays = days.reduce((sum, d) => sum + d.fraction, 0);
  if (ctx.rules.maxConsecutiveDays !== null && totalDays > ctx.rules.maxConsecutiveDays) {
    return fail('TOO_LONG', `${ctx.type.name} can be taken for at most ${plural(ctx.rules.maxConsecutiveDays, 'day')} at a time. Please split the request.`);
  }

  const taken = new Set(ctx.existingLeaveDates);
  const overlap = days.map(d => d.date).filter(d => taken.has(d));
  if (overlap.length > 0) {
    return fail('OVERLAP', `You already have leave on ${overlap.map(niceDay).join(', ')}.`, { dates: overlap });
  }

  const split = splitPaidLop({
    requestedDays: totalDays, balance: ctx.availableBalance, tracksBalance: ctx.type.tracksBalance,
    insufficientBalance: ctx.rules.insufficientBalance,
  });
  if (!split.ok) {
    return fail('INSUFFICIENT_BALANCE',
      `You asked for ${plural(totalDays, 'day')} of ${ctx.type.name} but only ${split.availableDays} ${split.availableDays === 1 ? 'day is' : 'days are'} available.`,
      { availableDays: split.availableDays });
  }

  return { ok: true, plan: { days, totalDays, paidDays: split.paidDays, lopDays: split.lopDays, campusId: days[0].campusId } };
}

/** The reason text: required, trimmed, at most 500 characters. */
export function cleanReason(value: unknown): { ok: true; value: string } | { ok: false; message: string } {
  if (typeof value !== 'string' || value.trim() === '') return { ok: false, message: 'Please give a reason for the leave.' };
  const text = value.trim().replace(/\s+/g, ' ');
  return text.length > 500 ? { ok: false, message: 'The reason must be at most 500 characters.' } : { ok: true, value: text };
}
