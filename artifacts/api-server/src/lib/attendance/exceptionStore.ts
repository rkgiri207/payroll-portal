import type { Queryable } from './db';

export type ExceptionKind =
  | 'GPS_OUTSIDE_RADIUS' | 'POOR_ACCURACY' | 'TOKEN_LOCKED' | 'MISSING_OUT'
  | 'NO_SHIFT' | 'OUTSIDE_WORKING_DAY' | 'SUSPICIOUS' | 'OTHER';

export interface NewException {
  employeeId: number;
  campusId: number | null;
  workDate: string;
  kind: ExceptionKind;
  detail?: string | null;
  eventId?: string | null;
  tokenId?: string | null;
}

/**
 * Open an exception. Returns its id, or null if it already exists (only one MISSING_OUT per
 * employee per day is allowed, so repeated sweeps never create duplicates).
 */
export async function openException(q: Queryable, e: NewException): Promise<string | null> {
  const { rows } = await q.query<{ id: string }>(
    `insert into attendance_exceptions (employee_id, campus_id, work_date, kind, detail, event_id, token_id)
     values ($1, $2, $3::date, $4, $5, $6, $7)
     on conflict do nothing
     returning id`,
    [e.employeeId, e.campusId, e.workDate, e.kind, e.detail ?? null, e.eventId ?? null, e.tokenId ?? null],
  );
  return rows[0]?.id ?? null;
}

export interface ExceptionRow {
  id: string;
  employeeId: number;
  employeeCode: string;
  employeeName: string;
  campusId: number | null;
  campusName: string | null;
  workDate: string;
  kind: ExceptionKind;
  detail: string | null;
  status: 'OPEN' | 'REVIEWED' | 'RESOLVED';
  createdAt: Date;
}

export async function listExceptions(
  q: Queryable,
  opts: { status?: 'OPEN' | 'REVIEWED' | 'RESOLVED'; limit?: number } = {},
): Promise<ExceptionRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const { rows } = await q.query<{
    id: string; employee_id: number; employee_code: string; employee_name: string;
    campus_id: number | null; campus_name: string | null; work_date: string;
    kind: ExceptionKind; detail: string | null; status: 'OPEN' | 'REVIEWED' | 'RESOLVED'; created_at: Date;
  }>(
    `select x.id, x.employee_id, e.employee_code, e.employee_name, x.campus_id, c.name as campus_name,
            x.work_date::text as work_date, x.kind, x.detail, x.status, x.created_at
       from attendance_exceptions x
       join employees e on e.id = x.employee_id
       left join campuses c on c.id = x.campus_id
      where ($1::text is null or x.status = $1)
      order by x.created_at desc
      limit $2`,
    [opts.status ?? null, limit],
  );
  return rows.map(r => ({
    id: r.id, employeeId: r.employee_id, employeeCode: r.employee_code, employeeName: r.employee_name,
    campusId: r.campus_id, campusName: r.campus_name, workDate: r.work_date, kind: r.kind,
    detail: r.detail, status: r.status, createdAt: r.created_at,
  }));
}

/** Mark an exception reviewed or resolved. False if it does not exist. */
export async function reviewException(
  q: Queryable,
  id: string,
  userId: number,
  status: 'REVIEWED' | 'RESOLVED',
  note: string | null,
): Promise<boolean> {
  const { rowCount } = await q.query(
    `update attendance_exceptions
        set status = $2, resolved_by = $3, resolved_at = now(), resolution_note = $4
      where id = $1`,
    [id, status, userId, note],
  );
  return (rowCount ?? 0) === 1;
}
