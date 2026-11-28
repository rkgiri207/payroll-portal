import { round2 } from './balance';

/**
 * Leave accrual: what to credit to one employee, for one leave type, in the academic year that is
 * running today. Pure, no database access: the data is loaded elsewhere.
 *
 * The rules
 *  - Monthly: a fixed number of days is credited on the 1st of each month.
 *  - The month an employee joins earns nothing. Credits start on the 1st of the NEXT month.
 *  - No month before the academic year's "accrue from" month is ever credited by the system. That is
 *    how the app goes live part-way through a year: opening balances cover the earlier months.
 *  - An employee without a joining date earns nothing until one is entered.
 *  - Only months up to the current one are credited, and never past the end of the academic year.
 *  - It repairs itself. If the monthly number is raised, the extra for the months already credited is
 *    added as one logged adjustment (catch-up). If it is lowered, nothing is taken back; new months
 *    simply use the lower number.
 *  - "All at the start of the year": the yearly days are credited once, in the first month the
 *    employee is eligible; a later change is added or ignored the same way (never taken back).
 *  - "Only when I add it": nothing is credited here.
 */

export type CreditMode = 'UPFRONT' | 'MONTHLY' | 'MANUAL';

/** Every entry this module posts as an adjustment starts with this, so its own credits can be told apart. */
export const ACCRUAL_PREFIX = 'Accrual:';

export interface AccrualYear { startDate: string; endDate: string; accrualFrom: string | null }

export interface AccrualInput {
  /** IST date today. */
  today: string;
  year: AccrualYear;
  joiningDate: string | null;
  mode: CreditMode;
  monthlyDays: number;
  yearlyDays: number;
  /** Months ('YYYY-MM') that already have a monthly credit in the ledger for this employee, type and year. */
  creditedMonths: string[];
  /** Total of this module's credits and adjustments already in the ledger for this employee, type and year. */
  postedTotal: number;
}

export interface PlannedEntry {
  entryType: 'CREDIT' | 'ADJUSTMENT';
  amount: number;
  effectiveDate: string;
  /** The month the entry belongs to ('YYYY-MM'). */
  period: string;
  reason: string;
}

export type AccrualSkip = 'NO_JOINING_DATE' | 'MANUAL' | 'NOT_STARTED' | 'NOTHING_DUE';

export interface AccrualPlan {
  entries: PlannedEntry[];
  /** The months this employee is eligible for so far, oldest first. */
  eligibleMonths: string[];
  /** Why nothing is planned, when nothing is. */
  skipped: AccrualSkip | null;
}

const MONTH_RE = /^\d{4}-\d{2}$/;
export const monthOf = (date: string): string => date.slice(0, 7);
export const firstOfMonth = (month: string): string => `${month}-01`;

export function nextMonth(month: string): string {
  if (!MONTH_RE.test(month)) throw new Error(`Invalid month: ${month}`);
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

export function monthsBetween(first: string, last: string): string[] {
  const out: string[] = [];
  for (let m = first; m <= last; m = nextMonth(m)) out.push(m);
  return out;
}

/** The months this employee earns accrual in, up to and including the current month. */
export function eligibleMonths(a: Pick<AccrualInput, 'today' | 'year' | 'joiningDate'>): string[] {
  if (!a.joiningDate) return [];
  if (a.today < a.year.startDate || a.today > a.year.endDate) return [];
  const yearStart = monthOf(a.year.startDate);
  const accrualStart = a.year.accrualFrom ? monthOf(a.year.accrualFrom) : yearStart;
  const afterJoining = nextMonth(monthOf(a.joiningDate));         // the joining month itself earns nothing
  const first = [yearStart, accrualStart, afterJoining].reduce((x, y) => (x > y ? x : y));
  const last = [monthOf(a.today), monthOf(a.year.endDate)].reduce((x, y) => (x < y ? x : y));
  return first > last ? [] : monthsBetween(first, last);
}

/** Credits are dated the 1st of their month, or the first day of the academic year if that is later. */
const creditDate = (month: string, yearStart: string): string => {
  const first = firstOfMonth(month);
  return first < yearStart ? yearStart : first;
};

export function planAccrual(a: AccrualInput): AccrualPlan {
  if (a.mode === 'MANUAL') return { entries: [], eligibleMonths: [], skipped: 'MANUAL' };
  if (!a.joiningDate) return { entries: [], eligibleMonths: [], skipped: 'NO_JOINING_DATE' };
  const months = eligibleMonths(a);
  if (months.length === 0) return { entries: [], eligibleMonths: [], skipped: 'NOT_STARTED' };

  const entries: PlannedEntry[] = [];
  const credited = new Set(a.creditedMonths);
  let posted = a.postedTotal;
  const rate = round2(a.monthlyDays);
  const yearly = round2(a.yearlyDays);

  if (a.mode === 'MONTHLY') {
    if (rate > 0) {
      for (const month of months) {
        if (credited.has(month)) continue;
        entries.push({ entryType: 'CREDIT', amount: rate, effectiveDate: creditDate(month, a.year.startDate), period: month, reason: `${ACCRUAL_PREFIX} monthly credit` });
        posted = round2(posted + rate);
      }
    }
    const target = round2(rate * months.length);
    const shortfall = round2(target - posted);
    if (shortfall > 0) {
      entries.push({
        entryType: 'ADJUSTMENT', amount: shortfall, effectiveDate: a.today, period: monthOf(a.today),
        reason: `${ACCRUAL_PREFIX} catch-up after the monthly days changed (credited ${round2(posted)}, should be ${target})`,
      });
    }
  } else {
    // UPFRONT: the yearly days once, in the first eligible month; a later increase is added as a logged adjustment.
    const first = months[0];
    if (yearly > 0 && !credited.has(first)) {
      entries.push({ entryType: 'CREDIT', amount: yearly, effectiveDate: creditDate(first, a.year.startDate), period: first, reason: `${ACCRUAL_PREFIX} yearly days credited at the start` });
      posted = round2(posted + yearly);
    }
    const shortfall = round2(yearly - posted);
    if (shortfall > 0) {
      entries.push({
        entryType: 'ADJUSTMENT', amount: shortfall, effectiveDate: a.today, period: monthOf(a.today),
        reason: `${ACCRUAL_PREFIX} yearly days changed (credited ${round2(posted)}, should be ${yearly})`,
      });
    }
  }
  return { entries, eligibleMonths: months, skipped: entries.length === 0 ? 'NOTHING_DUE' : null };
}
