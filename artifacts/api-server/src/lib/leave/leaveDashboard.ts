import type { Queryable } from '../attendance/db';
import { addDays } from './calendar';

/**
 * The leave and permission numbers on the attendance dashboard. Read-only. Only DECISIONS count:
 * approved leave is "on leave"; a pending request is only a number waiting for the Director.
 */

export interface OnLeaveItem {
  employeeId: number; employeeCode: string; employeeName: string; campusName: string; leaveType: string;
  /** A half-day: the employee still works the other half, so they are not counted as away for the day. */
  halfDay: boolean; dayMode: 'FULL' | 'FIRST_HALF' | 'SECOND_HALF';
  startDate: string; endDate: string; totalDays: number;
}

export async function listOnLeaveToday(q: Queryable, date: string, limit = 300): Promise<OnLeaveItem[]> {
  const { rows } = await q.query<{
    id: number; employee_code: string; employee_name: string; campus_name: string; leave_type: string; fraction: number;
    day_mode: OnLeaveItem['dayMode']; start_date: string; end_date: string; total_days: number;
  }>(
    `select e.id, e.employee_code, e.employee_name, c.name as campus_name, t.name as leave_type, d.fraction::float8 as fraction,
            r.day_mode, to_char(r.start_date, 'YYYY-MM-DD') as start_date, to_char(r.end_date, 'YYYY-MM-DD') as end_date,
            r.total_days::float8 as total_days
       from leave_request_days d
       join leave_requests r on r.id = d.request_id and r.status = 'APPROVED'
       join employees e on e.id = d.employee_id and e.status = 'ACTIVE'
       join leave_types t on t.id = r.leave_type_id
       join campuses c on c.id = d.campus_id
      where d.leave_date = $1::date
      order by e.employee_name, e.id
      limit $2`,
    [date, limit],
  );
  return rows.map(r => ({
    employeeId: r.id, employeeCode: r.employee_code, employeeName: r.employee_name, campusName: r.campus_name, leaveType: r.leave_type,
    halfDay: r.fraction < 1, dayMode: r.day_mode, startDate: r.start_date, endDate: r.end_date, totalDays: r.total_days,
  }));
}

export interface PermissionToday {
  employeeId: number; employeeCode: string; employeeName: string; campusName: string; startTime: string; endTime: string; reason: string;
}

export async function listPermissionsToday(q: Queryable, date: string, limit = 300): Promise<PermissionToday[]> {
  const { rows } = await q.query<{
    id: number; employee_code: string; employee_name: string; campus_name: string; start_time: string; end_time: string; reason: string;
  }>(
    `select e.id, e.employee_code, e.employee_name, c.name as campus_name, to_char(p.start_time, 'HH24:MI') as start_time,
            to_char(p.end_time, 'HH24:MI') as end_time, p.reason
       from permission_requests p
       join employees e on e.id = p.employee_id and e.status = 'ACTIVE'
       join campuses c on c.id = p.campus_id
      where p.permission_date = $1::date and p.status = 'APPROVED'
      order by p.start_time, e.employee_name
      limit $2`,
    [date, limit],
  );
  return rows.map(r => ({
    employeeId: r.id, employeeCode: r.employee_code, employeeName: r.employee_name, campusName: r.campus_name,
    startTime: r.start_time, endTime: r.end_time, reason: r.reason,
  }));
}

/** Requests waiting for the Director's decision, all dates. */
export async function countPendingApprovals(q: Queryable): Promise<{ leave: number; permission: number }> {
  const { rows } = await q.query<{ leave: number; permission: number }>(
    `select (select count(*) from leave_requests where status = 'PENDING')::int as leave,
            (select count(*) from permission_requests where status = 'PENDING')::int as permission`,
  );
  return { leave: rows[0]?.leave ?? 0, permission: rows[0]?.permission ?? 0 };
}

export interface UpcomingDay { date: string; employees: number }

/** How many people have approved leave on each of the next `days` days after `date` (zero days are included). */
export async function upcomingLeave(q: Queryable, date: string, days = 7): Promise<UpcomingDay[]> {
  const { rows } = await q.query<{ leave_date: string; n: number }>(
    `select to_char(d.leave_date, 'YYYY-MM-DD') as leave_date, count(distinct d.employee_id)::int as n
       from leave_request_days d join leave_requests r on r.id = d.request_id and r.status = 'APPROVED'
      where d.leave_date between $1::date and $2::date
      group by d.leave_date`,
    [addDays(date, 1), addDays(date, days)],
  );
  const counts = new Map(rows.map(r => [r.leave_date, r.n]));
  return Array.from({ length: days }, (_, i) => {
    const day = addDays(date, i + 1);
    return { date: day, employees: counts.get(day) ?? 0 };
  });
}

export interface DayNotice { kind: 'HOLIDAY' | 'WEEKLY_OFF' | 'VACATION' | 'SPECIAL_WORKING_DAY' | 'OPTIONAL'; name: string }

/**
 * Why today is not a normal working day for everyone, from the CONFIRMED calendar, or null. Calendar
 * entries for a single campus are not shown here (they would be wrong for the other campuses).
 */
export async function getDayNotice(q: Queryable, date: string): Promise<DayNotice | null> {
  const { rows } = await q.query<{ kind: DayNotice['kind']; name: string }>(
    `select kind, name from holidays
      where status = 'CONFIRMED' and campus_id is null and $1::date between start_date and end_date
      order by case kind when 'SPECIAL_WORKING_DAY' then 0 when 'HOLIDAY' then 1 when 'WEEKLY_OFF' then 2 when 'VACATION' then 3 else 4 end, id
      limit 1`,
    [date],
  );
  return rows[0] ? { kind: rows[0].kind, name: rows[0].name } : null;
}
