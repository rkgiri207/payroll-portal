import { PG_FOREIGN_KEY_VIOLATION, PG_UNIQUE_VIOLATION, pgCode } from './adminAccess';
import type { AssignmentInput, CampusInput, RegistrationInput, ShiftInput } from './adminValidation';
import { withTransaction, type PoolLike, type Queryable } from './db';
import { addDays } from './time';

// NOTE: dates are cast to text and numerics to float8 in every query so the driver returns
// plain strings and numbers (it would otherwise return Date objects and numeric strings).

/** "Expected today": the campus shift runs on this weekday and the employee is active and applicable. */
const EXPECTED_FILTER = `
  ae.attendance_applicable and e.status = 'ACTIVE'
  and a.start_date <= $1::date and (a.end_date is null or a.end_date >= $1::date)
  and exists (select 1 from campus_shifts s
               where s.campus_id = a.campus_id and s.effective_from <= $1::date and $2::smallint = any(s.weekdays))`;

export type StoreResult<T> = { ok: true; value: T } | { ok: false; error: string };
const okay = <T>(value: T): StoreResult<T> => ({ ok: true, value });
const failed = <T = never>(error: string): StoreResult<T> => ({ ok: false, error });

// ── Campuses ──────────────────────────────────────────────────────────────────
export interface CampusRow {
  id: number; code: string; name: string; address: string | null;
  latitude: number | null; longitude: number | null; geofenceRadiusM: number;
  requiredAccuracyM: number | null; isActive: boolean; shiftCount: number; employeeCount: number;
}

const CAMPUS_COLUMNS = `c.id, c.code, c.name, c.address, c.latitude::float8 as latitude, c.longitude::float8 as longitude,
  c.geofence_radius_m, c.required_accuracy_m, c.is_active`;

interface RawCampus {
  id: number; code: string; name: string; address: string | null; latitude: number | null; longitude: number | null;
  geofence_radius_m: number; required_accuracy_m: number | null; is_active: boolean; shift_count?: number; employee_count?: number;
}
const toCampus = (r: RawCampus): CampusRow => ({
  id: r.id, code: r.code, name: r.name, address: r.address, latitude: r.latitude, longitude: r.longitude,
  geofenceRadiusM: r.geofence_radius_m, requiredAccuracyM: r.required_accuracy_m, isActive: r.is_active,
  shiftCount: r.shift_count ?? 0, employeeCount: r.employee_count ?? 0,
});

export async function listCampuses(q: Queryable, today: string): Promise<CampusRow[]> {
  const { rows } = await q.query<RawCampus>(
    `select ${CAMPUS_COLUMNS},
            (select count(*) from campus_shifts s where s.campus_id = c.id)::int as shift_count,
            (select count(distinct a.employee_id) from employee_campus_assignments a
              where a.campus_id = c.id and a.start_date <= $1::date and (a.end_date is null or a.end_date >= $1::date))::int as employee_count
       from campuses c order by c.is_active desc, c.name`,
    [today],
  );
  return rows.map(toCampus);
}

export async function getCampusRow(q: Queryable, id: number): Promise<CampusRow | null> {
  const { rows } = await q.query<RawCampus>(`select ${CAMPUS_COLUMNS} from campuses c where c.id = $1`, [id]);
  return rows[0] ? toCampus(rows[0]) : null;
}

export async function createCampus(q: Queryable, input: CampusInput): Promise<StoreResult<CampusRow>> {
  try {
    const { rows } = await q.query<{ id: number }>(
      `insert into campuses (code, name, address, latitude, longitude, geofence_radius_m, required_accuracy_m, is_active)
       values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
      [input.code, input.name, input.address, input.latitude, input.longitude, input.geofenceRadiusM, input.requiredAccuracyM, input.isActive],
    );
    const created = await getCampusRow(q, rows[0].id);
    return created ? okay(created) : failed('Could not read the new campus');
  } catch (error) {
    if (pgCode(error) === PG_UNIQUE_VIOLATION) return failed('That campus code is already in use');
    throw error;
  }
}

export async function updateCampus(q: Queryable, id: number, input: CampusInput): Promise<StoreResult<{ before: CampusRow; after: CampusRow }>> {
  const before = await getCampusRow(q, id);
  if (!before) return failed('Campus not found');
  try {
    await q.query(
      `update campuses set code = $2, name = $3, address = $4, latitude = $5, longitude = $6,
              geofence_radius_m = $7, required_accuracy_m = $8, is_active = $9, updated_at = now()
        where id = $1`,
      [id, input.code, input.name, input.address, input.latitude, input.longitude, input.geofenceRadiusM, input.requiredAccuracyM, input.isActive],
    );
  } catch (error) {
    if (pgCode(error) === PG_UNIQUE_VIOLATION) return failed('That campus code is already in use');
    throw error;
  }
  const after = await getCampusRow(q, id);
  return after ? okay({ before, after }) : failed('Campus not found');
}

// ── Shifts ────────────────────────────────────────────────────────────────────
export interface ShiftView {
  id: number; campusId: number; loginTime: string; logoutTime: string; graceMinutes: number;
  weekdays: number[]; effectiveFrom: string;
}

export async function listShiftViews(q: Queryable, campusId: number): Promise<ShiftView[]> {
  const { rows } = await q.query<{
    id: number; campus_id: number; login_time: string; logout_time: string; grace_minutes: number;
    weekdays: number[]; effective_from: string;
  }>(
    `select id, campus_id, login_time::text as login_time, logout_time::text as logout_time, grace_minutes,
            weekdays, effective_from::text as effective_from
       from campus_shifts where campus_id = $1 order by effective_from desc, id desc`,
    [campusId],
  );
  return rows.map(r => ({
    id: r.id, campusId: r.campus_id, loginTime: r.login_time.slice(0, 5), logoutTime: r.logout_time.slice(0, 5),
    graceMinutes: r.grace_minutes, weekdays: r.weekdays.map(Number), effectiveFrom: r.effective_from,
  }));
}

/** Shifts are never edited; a change is a NEW row with a later effective date (history stays intact). */
export async function createShift(q: Queryable, campusId: number, input: ShiftInput, userId: number): Promise<StoreResult<ShiftView>> {
  try {
    const { rows } = await q.query<{ id: number }>(
      `insert into campus_shifts (campus_id, login_time, logout_time, grace_minutes, weekdays, effective_from, created_by)
       values ($1, $2::time, $3::time, $4, $5::smallint[], $6::date, $7) returning id`,
      [campusId, input.loginTime, input.logoutTime, input.graceMinutes, input.weekdays, input.effectiveFrom, userId],
    );
    const all = await listShiftViews(q, campusId);
    const created = all.find(s => s.id === rows[0].id);
    return created ? okay(created) : failed('Could not read the new shift');
  } catch (error) {
    if (pgCode(error) === PG_UNIQUE_VIOLATION) return failed('A shift with the same days and start date already exists');
    if (pgCode(error) === PG_FOREIGN_KEY_VIOLATION) return failed('Campus not found');
    throw error;
  }
}

/** Only a shift that has not started yet may be deleted; started shifts are history. */
export async function deleteFutureShift(q: Queryable, id: number, today: string): Promise<StoreResult<ShiftView | null>> {
  const { rows } = await q.query<{ id: number; campus_id: number; effective_from: string }>(
    'select id, campus_id, effective_from::text as effective_from from campus_shifts where id = $1', [id],
  );
  const row = rows[0];
  if (!row) return failed('Shift not found');
  if (row.effective_from <= today) {
    return failed('This shift has already started. Add a new shift with a later start date instead.');
  }
  const before = (await listShiftViews(q, row.campus_id)).find(s => s.id === id) ?? null;
  await q.query('delete from campus_shifts where id = $1', [id]);
  return okay(before);
}

// ── Employees: registration and assignments ──────────────────────────────────
export interface EmployeeRow {
  id: number; employeeCode: string; employeeName: string; designation: string | null; branch: string | null;
  status: string; mobileNumber: string | null; whatsapp: string | null; attendanceApplicable: boolean;
  hasRegistration: boolean; primaryCampusId: number | null; primaryCampusName: string | null; activeTemporary: number;
}

export async function listEmployees(
  q: Queryable,
  opts: { today: string; search: string | null; status: string | null; limit: number; offset: number },
): Promise<{ rows: EmployeeRow[]; total: number }> {
  const search = opts.search ? `%${opts.search.replace(/[%_\\]/g, m => `\\${m}`)}%` : null;
  // Placeholder numbers differ between the list query (after $1 = today) and the count query.
  const filter = (searchParam: number, statusParam: number) =>
    `($${searchParam}::text is null or e.employee_name ilike $${searchParam} or e.employee_code ilike $${searchParam})
     and ($${statusParam}::text is null or e.status::text = $${statusParam})`;
  const { rows } = await q.query<{
    id: number; employee_code: string; employee_name: string; designation: string | null; branch: string | null;
    status: string; mobile_number: string | null; whatsapp_e164: string | null; attendance_applicable: boolean;
    has_registration: boolean; primary_campus_id: number | null; primary_campus_name: string | null; active_temporary: number;
  }>(
    `select e.id, e.employee_code, e.employee_name, e.designation, e.branch, e.status::text as status, e.mobile_number,
            ae.whatsapp_e164, coalesce(ae.attendance_applicable, true) as attendance_applicable,
            (ae.employee_id is not null) as has_registration,
            pc.id as primary_campus_id, pc.name as primary_campus_name,
            (select count(*) from employee_campus_assignments t
              where t.employee_id = e.id and t.kind = 'TEMPORARY'
                and t.start_date <= $1::date and t.end_date >= $1::date)::int as active_temporary
       from employees e
       left join attendance_employees ae on ae.employee_id = e.id
       left join lateral (
         select c.id, c.name from employee_campus_assignments a join campuses c on c.id = a.campus_id
          where a.employee_id = e.id and a.kind = 'PRIMARY'
            and a.start_date <= $1::date and (a.end_date is null or a.end_date >= $1::date)
          order by a.start_date desc limit 1) pc on true
      where ${filter(2, 3)}
      order by e.employee_name, e.id
      limit $4 offset $5`,
    [opts.today, search, opts.status, opts.limit, opts.offset],
  );
  const count = await q.query<{ total: number }>(
    `select count(*)::int as total from employees e where ${filter(1, 2)}`, [search, opts.status],
  );
  return {
    total: count.rows[0]?.total ?? 0,
    rows: rows.map(r => ({
      id: r.id, employeeCode: r.employee_code, employeeName: r.employee_name, designation: r.designation,
      branch: r.branch, status: r.status, mobileNumber: r.mobile_number, whatsapp: r.whatsapp_e164,
      attendanceApplicable: r.attendance_applicable, hasRegistration: r.has_registration,
      primaryCampusId: r.primary_campus_id, primaryCampusName: r.primary_campus_name, activeTemporary: r.active_temporary,
    })),
  };
}

export interface Registration { employeeId: number; whatsapp: string | null; attendanceApplicable: boolean }

export async function getRegistration(q: Queryable, employeeId: number): Promise<Registration | null> {
  const { rows } = await q.query<{ employee_id: number; whatsapp_e164: string | null; attendance_applicable: boolean }>(
    'select employee_id, whatsapp_e164, attendance_applicable from attendance_employees where employee_id = $1', [employeeId],
  );
  const r = rows[0];
  return r ? { employeeId: r.employee_id, whatsapp: r.whatsapp_e164, attendanceApplicable: r.attendance_applicable } : null;
}

/** Create or update an employee's attendance registration (WhatsApp number and on/off switch). */
export async function saveRegistration(
  q: Queryable, employeeId: number, input: RegistrationInput, userId: number,
): Promise<StoreResult<{ before: Registration | null; after: Registration }>> {
  const before = await getRegistration(q, employeeId);
  try {
    await q.query(
      `insert into attendance_employees (employee_id, whatsapp_e164, attendance_applicable, registered_at, registered_by)
       values ($1, $2::text, $3, case when $2::text is null then null else now() end, $4)
       on conflict (employee_id) do update set
         whatsapp_e164 = excluded.whatsapp_e164,
         attendance_applicable = excluded.attendance_applicable,
         registered_at = case
           when excluded.whatsapp_e164 is null then null
           when attendance_employees.whatsapp_e164 is distinct from excluded.whatsapp_e164 then now()
           else attendance_employees.registered_at end,
         registered_by = $4, updated_at = now()`,
      [employeeId, input.whatsapp, input.attendanceApplicable, userId],
    );
  } catch (error) {
    if (pgCode(error) === PG_UNIQUE_VIOLATION) return failed('That WhatsApp number is already registered to another employee');
    if (pgCode(error) === PG_FOREIGN_KEY_VIOLATION) return failed('Employee not found');
    throw error;
  }
  const after = await getRegistration(q, employeeId);
  return after ? okay({ before, after }) : failed('Could not save the registration');
}

export interface AssignmentView {
  id: number; employeeId: number; campusId: number; campusName: string; kind: 'PRIMARY' | 'TEMPORARY';
  mode: 'REPLACE' | 'ADDITIONAL'; startDate: string; endDate: string | null; note: string | null;
}

export async function listAssignments(q: Queryable, employeeId: number): Promise<AssignmentView[]> {
  const { rows } = await q.query<{
    id: number; employee_id: number; campus_id: number; campus_name: string; kind: 'PRIMARY' | 'TEMPORARY';
    mode: 'REPLACE' | 'ADDITIONAL'; start_date: string; end_date: string | null; note: string | null;
  }>(
    `select a.id, a.employee_id, a.campus_id, c.name as campus_name, a.kind, a.mode,
            a.start_date::text as start_date, a.end_date::text as end_date, a.note
       from employee_campus_assignments a join campuses c on c.id = a.campus_id
      where a.employee_id = $1 order by a.start_date desc, a.id desc`,
    [employeeId],
  );
  return rows.map(r => ({
    id: r.id, employeeId: r.employee_id, campusId: r.campus_id, campusName: r.campus_name, kind: r.kind,
    mode: r.mode, startDate: r.start_date, endDate: r.end_date, note: r.note,
  }));
}

/**
 * Add an assignment. A new PRIMARY campus closes the previous open primary the day before it
 * starts, so an employee always has one primary campus at a time.
 */
export async function createAssignment(
  pool: PoolLike, employeeId: number, input: AssignmentInput, userId: number,
): Promise<StoreResult<AssignmentView>> {
  return withTransaction<StoreResult<AssignmentView>>(pool, async q => {
    const employee = await q.query('select 1 from employees where id = $1', [employeeId]);
    if ((employee.rowCount ?? employee.rows.length) === 0) return failed('Employee not found');
    const campus = await q.query<{ is_active: boolean }>('select is_active from campuses where id = $1', [input.campusId]);
    if (campus.rows.length === 0) return failed('Campus not found');
    if (!campus.rows[0].is_active) return failed('That campus is not active');

    if (input.kind === 'PRIMARY') {
      const open = await q.query<{ id: number; start_date: string; campus_id: number }>(
        `select id, start_date::text as start_date, campus_id from employee_campus_assignments
          where employee_id = $1 and kind = 'PRIMARY' and end_date is null`,
        [employeeId],
      );
      const current = open.rows[0];
      if (current) {
        if (current.campus_id === input.campusId) return failed('That is already the primary campus');
        if (current.start_date >= input.startDate) {
          return failed(`The current primary campus started on ${current.start_date}. Choose a later start date.`);
        }
        await q.query('update employee_campus_assignments set end_date = $2::date where id = $1', [current.id, addDays(input.startDate, -1)]);
      }
    }

    const inserted = await q.query<{ id: number }>(
      `insert into employee_campus_assignments (employee_id, campus_id, kind, mode, start_date, end_date, note, created_by)
       values ($1, $2, $3, $4, $5::date, $6::date, $7, $8) returning id`,
      [employeeId, input.campusId, input.kind, input.mode, input.startDate, input.endDate, input.note, userId],
    );
    const created = (await listAssignments(q, employeeId)).find(a => a.id === inserted.rows[0].id);
    return created ? okay(created) : failed('Could not read the new assignment');
  });
}

/**
 * Remove an assignment: one that has not started is deleted; one in progress is ended
 * yesterday. Nothing else references assignments, so no attendance history is affected.
 */
export async function removeAssignment(
  q: Queryable, id: number, today: string,
): Promise<StoreResult<{ action: 'DELETED' | 'ENDED'; before: AssignmentView }>> {
  const { rows } = await q.query<{ employee_id: number }>('select employee_id from employee_campus_assignments where id = $1', [id]);
  if (!rows[0]) return failed('Assignment not found');
  const before = (await listAssignments(q, rows[0].employee_id)).find(a => a.id === id);
  if (!before) return failed('Assignment not found');
  if (before.endDate !== null && before.endDate < today) return failed('That assignment has already ended');

  if (before.startDate >= today) {
    await q.query('delete from employee_campus_assignments where id = $1', [id]);
    return okay({ action: 'DELETED', before });
  }
  await q.query('update employee_campus_assignments set end_date = $2::date where id = $1', [id, addDays(today, -1)]);
  return okay({ action: 'ENDED', before });
}

// ── Dashboard ─────────────────────────────────────────────────────────────────
export interface CampusSummary { campusId: number; campusName: string; expected: number; present: number; late: number; unmarked: number }

export async function getCampusSummaries(q: Queryable, workDate: string, weekday: number): Promise<CampusSummary[]> {
  const { rows } = await q.query<{ id: number; name: string; expected: number; present: number; late: number; unmarked: number }>(
    `select c.id, c.name,
       (select count(distinct a.employee_id) from employee_campus_assignments a
          join attendance_employees ae on ae.employee_id = a.employee_id
          join employees e on e.id = a.employee_id
         where a.campus_id = c.id and ${EXPECTED_FILTER})::int as expected,
       (select count(*) from attendance_events ev
         where ev.campus_id = c.id and ev.work_date = $1::date and ev.event_type = 'IN' and ev.is_valid)::int as present,
       (select count(*) from attendance_events ev
         where ev.campus_id = c.id and ev.work_date = $1::date and ev.event_type = 'IN' and ev.is_valid
           and ev.punctuality = 'LATE')::int as late,
       (select count(distinct a.employee_id) from employee_campus_assignments a
          join attendance_employees ae on ae.employee_id = a.employee_id
          join employees e on e.id = a.employee_id
         where a.campus_id = c.id and ${EXPECTED_FILTER}
           and not exists (select 1 from attendance_events ev where ev.employee_id = a.employee_id
                            and ev.work_date = $1::date and ev.event_type = 'IN' and ev.is_valid))::int as unmarked
       from campuses c where c.is_active order by c.name`,
    [workDate, weekday],
  );
  return rows.map(r => ({ campusId: r.id, campusName: r.name, expected: r.expected, present: r.present, late: r.late, unmarked: r.unmarked }));
}

export interface UnmarkedEmployee { employeeId: number; employeeCode: string; employeeName: string; campusName: string }

export async function listUnmarked(q: Queryable, workDate: string, weekday: number, limit = 300): Promise<UnmarkedEmployee[]> {
  const { rows } = await q.query<{ id: number; employee_code: string; employee_name: string; campus_name: string }>(
    `select distinct on (e.id) e.id, e.employee_code, e.employee_name, c.name as campus_name
       from employee_campus_assignments a
       join attendance_employees ae on ae.employee_id = a.employee_id
       join employees e on e.id = a.employee_id
       join campuses c on c.id = a.campus_id and c.is_active
      where ${EXPECTED_FILTER}
        and not exists (select 1 from attendance_events ev where ev.employee_id = e.id
                         and ev.work_date = $1::date and ev.event_type = 'IN' and ev.is_valid)
      order by e.id, a.kind, c.name
      limit $3`,
    [workDate, weekday, limit],
  );
  return rows
    .map(r => ({ employeeId: r.id, employeeCode: r.employee_code, employeeName: r.employee_name, campusName: r.campus_name }))
    .sort((a, b) => a.employeeName.localeCompare(b.employeeName));
}

export interface FeedEvent {
  id: string; eventType: 'IN' | 'OUT'; serverTs: Date; punctuality: string; lateMinutes: number | null;
  reviewStatus: string; gpsResult: string | null; gpsDistanceM: number | null; hasSelfie: boolean; source: string;
  employeeId: number; employeeCode: string; employeeName: string; campusName: string;
  /** Status of the Director's WhatsApp alert for this event, if one was queued. */
  directorAlert: string | null;
}

const EVENT_SELECT = `ev.id, ev.event_type, ev.server_ts, ev.punctuality, ev.late_minutes, ev.review_status, ev.gps_result,
       ev.gps_distance_m::float8 as gps_distance_m, (ev.selfie_path is not null and ev.selfie_deleted_at is null) as has_selfie,
       ev.source, e.id as employee_id, e.employee_code, e.employee_name, c.name as campus_name,
       (select o.status from notification_outbox o where o.event_id = ev.id and o.recipient_type = 'DIRECTOR'
         order by o.created_at desc limit 1) as director_alert`;

interface RawEvent {
  id: string; event_type: 'IN' | 'OUT'; server_ts: Date; punctuality: string; late_minutes: number | null;
  review_status: string; gps_result: string | null; gps_distance_m: number | null; has_selfie: boolean; source: string;
  employee_id: number; employee_code: string; employee_name: string; campus_name: string; director_alert: string | null;
}
const toFeedEvent = (r: RawEvent): FeedEvent => ({
  id: r.id, eventType: r.event_type, serverTs: r.server_ts, punctuality: r.punctuality, lateMinutes: r.late_minutes,
  reviewStatus: r.review_status, gpsResult: r.gps_result, gpsDistanceM: r.gps_distance_m, hasSelfie: r.has_selfie,
  source: r.source, employeeId: r.employee_id, employeeCode: r.employee_code, employeeName: r.employee_name,
  campusName: r.campus_name, directorAlert: r.director_alert,
});

export async function getTodayFeed(q: Queryable, workDate: string, limit = 60): Promise<FeedEvent[]> {
  const { rows } = await q.query<RawEvent>(
    `select ${EVENT_SELECT}
       from attendance_events ev join employees e on e.id = ev.employee_id join campuses c on c.id = ev.campus_id
      where ev.is_valid and ev.work_date = $1::date
      order by ev.server_ts desc limit $2`,
    [workDate, limit],
  );
  return rows.map(toFeedEvent);
}

export async function listPendingReview(q: Queryable, sinceDate: string, limit = 60): Promise<FeedEvent[]> {
  const { rows } = await q.query<RawEvent>(
    `select ${EVENT_SELECT}
       from attendance_events ev join employees e on e.id = ev.employee_id join campuses c on c.id = ev.campus_id
      where ev.is_valid and ev.review_status = 'PENDING' and ev.work_date >= $1::date
      order by ev.server_ts desc limit $2`,
    [sinceDate, limit],
  );
  return rows.map(toFeedEvent);
}

export interface AlertProblem {
  id: string; kind: string; status: string; recipientType: 'DIRECTOR' | 'EMPLOYEE'; employeeName: string | null;
  lastError: string | null; attempts: number; createdAt: Date;
}

/** Alerts that failed, or are still being retried: they stay visible so nothing is silently lost. */
export async function listAlertProblems(q: Queryable, limit = 20): Promise<AlertProblem[]> {
  const { rows } = await q.query<{
    id: string; kind: string; status: string; recipient_type: 'DIRECTOR' | 'EMPLOYEE'; employee_name: string | null;
    last_error: string | null; attempts: number; created_at: Date;
  }>(
    `select o.id, o.kind, o.status, o.recipient_type, e.employee_name, o.last_error, o.attempts, o.created_at
       from notification_outbox o left join employees e on e.id = o.employee_id
      where o.status = 'FAILED' or (o.status = 'QUEUED' and o.attempts > 0)
      order by o.created_at desc limit $1`,
    [limit],
  );
  return rows.map(r => ({
    id: r.id, kind: r.kind, status: r.status, recipientType: r.recipient_type, employeeName: r.employee_name,
    lastError: r.last_error, attempts: r.attempts, createdAt: r.created_at,
  }));
}

export async function countPendingReview(q: Queryable, sinceDate: string): Promise<number> {
  const { rows } = await q.query<{ total: number }>(
    `select count(*)::int as total from attendance_events
      where is_valid and review_status = 'PENDING' and work_date >= $1::date`,
    [sinceDate],
  );
  return rows[0]?.total ?? 0;
}

/** Approve or reject an event's review. The database freezes everything else about the event. */
export async function reviewEvent(
  q: Queryable, id: string, userId: number, status: 'APPROVED' | 'REJECTED', note: string | null,
): Promise<StoreResult<{ before: string }>> {
  const current = await q.query<{ review_status: string }>('select review_status from attendance_events where id = $1', [id]);
  if (!current.rows[0]) return failed('Attendance record not found');
  await q.query(
    `update attendance_events set review_status = $2, reviewed_by = $3, reviewed_at = now(), review_note = $4 where id = $1`,
    [id, status, userId, note],
  );
  return okay({ before: current.rows[0].review_status });
}

export async function getSelfiePath(q: Queryable, eventId: string): Promise<{ path: string; employeeId: number } | null> {
  const { rows } = await q.query<{ selfie_path: string | null; selfie_deleted_at: Date | null; employee_id: number }>(
    'select selfie_path, selfie_deleted_at, employee_id from attendance_events where id = $1', [eventId],
  );
  const r = rows[0];
  return r && r.selfie_path && !r.selfie_deleted_at ? { path: r.selfie_path, employeeId: r.employee_id } : null;
}

// ── Employee profile (basic; the full profile comes in a later phase) ─────────
export async function getEmployeeProfile(q: Queryable, employeeId: number, today: string) {
  const info = await q.query<{
    id: number; employee_code: string; employee_name: string; designation: string | null; branch: string | null; status: string;
  }>(
    `select id, employee_code, employee_name, designation, branch, status::text as status from employees where id = $1`,
    [employeeId],
  );
  if (!info.rows[0]) return null;
  const e = info.rows[0];
  const recent = await q.query<RawEvent>(
    `select ${EVENT_SELECT}
       from attendance_events ev join employees e on e.id = ev.employee_id join campuses c on c.id = ev.campus_id
      where ev.is_valid and ev.employee_id = $1 order by ev.server_ts desc limit 15`,
    [employeeId],
  );
  return {
    employee: { id: e.id, employeeCode: e.employee_code, employeeName: e.employee_name, designation: e.designation, branch: e.branch, status: e.status },
    registration: await getRegistration(q, employeeId),
    assignments: (await listAssignments(q, employeeId)).filter(a => a.endDate === null || a.endDate >= today),
    recentEvents: recent.rows.map(toFeedEvent),
  };
}

// ── Setup checklist ───────────────────────────────────────────────────────────
export interface SetupCounts {
  campuses: number; campusesWithLocation: number; campusesWithShift: number;
  activeEmployees: number; registeredNumbers: number; withPrimaryCampus: number;
}

export async function getSetupCounts(q: Queryable, today: string): Promise<SetupCounts> {
  const { rows } = await q.query<{
    campuses: number; with_location: number; with_shift: number; active_employees: number; registered: number; with_primary: number;
  }>(
    `select (select count(*) from campuses where is_active)::int as campuses,
            (select count(*) from campuses where is_active and latitude is not null and longitude is not null)::int as with_location,
            (select count(*) from campuses c where c.is_active and exists (select 1 from campus_shifts s where s.campus_id = c.id))::int as with_shift,
            (select count(*) from employees where status = 'ACTIVE')::int as active_employees,
            (select count(*) from attendance_employees ae join employees e on e.id = ae.employee_id
              where e.status = 'ACTIVE' and ae.whatsapp_e164 is not null)::int as registered,
            (select count(distinct a.employee_id) from employee_campus_assignments a join employees e on e.id = a.employee_id
              where e.status = 'ACTIVE' and a.kind = 'PRIMARY' and a.start_date <= $1::date
                and (a.end_date is null or a.end_date >= $1::date))::int as with_primary`,
    [today],
  );
  const r = rows[0];
  return {
    campuses: r?.campuses ?? 0, campusesWithLocation: r?.with_location ?? 0, campusesWithShift: r?.with_shift ?? 0,
    activeEmployees: r?.active_employees ?? 0, registeredNumbers: r?.registered ?? 0, withPrimaryCampus: r?.with_primary ?? 0,
  };
}
