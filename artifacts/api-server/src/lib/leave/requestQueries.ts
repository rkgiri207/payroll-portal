import type { Queryable } from '../attendance/db';
import type { DayMode } from './leaveEvaluate';
import type { LeaveStatus } from './leaveRequestStore';

export interface RequestListItem {
  id: string; status: LeaveStatus; employeeId: number; employeeCode: string; employeeName: string;
  leaveTypeId: number; leaveTypeName: string; academicYearId: number; academicYearLabel: string;
  campusId: number; campusName: string; startDate: string; endDate: string; dayMode: DayMode; reason: string;
  totalDays: number; paidDays: number; lopDays: number; submittedVia: 'WHATSAPP_LINK' | 'MANUAL';
  submittedAt: string; decidedVia: string | null; decidedAt: string | null; decisionNote: string | null;
  cancelledBy: string | null; cancelReason: string | null;
}

interface Db {
  id: string; status: LeaveStatus; employee_id: number; employee_code: string; employee_name: string;
  leave_type_id: number; leave_type_name: string; academic_year_id: number; academic_year_label: string;
  campus_id: number; campus_name: string; start_date: string; end_date: string; day_mode: DayMode; reason: string;
  total_days: number; paid_days: number; lop_days: number; submitted_via: 'WHATSAPP_LINK' | 'MANUAL';
  submitted_at: string; decided_via: string | null; decided_at: string | null; decision_note: string | null;
  cancelled_by: string | null; cancel_reason: string | null;
}

const SELECT = `
  select r.id, r.status, r.employee_id, e.employee_code, e.employee_name, r.leave_type_id, t.name as leave_type_name,
         r.academic_year_id, y.label as academic_year_label, r.campus_id, c.name as campus_name,
         to_char(r.start_date, 'YYYY-MM-DD') as start_date, to_char(r.end_date, 'YYYY-MM-DD') as end_date,
         r.day_mode, r.reason, r.total_days::float8 as total_days, r.paid_days::float8 as paid_days, r.lop_days::float8 as lop_days,
         r.submitted_via, r.submitted_at::text as submitted_at, r.decided_via, r.decided_at::text as decided_at,
         r.decision_note, r.cancelled_by, r.cancel_reason
    from leave_requests r
    join employees e on e.id = r.employee_id
    join leave_types t on t.id = r.leave_type_id
    join academic_years y on y.id = r.academic_year_id
    join campuses c on c.id = r.campus_id`;

const toItem = (r: Db): RequestListItem => ({
  id: r.id, status: r.status, employeeId: r.employee_id, employeeCode: r.employee_code, employeeName: r.employee_name,
  leaveTypeId: r.leave_type_id, leaveTypeName: r.leave_type_name, academicYearId: r.academic_year_id,
  academicYearLabel: r.academic_year_label, campusId: r.campus_id, campusName: r.campus_name, startDate: r.start_date,
  endDate: r.end_date, dayMode: r.day_mode, reason: r.reason, totalDays: r.total_days, paidDays: r.paid_days, lopDays: r.lop_days,
  submittedVia: r.submitted_via, submittedAt: r.submitted_at, decidedVia: r.decided_via, decidedAt: r.decided_at,
  decisionNote: r.decision_note, cancelledBy: r.cancelled_by, cancelReason: r.cancel_reason,
});

export interface RequestFilter { status: LeaveStatus | null; academicYearId: number | null; employeeId: number | null; limit: number }

/**
 * Requests for the Director's and admins' screens. Pending ones come first and oldest first, so
 * the longest-waiting request is at the top; everything else is newest first.
 */
export async function listRequests(q: Queryable, f: RequestFilter): Promise<RequestListItem[]> {
  const { rows } = await q.query<Db>(
    `${SELECT}
      where ($1::text is null or r.status = $1)
        and ($2::int is null or r.academic_year_id = $2)
        and ($3::int is null or r.employee_id = $3)
      order by (r.status = 'PENDING') desc,
               case when r.status = 'PENDING' then r.submitted_at end asc,
               r.submitted_at desc
      limit $4`,
    [f.status, f.academicYearId, f.employeeId, f.limit],
  );
  return rows.map(toItem);
}

export async function countByStatus(q: Queryable, academicYearId: number | null): Promise<Record<LeaveStatus, number>> {
  const { rows } = await q.query<{ status: LeaveStatus; n: number }>(
    `select status, count(*)::int as n from leave_requests where ($1::int is null or academic_year_id = $1) group by status`,
    [academicYearId],
  );
  const out: Record<LeaveStatus, number> = { PENDING: 0, APPROVED: 0, REJECTED: 0, CANCELLED: 0 };
  for (const r of rows) out[r.status] = r.n;
  return out;
}

export async function getRequestItem(q: Queryable, id: string): Promise<RequestListItem | null> {
  const { rows } = await q.query<Db>(`${SELECT} where r.id = $1`, [id]);
  return rows[0] ? toItem(rows[0]) : null;
}

export async function listRequestDays(q: Queryable, id: string): Promise<{ date: string; fraction: number; campusName: string }[]> {
  const { rows } = await q.query<{ leave_date: string; fraction: number; campus_name: string }>(
    `select to_char(d.leave_date, 'YYYY-MM-DD') as leave_date, d.fraction::float8 as fraction, c.name as campus_name
       from leave_request_days d join campuses c on c.id = d.campus_id where d.request_id = $1 order by d.leave_date`,
    [id],
  );
  return rows.map(r => ({ date: r.leave_date, fraction: r.fraction, campusName: r.campus_name }));
}
