import { pgCode, PG_UNIQUE_VIOLATION } from '../attendance/adminAccess';
import type { Queryable } from '../attendance/db';
import { monthlyWorkingDays, type HolidayKind, type HolidayRow } from './calendar';
import type { AcademicYearInput, HolidayInput } from './calendarValidation';
import type { CalendarTemplate, TemplateHoliday } from './calendarTemplates';

export interface AcademicYearView {
  id: number; label: string; startDate: string; endDate: string; draftCount: number; confirmedCount: number;
  /** The first day of the month the system starts crediting leave from; null means the year's first day. */
  accrualFrom: string | null;
}
export interface HolidayView {
  id: number; academicYearId: number; campusId: number | null; name: string; kind: HolidayKind;
  startDate: string; endDate: string; status: 'DRAFT' | 'CONFIRMED'; source: string | null;
}

type Outcome<T> = { ok: true; value: T } | { ok: false; error: string; status: number };

const PG_EXCLUSION_VIOLATION = '23P01';
const PG_RAISE = 'P0001';

// Dates are read as plain text so no time zone can shift them.
const HOLIDAY_COLUMNS = `h.id, h.academic_year_id, h.campus_id, h.name, h.kind,
  to_char(h.start_date, 'YYYY-MM-DD') as start_date, to_char(h.end_date, 'YYYY-MM-DD') as end_date,
  h.status, h.source`;

interface HolidayDbRow {
  id: number; academic_year_id: number; campus_id: number | null; name: string; kind: HolidayKind;
  start_date: string; end_date: string; status: 'DRAFT' | 'CONFIRMED'; source: string | null;
}
const toHoliday = (r: HolidayDbRow): HolidayView => ({
  id: r.id, academicYearId: r.academic_year_id, campusId: r.campus_id, name: r.name, kind: r.kind,
  startDate: r.start_date, endDate: r.end_date, status: r.status, source: r.source,
});

function friendly(error: unknown, what: 'year' | 'holiday'): Outcome<never> {
  const code = pgCode(error);
  if (code === PG_EXCLUSION_VIOLATION) return { ok: false, status: 409, error: 'These dates overlap another academic year' };
  if (code === PG_UNIQUE_VIOLATION) {
    return { ok: false, status: 409, error: what === 'year' ? 'An academic year with this name already exists' : 'This holiday is already in the calendar' };
  }
  if (code === 'LY003' && error instanceof Error) {
    return { ok: false, status: 409, error: error.message.charAt(0).toUpperCase() + error.message.slice(1) };
  }
  if (code === PG_RAISE && error instanceof Error && error.message.includes('is outside academic year')) {
    return { ok: false, status: 400, error: 'The dates must fall inside the academic year' };
  }
  throw error;
}

export async function listAcademicYears(q: Queryable): Promise<AcademicYearView[]> {
  const { rows } = await q.query<{ id: number; label: string; start_date: string; end_date: string; accrual_from: string | null; draft_count: number; confirmed_count: number }>(
    `select y.id, y.label, to_char(y.start_date, 'YYYY-MM-DD') as start_date, to_char(y.end_date, 'YYYY-MM-DD') as end_date,
            to_char(y.accrual_from, 'YYYY-MM-DD') as accrual_from,
            count(*) filter (where h.status = 'DRAFT')::int as draft_count,
            count(*) filter (where h.status = 'CONFIRMED')::int as confirmed_count
       from academic_years y left join holidays h on h.academic_year_id = y.id
      group by y.id order by y.start_date desc`,
  );
  return rows.map(r => ({
    id: r.id, label: r.label, startDate: r.start_date, endDate: r.end_date, accrualFrom: r.accrual_from,
    draftCount: r.draft_count, confirmedCount: r.confirmed_count,
  }));
}

export async function getAcademicYear(q: Queryable, id: number): Promise<AcademicYearView | null> {
  return (await listAcademicYears(q)).find(y => y.id === id) ?? null;
}

export async function createAcademicYear(q: Queryable, input: AcademicYearInput, userId: number | null): Promise<Outcome<AcademicYearView>> {
  try {
    const { rows } = await q.query<{ id: number }>(
      'insert into academic_years (label, start_date, end_date, accrual_from, created_by) values ($1, $2::date, $3::date, $5::date, $4) returning id',
      [input.label, input.startDate, input.endDate, userId, input.accrualFrom ?? null],
    );
    return { ok: true, value: { id: rows[0].id, ...input, accrualFrom: input.accrualFrom ?? null, draftCount: 0, confirmedCount: 0 } };
  } catch (error) {
    return friendly(error, 'year');
  }
}

export async function updateAcademicYear(
  q: Queryable, id: number, input: AcademicYearInput,
): Promise<Outcome<{ before: AcademicYearView; after: AcademicYearView }>> {
  const before = await getAcademicYear(q, id);
  if (!before) return { ok: false, status: 404, error: 'Academic year not found' };
  try {
    await q.query(
      'update academic_years set label = $2, start_date = $3::date, end_date = $4::date, accrual_from = $5::date where id = $1',
      [id, input.label, input.startDate, input.endDate, input.accrualFrom ?? null],
    );
  } catch (error) {
    return friendly(error, 'year');
  }
  const after = (await getAcademicYear(q, id)) as AcademicYearView;
  return { ok: true, value: { before, after } };
}

export async function listHolidays(q: Queryable, yearId: number): Promise<HolidayView[]> {
  const { rows } = await q.query<HolidayDbRow>(
    `select ${HOLIDAY_COLUMNS} from holidays h where h.academic_year_id = $1 order by h.start_date, h.name`,
    [yearId],
  );
  return rows.map(toHoliday);
}

export async function createHoliday(q: Queryable, yearId: number, input: HolidayInput, userId: number | null): Promise<Outcome<HolidayView>> {
  try {
    const { rows } = await q.query<HolidayDbRow>(
      `with h as (
         insert into holidays (academic_year_id, campus_id, name, kind, start_date, end_date, source, created_by)
         values ($1, $2, $3, $4, $5::date, $6::date, 'Added in the portal', $7) returning *)
       select ${HOLIDAY_COLUMNS} from h`,
      [yearId, input.campusId, input.name, input.kind, input.startDate, input.endDate, userId],
    );
    return { ok: true, value: toHoliday(rows[0]) };
  } catch (error) {
    return friendly(error, 'holiday');
  }
}

export async function updateHoliday(q: Queryable, id: number, input: HolidayInput): Promise<Outcome<{ before: HolidayView; after: HolidayView }>> {
  const existing = await q.query<HolidayDbRow>(`select ${HOLIDAY_COLUMNS} from holidays h where h.id = $1`, [id]);
  if (existing.rows.length === 0) return { ok: false, status: 404, error: 'Holiday not found' };
  try {
    const { rows } = await q.query<HolidayDbRow>(
      `with h as (
         update holidays set campus_id = $2, name = $3, kind = $4, start_date = $5::date, end_date = $6::date
          where id = $1 returning *)
       select ${HOLIDAY_COLUMNS} from h`,
      [id, input.campusId, input.name, input.kind, input.startDate, input.endDate],
    );
    return { ok: true, value: { before: toHoliday(existing.rows[0]), after: toHoliday(rows[0]) } };
  } catch (error) {
    return friendly(error, 'holiday');
  }
}

export async function deleteHoliday(q: Queryable, id: number): Promise<HolidayView | null> {
  const { rows } = await q.query<HolidayDbRow>(
    `with h as (delete from holidays where id = $1 returning *) select ${HOLIDAY_COLUMNS} from h`,
    [id],
  );
  return rows[0] ? toHoliday(rows[0]) : null;
}

/** Confirm every DRAFT holiday of a year. Only then do the dates count for leave. */
export async function confirmYear(q: Queryable, yearId: number, userId: number): Promise<number> {
  const { rowCount } = await q.query(
    `update holidays set status = 'CONFIRMED', confirmed_at = now(), confirmed_by = $2
      where academic_year_id = $1 and status = 'DRAFT'`,
    [yearId, userId],
  );
  return rowCount ?? 0;
}

/** Working days per month, counting draft holidays as if confirmed (a preview for the confirm step). */
export async function previewWorkingDays(q: Queryable, year: AcademicYearView): Promise<{ month: string; workingDays: number }[]> {
  const holidays = await listHolidays(q, year.id);
  const rows: HolidayRow[] = holidays
    .filter(h => h.campusId === null)
    .map(h => ({ kind: h.kind, status: h.status, startDate: h.startDate, endDate: h.endDate, campusId: null }));
  return monthlyWorkingDays(year.startDate, year.endDate, rows);
}

export interface ImportResult {
  yearId: number; yearCreated: boolean; holidaysAdded: number;
  yearStartDate: string; yearEndDate: string;
  /** Official dates that fall outside the organisation's academic year and were NOT imported. */
  skipped: TemplateHoliday[];
}

/**
 * Import a ready-made calendar as DRAFT. Safe to run again: existing rows are left alone.
 * The academic year is the organisation's own: if it already exists its dates are kept; if it is
 * created now it uses the dates given (default: the official ones). Official dates outside the
 * year are skipped and reported, never dropped silently.
 */
export async function importTemplate(
  q: Queryable, template: CalendarTemplate, userId: number | null,
  dates?: { startDate: string; endDate: string },
): Promise<Outcome<ImportResult>> {
  const found = await q.query<{ id: number; start_date: string; end_date: string }>(
    `select id, to_char(start_date, 'YYYY-MM-DD') as start_date, to_char(end_date, 'YYYY-MM-DD') as end_date
       from academic_years where label = $1`,
    [template.label],
  );
  let yearId = found.rows[0]?.id;
  let yearStart = found.rows[0]?.start_date ?? dates?.startDate ?? template.startDate;
  let yearEnd = found.rows[0]?.end_date ?? dates?.endDate ?? template.endDate;
  let yearCreated = false;
  if (!yearId) {
    const created = await createAcademicYear(q, { label: template.label, startDate: yearStart, endDate: yearEnd }, userId);
    if (!created.ok) return created;
    yearId = created.value.id;
    yearCreated = true;
  }
  const usable = template.holidays.filter(h => h.startDate >= yearStart && h.endDate <= yearEnd);
  const skipped = template.holidays.filter(h => !usable.includes(h));
  try {
    const { rowCount } = await q.query(
      `insert into holidays (academic_year_id, name, kind, start_date, end_date, source, created_by)
       select $1, t.name, t.kind, t.start_date::date, t.end_date::date, $6, $7
         from unnest($2::text[], $3::text[], $4::text[], $5::text[]) as t(name, kind, start_date, end_date)
       on conflict do nothing`,
      [
        yearId,
        usable.map(h => h.name), usable.map(h => h.kind),
        usable.map(h => h.startDate), usable.map(h => h.endDate),
        template.source, userId,
      ],
    );
    return { ok: true, value: { yearId, yearCreated, holidaysAdded: rowCount ?? 0, yearStartDate: yearStart, yearEndDate: yearEnd, skipped } };
  } catch (error) {
    return friendly(error, 'holiday');
  }
}
