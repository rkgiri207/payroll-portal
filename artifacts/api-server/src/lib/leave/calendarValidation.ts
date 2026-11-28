import { isValidDate, type Result } from '../attendance/adminValidation';
import type { HolidayKind } from './calendar';

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const fail = <T = never>(error: string): Result<T> => ({ ok: false, error });
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export const HOLIDAY_KINDS: HolidayKind[] = ['HOLIDAY', 'VACATION', 'WEEKLY_OFF', 'OPTIONAL', 'SPECIAL_WORKING_DAY'];

function requiredText(value: unknown, label: string, max: number): Result<string> {
  if (typeof value !== 'string' || value.trim() === '') return fail(`${label} is required`);
  const trimmed = value.trim();
  return trimmed.length > max ? fail(`${label} must be at most ${max} characters`) : ok(trimmed);
}

export interface AcademicYearInput {
  label: string; startDate: string; endDate: string;
  /** The first month leave is credited by the system. Empty means the year's first day. */
  accrualFrom?: string | null;
}

export function validateAcademicYear(body: unknown): Result<AcademicYearInput> {
  if (!isRecord(body)) return fail('Send the academic year details');
  const label = requiredText(body.label, 'Year name', 20);
  if (!label.ok) return label;
  if (!isValidDate(body.startDate)) return fail('Start date must be a valid date');
  if (!isValidDate(body.endDate)) return fail('End date must be a valid date');
  if (body.endDate <= body.startDate) return fail('The end date must be after the start date');
  let accrualFrom: string | null = null;
  if (body.accrualFrom !== undefined && body.accrualFrom !== null && body.accrualFrom !== '') {
    if (!isValidDate(body.accrualFrom)) return fail('The accrue-from date must be a valid date');
    if (body.accrualFrom < body.startDate || body.accrualFrom > body.endDate) return fail('The accrue-from month must be inside the academic year');
    accrualFrom = body.accrualFrom;
  }
  return ok({ label: label.value, startDate: body.startDate, endDate: body.endDate, accrualFrom });
}

export interface HolidayInput {
  name: string; kind: HolidayKind; startDate: string; endDate: string; campusId: number | null;
}

export function validateHoliday(body: unknown): Result<HolidayInput> {
  if (!isRecord(body)) return fail('Send the holiday details');
  const name = requiredText(body.name, 'Name', 100);
  if (!name.ok) return name;
  if (typeof body.kind !== 'string' || !HOLIDAY_KINDS.includes(body.kind as HolidayKind)) {
    return fail('Type must be one of: Holiday, Vacation, Weekly off, Optional, Special working day');
  }
  if (!isValidDate(body.startDate)) return fail('Start date must be a valid date');
  const endDate = body.endDate === undefined || body.endDate === null || body.endDate === '' ? body.startDate : body.endDate;
  if (!isValidDate(endDate)) return fail('End date must be a valid date');
  if (endDate < body.startDate) return fail('The end date cannot be before the start date');
  let campusId: number | null = null;
  if (body.campusId !== undefined && body.campusId !== null && body.campusId !== '') {
    const id = Number(body.campusId);
    if (!Number.isInteger(id) || id <= 0) return fail('Campus is not valid');
    campusId = id;
  }
  return ok({ name: name.value, kind: body.kind as HolidayKind, startDate: body.startDate, endDate, campusId });
}

/** Optional first and last day sent with an import; empty means "use the official dates". */
export function validateImportDates(body: unknown): Result<{ startDate: string; endDate: string } | null> {
  if (!isRecord(body)) return ok(null);
  const { startDate, endDate } = body;
  const blank = (v: unknown) => v === undefined || v === null || v === '';
  if (blank(startDate) && blank(endDate)) return ok(null);
  if (!isValidDate(startDate)) return fail('First day must be a valid date');
  if (!isValidDate(endDate)) return fail('Last day must be a valid date');
  if (endDate <= startDate) return fail('The last day must be after the first day');
  return ok({ startDate, endDate });
}
