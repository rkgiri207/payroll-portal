import type { HolidayKind, MonthRow } from './leave-api';

export const KIND_LABELS: Record<HolidayKind, string> = {
  HOLIDAY: 'Holiday',
  VACATION: 'Vacation',
  WEEKLY_OFF: 'Weekly off',
  OPTIONAL: 'Optional',
  SPECIAL_WORKING_DAY: 'Special working day',
};

export const KIND_HELP: Record<HolidayKind, string> = {
  HOLIDAY: 'Closed for all staff.',
  VACATION: 'School vacation. Staff marked "reports during vacations" still work.',
  WEEKLY_OFF: 'An extra weekly off such as a second Saturday. Closed for all staff.',
  OPTIONAL: 'For information only. Never closes a day.',
  SPECIAL_WORKING_DAY: 'A normally-off day (such as a Sunday) that is worked.',
};

// A fixed list of short month names, the same as the WhatsApp messages use. The browser's own
// formatting varies (British English writes "Sept"), which would make a screen disagree with a message.
const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAY = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short' });
const MONTH = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', month: 'long', year: 'numeric' });

// Dates are plain YYYY-MM-DD text; parsing them as UTC keeps every time zone on the same day.
const utc = (date: string) => new Date(`${date}T00:00:00Z`);

export const formatDay = (date: string) => `${date.slice(8, 10)} ${SHORT_MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
export const weekdayName = (date: string) => WEEKDAY.format(utc(date));
export const monthName = (month: string) => MONTH.format(utc(`${month}-01`));

/** "02 Oct 2026" for one day, "12 Oct 2026 to 21 Oct 2026" for a range. */
export function formatRange(start: string, end: string): string {
  return start === end ? formatDay(start) : `${formatDay(start)} to ${formatDay(end)}`;
}

/** Weekday for a single day; for a range, both end weekdays ("Mon to Wed"). */
export function weekdayRange(start: string, end: string): string {
  return start === end ? weekdayName(start) : `${weekdayName(start)} to ${weekdayName(end)}`;
}

/** What the confirm step should warn about, in plain words. Empty when everything checks out. */
export function mismatchSummary(months: MonthRow[]): string[] {
  return months
    .filter(m => m.matches === false)
    .map(m => `${monthName(m.month)}: ${m.workingDays} working days here, ${m.printed} on the official calendar`);
}

export const totalWorkingDays = (months: MonthRow[]) => months.reduce((sum, m) => sum + m.workingDays, 0);
