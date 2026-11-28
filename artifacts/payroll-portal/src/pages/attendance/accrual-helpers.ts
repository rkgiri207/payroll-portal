import type { AccrualSummary, OpeningRow, PlannedEntry } from './accrual-api';
import { formatDay, monthName } from './holiday-helpers';
import { fmtDays } from './policy-helpers';

/** "+1.25 for December 2026", or "+1 catch-up" for an adjustment. */
export function entryText(e: PlannedEntry): string {
  return e.entryType === 'CREDIT' ? `+${fmtDays(e.amount)} for ${monthName(e.period)}` : `+${fmtDays(e.amount)} catch-up`;
}

/** The one-line result of a preview or a run. */
export function summaryLine(s: AccrualSummary): string {
  if (!s.year) return 'Today is outside every academic year, so nothing is credited.';
  const credits = `${s.creditsPosted} credit${s.creditsPosted === 1 ? '' : 's'}`;
  const adjustments = s.adjustmentsPosted > 0 ? ` and ${s.adjustmentsPosted} catch-up${s.adjustmentsPosted === 1 ? '' : 's'}` : '';
  if (s.creditsPosted === 0 && s.adjustmentsPosted === 0) return `Nothing is due today (${s.employeesConsidered} employee${s.employeesConsidered === 1 ? '' : 's'} checked).`;
  return `${s.dryRun ? 'Would credit' : 'Credited'} ${credits}${adjustments}, ${fmtDays(s.daysPosted)} days in total, to ${s.employeesConsidered} employee${s.employeesConsidered === 1 ? '' : 's'}.`;
}

/** Why leave is credited from a given date, for the explanation above the buttons. */
export function accrualFromText(year: { startDate: string; accrualFrom: string | null }): string {
  return year.accrualFrom
    ? `Leave is credited on the 1st of each month from ${monthName(year.accrualFrom.slice(0, 7))}. Months before that are never credited by the system.`
    : `Leave is credited on the 1st of each month from ${monthName(year.startDate.slice(0, 7))}, the first month of the academic year.`;
}

/** Opening balances typed in the grid, as the entries to save: only the rows that changed and can be saved. */
export function changedEntries(rows: OpeningRow[], drafts: Record<number, string>): { employeeId: number; days: string }[] {
  const out: { employeeId: number; days: string }[] = [];
  for (const row of rows) {
    const draft = drafts[row.employeeId];
    if (draft === undefined || draft.trim() === '' || !row.joiningDate) continue;
    if (row.opening !== null && Number(draft) === row.opening) continue;     // unchanged
    if (row.opening === null && Number(draft) === 0) continue;               // zero with nothing entered is nothing
    out.push({ employeeId: row.employeeId, days: draft.trim() });
  }
  return out;
}

/** A typed number is acceptable: not negative, at most 2 decimals. Empty is fine (nothing entered). */
export function isValidDaysText(text: string): boolean {
  if (text.trim() === '') return true;
  return /^\d{1,3}(\.\d{1,2})?$/.test(text.trim()) && Number(text) <= 366;
}

export const joiningText = (r: Pick<OpeningRow, 'joiningDate'>): string => (r.joiningDate ? formatDay(r.joiningDate) : 'Missing');
