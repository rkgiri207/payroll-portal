/**
 * Server-side time helpers. Attendance always uses the SERVER clock in Asia/Kolkata (IST).
 * The client's clock is never trusted.
 */

export const ATTENDANCE_TIME_ZONE = 'Asia/Kolkata';

export interface IstParts {
  /** IST calendar date, YYYY-MM-DD */
  workDate: string;
  /** 0 = Sunday ... 6 = Saturday (IST) */
  weekday: number;
  /** Whole minutes since IST midnight; seconds are dropped (so 09:10:59 is minute 550) */
  minuteOfDay: number;
}

const formatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: ATTENDANCE_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function istParts(at: Date): IstParts {
  const parts: Record<string, string> = {};
  for (const part of formatter.formatToParts(at)) parts[part.type] = part.value;
  const weekday = WEEKDAYS[parts.weekday];
  if (weekday === undefined) throw new Error('Could not determine the IST weekday');
  return {
    workDate: `${parts.year}-${parts.month}-${parts.day}`,
    weekday,
    minuteOfDay: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

/** YYYY-MM-DD plus N calendar days (N may be negative). */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** 'HH:MM' or 'HH:MM:SS' (Postgres time) to whole minutes since midnight. */
export function timeToMinutes(value: string): number {
  const match = /^(\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(value.trim());
  if (!match) throw new Error(`Invalid time value: ${value}`);
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) throw new Error(`Invalid time value: ${value}`);
  return hours * 60 + minutes;
}
