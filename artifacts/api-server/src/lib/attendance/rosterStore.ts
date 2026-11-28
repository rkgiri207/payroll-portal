import type { Queryable } from './db';
import { EXPECTED_BASE, EXPECTED_FILTER, ON_FULL_LEAVE } from './expectedSql';

export interface DaySummary {
  /** Employees expected to attend today (see the roster rules below). */
  expected: number;
  present: number;
  late: number;
  /** Expected employees with no valid IN today. They are UNMARKED, never "absent". */
  unmarked: number;
  /** Employees who would be expected today but are on approved leave for the whole day. */
  onLeave: number;
  openExceptions: number;
}

/**
 * Today's attendance numbers. The roster ("expected") is every ACTIVE employee with attendance
 * switched on who has an assignment covering the date at an active campus whose shift runs on
 * that weekday. Nobody is ever marked absent automatically.
 *
 * Approved full-day leave and confirmed holidays, weekly offs and vacations are respected (see
 * expectedSql.ts). Known simplification: a temporary REPLACE assignment is not used to hide the
 * primary campus here.
 */
export async function getDaySummary(q: Queryable, workDate: string, weekday: number): Promise<DaySummary> {
  const { rows } = await q.query<{
    expected: number; present: number; late: number; unmarked: number; on_leave: number; open_exceptions: number;
  }>(
    `with expected as (
       select distinct ae.employee_id
         from attendance_employees ae
         join employees e on e.id = ae.employee_id
         join employee_campus_assignments a on a.employee_id = ae.employee_id
         join campuses c on c.id = a.campus_id and c.is_active
        where ${EXPECTED_FILTER}
     ), on_leave as (
       select distinct ae.employee_id
         from attendance_employees ae
         join employees e on e.id = ae.employee_id
         join employee_campus_assignments a on a.employee_id = ae.employee_id
         join campuses c on c.id = a.campus_id and c.is_active
        where ${EXPECTED_BASE} and ${ON_FULL_LEAVE}
     ), ins as (
       select employee_id, punctuality from attendance_events
        where work_date = $1::date and event_type = 'IN' and is_valid
     )
     select (select count(*) from expected)::int as expected,
            (select count(*) from ins)::int as present,
            (select count(*) from ins where punctuality = 'LATE')::int as late,
            (select count(*) from expected x
              where not exists (select 1 from ins i where i.employee_id = x.employee_id))::int as unmarked,
            (select count(*) from on_leave)::int as on_leave,
            (select count(*) from attendance_exceptions where status = 'OPEN')::int as open_exceptions`,
    [workDate, weekday],
  );
  const r = rows[0];
  return {
    expected: r?.expected ?? 0,
    present: r?.present ?? 0,
    late: r?.late ?? 0,
    unmarked: r?.unmarked ?? 0,
    onLeave: r?.on_leave ?? 0,
    openExceptions: r?.open_exceptions ?? 0,
  };
}

/** Number of attendance events and exceptions created since a moment (used to skip idle digests). */
export async function countActivitySince(q: Queryable, since: Date): Promise<number> {
  const { rows } = await q.query<{ total: number }>(
    `select ((select count(*) from attendance_events where server_ts > $1)
           + (select count(*) from attendance_exceptions where created_at > $1))::int as total`,
    [since],
  );
  return rows[0]?.total ?? 0;
}

export interface OpenMissingOut {
  eventId: string;
  employeeId: number;
  employeeCode: string;
  employeeName: string;
  campusId: number;
  campusName: string;
  workDate: string;
  shiftLogoutTime: string;
}

/**
 * Valid IN events in a date range with no valid OUT for the same employee and day, where the
 * IN recorded a shift (so a logout time is known). The sweeper decides which are due.
 */
export async function findInsWithoutOut(q: Queryable, fromDate: string, toDate: string): Promise<OpenMissingOut[]> {
  const { rows } = await q.query<{
    event_id: string; employee_id: number; employee_code: string; employee_name: string;
    campus_id: number; campus_name: string; work_date: string; shift_logout_time: string;
  }>(
    `select ev.id as event_id, ev.employee_id, emp.employee_code, emp.employee_name,
            ev.campus_id, c.name as campus_name, ev.work_date::text as work_date,
            ev.shift_logout_time::text as shift_logout_time
       from attendance_events ev
       join employees emp on emp.id = ev.employee_id
       join campuses c on c.id = ev.campus_id
      where ev.event_type = 'IN' and ev.is_valid
        and ev.work_date between $1::date and $2::date
        and ev.shift_logout_time is not null
        and not exists (
          select 1 from attendance_events o
           where o.employee_id = ev.employee_id and o.work_date = ev.work_date
             and o.event_type = 'OUT' and o.is_valid)`,
    [fromDate, toDate],
  );
  return rows.map(r => ({
    eventId: r.event_id, employeeId: r.employee_id, employeeCode: r.employee_code,
    employeeName: r.employee_name, campusId: r.campus_id, campusName: r.campus_name,
    workDate: r.work_date, shiftLogoutTime: r.shift_logout_time,
  }));
}
