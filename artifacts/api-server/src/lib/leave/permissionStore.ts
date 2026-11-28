import type { Queryable } from '../attendance/db';

export type PermissionStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';

export interface PermissionRecord {
  id: string; status: PermissionStatus; employeeId: number; campusId: number;
  date: string; startTime: string; endTime: string; reason: string; submittedVia: 'WHATSAPP_LINK' | 'MANUAL';
  decidedVia: string | null; decisionNote: string | null; cancelledBy: string | null; cancelReason: string | null;
}

interface Db {
  id: string; status: PermissionStatus; employee_id: number; campus_id: number; permission_date: string;
  start_time: string; end_time: string; reason: string; submitted_via: 'WHATSAPP_LINK' | 'MANUAL';
  decided_via: string | null; decision_note: string | null; cancelled_by: string | null; cancel_reason: string | null;
}

export const PERMISSION_COLUMNS = `id, status, employee_id, campus_id, to_char(permission_date, 'YYYY-MM-DD') as permission_date,
  to_char(start_time, 'HH24:MI') as start_time, to_char(end_time, 'HH24:MI') as end_time, reason, submitted_via,
  decided_via, decision_note, cancelled_by, cancel_reason`;

export const toPermission = (r: Db): PermissionRecord => ({
  id: r.id, status: r.status, employeeId: r.employee_id, campusId: r.campus_id, date: r.permission_date, startTime: r.start_time,
  endTime: r.end_time, reason: r.reason, submittedVia: r.submitted_via, decidedVia: r.decided_via, decisionNote: r.decision_note,
  cancelledBy: r.cancelled_by, cancelReason: r.cancel_reason,
});

export async function findPermissionByKey(q: Queryable, key: string): Promise<PermissionRecord | null> {
  const { rows } = await q.query<Db>(`select ${PERMISSION_COLUMNS} from permission_requests where idempotency_key = $1`, [key]);
  return rows[0] ? toPermission(rows[0]) : null;
}

export async function lockPermission(q: Queryable, id: string): Promise<PermissionRecord | null> {
  const { rows } = await q.query<Db>(`select ${PERMISSION_COLUMNS} from permission_requests where id = $1 for update`, [id]);
  return rows[0] ? toPermission(rows[0]) : null;
}

export interface NewPermission {
  employeeId: number; campusId: number; date: string; startTime: string; endTime: string; reason: string;
  submittedVia: 'WHATSAPP_LINK' | 'MANUAL'; enteredByUserId: number | null; idempotencyKey: string;
}

export async function insertPermission(q: Queryable, p: NewPermission): Promise<string> {
  const { rows } = await q.query<{ id: string }>(
    `insert into permission_requests
       (employee_id, campus_id, permission_date, start_time, end_time, reason, submitted_via, entered_by_user_id, idempotency_key)
     values ($1, $2, $3::date, $4::time, $5::time, $6, $7, $8, $9) returning id`,
    [p.employeeId, p.campusId, p.date, p.startTime, p.endTime, p.reason, p.submittedVia, p.enteredByUserId, p.idempotencyKey],
  );
  return rows[0].id;
}

// ── For the Director's and admins' screens ────────────────────────────────────
export interface PermissionListItem extends PermissionRecord {
  employeeCode: string; employeeName: string; campusName: string; submittedAt: string; decidedAt: string | null;
}

interface ListDb extends Db { employee_code: string; employee_name: string; campus_name: string; submitted_at: string; decided_at: string | null }

const LIST_SELECT = `
  select p.id, p.status, p.employee_id, p.campus_id, to_char(p.permission_date, 'YYYY-MM-DD') as permission_date,
         to_char(p.start_time, 'HH24:MI') as start_time, to_char(p.end_time, 'HH24:MI') as end_time, p.reason, p.submitted_via,
         p.decided_via, p.decision_note, p.cancelled_by, p.cancel_reason, e.employee_code, e.employee_name, c.name as campus_name,
         p.submitted_at::text as submitted_at, p.decided_at::text as decided_at
    from permission_requests p join employees e on e.id = p.employee_id join campuses c on c.id = p.campus_id`;

const toItem = (r: ListDb): PermissionListItem => ({
  ...toPermission(r), employeeCode: r.employee_code, employeeName: r.employee_name, campusName: r.campus_name,
  submittedAt: r.submitted_at, decidedAt: r.decided_at,
});

/** Pending first and oldest first, so the longest-waiting request is at the top; everything else newest first. */
export async function listPermissions(
  q: Queryable, f: { status: PermissionStatus | null; employeeId: number | null; limit: number },
): Promise<PermissionListItem[]> {
  const { rows } = await q.query<ListDb>(
    `${LIST_SELECT}
      where ($1::text is null or p.status = $1) and ($2::int is null or p.employee_id = $2)
      order by (p.status = 'PENDING') desc, case when p.status = 'PENDING' then p.submitted_at end asc, p.submitted_at desc
      limit $3`,
    [f.status, f.employeeId, f.limit],
  );
  return rows.map(toItem);
}

export async function getPermissionItem(q: Queryable, id: string): Promise<PermissionListItem | null> {
  const { rows } = await q.query<ListDb>(`${LIST_SELECT} where p.id = $1`, [id]);
  return rows[0] ? toItem(rows[0]) : null;
}

export async function countPermissionsByStatus(q: Queryable): Promise<Record<PermissionStatus, number>> {
  const { rows } = await q.query<{ status: PermissionStatus; n: number }>('select status, count(*)::int as n from permission_requests group by status');
  const out: Record<PermissionStatus, number> = { PENDING: 0, APPROVED: 0, REJECTED: 0, CANCELLED: 0 };
  for (const r of rows) out[r.status] = r.n;
  return out;
}
