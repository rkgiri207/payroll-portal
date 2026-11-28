import type { Queryable } from '../attendance/db';
import type { DayMode, LeavePlan } from './leaveEvaluate';

export type LeaveStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';

export interface LeaveRequestRecord {
  id: string; status: LeaveStatus; employeeId: number; leaveTypeId: number; academicYearId: number; campusId: number;
  startDate: string; endDate: string; dayMode: DayMode; reason: string;
  totalDays: number; paidDays: number; lopDays: number; submittedVia: 'WHATSAPP_LINK' | 'MANUAL';
  decidedVia: string | null; decisionNote: string | null;
}

interface RequestDb {
  id: string; status: LeaveStatus; employee_id: number; leave_type_id: number; academic_year_id: number; campus_id: number;
  start_date: string; end_date: string; day_mode: DayMode; reason: string;
  total_days: number; paid_days: number; lop_days: number; submitted_via: 'WHATSAPP_LINK' | 'MANUAL';
  decided_via: string | null; decision_note: string | null;
}

export const REQUEST_COLUMNS = `id, status, employee_id, leave_type_id, academic_year_id, campus_id,
  to_char(start_date, 'YYYY-MM-DD') as start_date, to_char(end_date, 'YYYY-MM-DD') as end_date, day_mode, reason,
  total_days::float8 as total_days, paid_days::float8 as paid_days, lop_days::float8 as lop_days, submitted_via,
  decided_via, decision_note`;

export const toRequest = (r: RequestDb): LeaveRequestRecord => ({
  id: r.id, status: r.status, employeeId: r.employee_id, leaveTypeId: r.leave_type_id, academicYearId: r.academic_year_id,
  campusId: r.campus_id, startDate: r.start_date, endDate: r.end_date, dayMode: r.day_mode, reason: r.reason,
  totalDays: r.total_days, paidDays: r.paid_days, lopDays: r.lop_days, submittedVia: r.submitted_via,
  decidedVia: r.decided_via, decisionNote: r.decision_note,
});

export async function findRequestByKey(q: Queryable, key: string): Promise<LeaveRequestRecord | null> {
  const { rows } = await q.query<RequestDb>(`select ${REQUEST_COLUMNS} from leave_requests where idempotency_key = $1`, [key]);
  return rows[0] ? toRequest(rows[0]) : null;
}

export interface NewRequest {
  employeeId: number; leaveTypeId: number; academicYearId: number; startDate: string; endDate: string; dayMode: DayMode;
  reason: string; plan: LeavePlan; submittedVia: 'WHATSAPP_LINK' | 'MANUAL'; enteredByUserId: number | null; idempotencyKey: string;
}

const INSERT_REQUEST = `insert into leave_requests
  (employee_id, campus_id, leave_type_id, academic_year_id, start_date, end_date, day_mode, reason, total_days, paid_days,
   lop_days, submitted_via, entered_by_user_id, idempotency_key`;
const REQUEST_VALUES = `$1, $2, $3, $4, $5::date, $6::date, $7, $8, $9, $10, $11, $12, $13, $14`;

const requestParams = (r: NewRequest) => [
  r.employeeId, r.plan.campusId, r.leaveTypeId, r.academicYearId, r.startDate, r.endDate, r.dayMode, r.reason,
  r.plan.totalDays, r.plan.paidDays, r.plan.lopDays, r.submittedVia, r.enteredByUserId, r.idempotencyKey,
];

/**
 * Save a PENDING request and one row per leave day. The per-campus, per-date limit is enforced by
 * the database while the day rows are inserted: if any date is full the whole statement fails
 * (SQLSTATE LC001) and the caller's transaction rolls back, so nothing is half-saved.
 */
export async function insertPendingRequest(q: Queryable, r: NewRequest): Promise<string> {
  const { rows } = await q.query<{ id: string }>(`${INSERT_REQUEST}) values (${REQUEST_VALUES}) returning id`, requestParams(r));
  const id = rows[0].id;
  await q.query(
    `insert into leave_request_days (request_id, employee_id, campus_id, leave_date, fraction)
     select $1, $2, t.campus_id, t.leave_date::date, t.fraction
       from unnest($3::int[], $4::text[], $5::numeric[]) as t(campus_id, leave_date, fraction)`,
    [id, r.employeeId, r.plan.days.map(d => d.campusId), r.plan.days.map(d => d.date), r.plan.days.map(d => d.fraction)],
  );
  return id;
}

/** Keep a record of a request the system refused because a date was full. It never counts towards the limit. */
export async function insertAutoRejectedRequest(q: Queryable, r: NewRequest, note: string): Promise<string> {
  const { rows } = await q.query<{ id: string }>(
    `${INSERT_REQUEST}, status, decided_via, decided_at, decision_note)
     values (${REQUEST_VALUES}, 'REJECTED', 'SYSTEM', now(), $15) returning id`,
    [...requestParams(r), note],
  );
  return rows[0].id;
}

export async function getLeaveCap(q: Queryable): Promise<number> {
  const { rows } = await q.query<{ value: unknown }>(`select value from attendance_settings where key = 'leave_cap_per_campus_per_day'`);
  const v = rows[0]?.value;
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : 2;
}

/** Which of these campus/date pairs are already full? Used to tell the employee which dates to avoid. */
export async function findFullDates(q: Queryable, days: { campusId: number; date: string }[], cap: number): Promise<string[]> {
  const { rows } = await q.query<{ leave_date: string }>(
    `select distinct to_char(d.leave_date, 'YYYY-MM-DD') as leave_date
       from (select unnest($1::int[]) as campus_id, unnest($2::text[])::date as leave_date) d
      where (select count(*) from leave_request_days r
              where r.campus_id = d.campus_id and r.leave_date = d.leave_date and r.counts_toward_cap) >= $3
      order by 1`,
    [days.map(d => d.campusId), days.map(d => d.date), cap],
  );
  return rows.map(r => r.leave_date);
}
