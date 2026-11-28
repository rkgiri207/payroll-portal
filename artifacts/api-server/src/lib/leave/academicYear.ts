import type { Queryable } from '../attendance/db';

export interface AcademicYearLookup {
  /** The academic year that contains the date, or null when the date is outside every year. */
  yearId: number | null;
  label: string | null;
  /** Whether any academic year has been set up at all. */
  anyYearConfigured: boolean;
}

/**
 * Which academic year a date belongs to. The years are the organisation's own (their first and
 * last day are typed in by the admin), so nothing here is a fixed date.
 */
export async function findAcademicYearForDate(q: Queryable, date: string): Promise<AcademicYearLookup> {
  const { rows } = await q.query<{ year_id: number | null; label: string | null; any_year: boolean }>(
    `select (select id from academic_years where $1::date between start_date and end_date) as year_id,
            (select label from academic_years where $1::date between start_date and end_date) as label,
            exists (select 1 from academic_years) as any_year`,
    [date],
  );
  const row = rows[0];
  return { yearId: row?.year_id ?? null, label: row?.label ?? null, anyYearConfigured: row?.any_year ?? false };
}

/**
 * Attendance outside every academic year, once at least one year exists. Until the first year
 * is set up the rule is not applied, so a new installation is never locked out by an empty setup.
 */
export const isOutsideAcademicYear = (lookup: AcademicYearLookup): boolean =>
  lookup.anyYearConfigured && lookup.yearId === null;
