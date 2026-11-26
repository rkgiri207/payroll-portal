import { timeToMinutes } from './time';

export interface ShiftRow {
  id: number;
  loginTime: string;      // 'HH:MM[:SS]'
  logoutTime: string;
  graceMinutes: number;
  weekdays: number[];     // 0 = Sunday ... 6 = Saturday
  effectiveFrom: string;  // YYYY-MM-DD
}

/**
 * Pick the shift that applies on a date: among shifts that include the weekday and
 * have started (effective_from <= date), take the latest effective_from; ties go to
 * the highest id. Returns null when the campus has no shift for that day.
 * Past events keep their own snapshot, so changing shifts never rewrites history.
 */
export function pickShift(shifts: ShiftRow[], workDate: string, weekday: number): ShiftRow | null {
  const candidates = shifts.filter(
    shift => shift.effectiveFrom <= workDate && shift.weekdays.includes(weekday),
  );
  if (candidates.length === 0) return null;
  return candidates.reduce((best, current) => {
    if (current.effectiveFrom !== best.effectiveFrom) {
      return current.effectiveFrom > best.effectiveFrom ? current : best;
    }
    return current.id > best.id ? current : best;
  });
}

export type Punctuality = 'ON_TIME' | 'LATE' | 'NO_SHIFT';

export interface PunctualityResult {
  punctuality: Punctuality;
  lateMinutes: number | null;
}

/**
 * On time = up to and including login time + grace, compared in whole IST minutes.
 * With a 09:00 shift and 10 minutes grace, 09:10:59 is on time and 09:11:00 is late.
 */
export function evaluatePunctuality(shift: ShiftRow | null, minuteOfDay: number): PunctualityResult {
  if (!shift) return { punctuality: 'NO_SHIFT', lateMinutes: null };
  const permitted = timeToMinutes(shift.loginTime) + shift.graceMinutes;
  if (minuteOfDay <= permitted) return { punctuality: 'ON_TIME', lateMinutes: null };
  return { punctuality: 'LATE', lateMinutes: minuteOfDay - permitted };
}
