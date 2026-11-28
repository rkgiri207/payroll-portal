import { randomUUID } from 'node:crypto';
import { pgCode, PG_UNIQUE_VIOLATION } from '../attendance/adminAccess';
import { getShifts } from '../attendance/campusData';
import { withTransaction, type PoolLike, type Queryable } from '../attendance/db';
import { loadSettings } from '../attendance/settings';
import type { ShiftRow } from '../attendance/shift';
import { istParts, timeToMinutes } from '../attendance/time';
import type { HolidayRow } from './calendar';
import type { AssignmentRow } from './leaveEvaluate';
import { loadEmployeeFacts } from './leaveLoader';
import { cleanReason } from './leaveEvaluate';
import { evaluatePermission, type PermissionContext, type PermissionErrorCode, type PermissionPlan } from './permissionEvaluate';
import { findPermissionByKey, insertPermission, lockPermission, type PermissionRecord } from './permissionStore';

/**
 * Submitting a permission, and the Director's decision on it. The rules are in permissionEvaluate
 * (pure). A permission uses no leave balance and posts nothing to the leave ledger.
 */

export interface PermissionSubmit {
  employeeId: number; date: string; startTime: string; endTime: string; reason: unknown;
  submittedVia: 'WHATSAPP_LINK' | 'MANUAL'; enteredByUserId: number | null; idempotencyKey?: string; now: Date;
}

export type PermissionRefusal = PermissionErrorCode | 'EMPLOYEE_NOT_FOUND' | 'EMPLOYEE_INACTIVE';

export type PermissionSubmitResult =
  | { status: 'SUBMITTED' | 'DUPLICATE'; request: PermissionRecord; plan?: PermissionPlan }
  | { status: 'REFUSED'; code: PermissionRefusal; message: string };

const refuse = (code: PermissionRefusal, message: string): PermissionSubmitResult => ({ status: 'REFUSED', code, message });

/** Everything the rules need about one employee on one date. */
export async function loadPermissionContext(q: Queryable, employeeId: number, date: string): Promise<{ ctx: PermissionContext; active: boolean } | null> {
  const employee = await loadEmployeeFacts(q, employeeId);
  if (!employee) return null;
  const settings = await loadSettings(q);

  const year = await q.query<{ id: number }>('select id from academic_years where $1::date between start_date and end_date', [date]);
  const yearId = year.rows[0]?.id ?? null;

  const a = await q.query<{ campus_id: number; kind: 'PRIMARY' | 'TEMPORARY'; mode: 'REPLACE' | 'ADDITIONAL'; start_date: string; end_date: string | null }>(
    `select campus_id, kind, mode, to_char(start_date, 'YYYY-MM-DD') as start_date, to_char(end_date, 'YYYY-MM-DD') as end_date
       from employee_campus_assignments where employee_id = $1 and start_date <= $2::date and (end_date is null or end_date >= $2::date)`,
    [employeeId, date],
  );
  const assignments: AssignmentRow[] = a.rows.map(r => ({ campusId: r.campus_id, kind: r.kind, mode: r.mode, startDate: r.start_date, endDate: r.end_date }));
  const shiftsByCampus: Record<number, ShiftRow[]> = {};
  for (const campusId of new Set(assignments.map(x => x.campusId))) shiftsByCampus[campusId] = await getShifts(q, campusId);

  let holidays: HolidayRow[] = [];
  if (yearId !== null) {
    const h = await q.query<{ kind: HolidayRow['kind']; status: HolidayRow['status']; start_date: string; end_date: string; campus_id: number | null }>(
      `select kind, status, to_char(start_date, 'YYYY-MM-DD') as start_date, to_char(end_date, 'YYYY-MM-DD') as end_date, campus_id
         from holidays where academic_year_id = $1 and status = 'CONFIRMED'`,
      [yearId],
    );
    holidays = h.rows.map(r => ({ kind: r.kind, status: r.status, startDate: r.start_date, endDate: r.end_date, campusId: r.campus_id }));
  }

  const leave = await q.query<{ n: number }>(
    'select count(*)::int as n from leave_request_days where employee_id = $1 and leave_date = $2::date and counts_toward_cap', [employeeId, date],
  );
  const existing = await q.query<{ start_time: string; end_time: string }>(
    `select start_time::text as start_time, end_time::text as end_time from permission_requests
      where employee_id = $1 and permission_date = $2::date and status in ('PENDING', 'APPROVED')`,
    [employeeId, date],
  );
  const month = await q.query<{ n: number }>(
    `select count(*)::int as n from permission_requests
      where employee_id = $1 and status in ('PENDING', 'APPROVED') and date_trunc('month', permission_date) = date_trunc('month', $2::date)`,
    [employeeId, date],
  );

  return {
    active: employee.active,
    ctx: {
      inAcademicYear: yearId !== null, assignments, shiftsByCampus, holidays, reportsDuringVacations: employee.reportsDuringVacations,
      onLeave: (leave.rows[0]?.n ?? 0) > 0,
      existing: existing.rows.map(r => ({ startMinutes: timeToMinutes(r.start_time), endMinutes: timeToMinutes(r.end_time) })),
      monthCount: month.rows[0]?.n ?? 0, maxMinutes: settings.permissionMaxMinutes, maxPerMonth: settings.permissionMaxPerMonth,
    },
  };
}

const clockNow = (now: Date) => { const p = istParts(now); return { today: p.workDate, nowMinutes: p.minuteOfDay }; };

export async function previewPermission(
  pool: PoolLike, input: { employeeId: number; date: string; startTime: string; endTime: string; now: Date; byAdmin: boolean },
) {
  const loaded = await loadPermissionContext(pool, input.employeeId, input.date);
  if (!loaded) return { ok: false as const, code: 'EMPLOYEE_NOT_FOUND' as const, message: 'Employee not found' };
  if (!loaded.active) return { ok: false as const, code: 'EMPLOYEE_INACTIVE' as const, message: 'This employee is not active.' };
  return evaluatePermission(loaded.ctx, { date: input.date, startTime: input.startTime, endTime: input.endTime, ...clockNow(input.now), byAdmin: input.byAdmin });
}

export async function submitPermission(pool: PoolLike, input: PermissionSubmit): Promise<PermissionSubmitResult> {
  const key = input.idempotencyKey ?? `permission:${randomUUID()}`;
  const earlier = await findPermissionByKey(pool, key);
  if (earlier) return { status: 'DUPLICATE', request: earlier };

  const reason = cleanReason(input.reason);
  if (!reason.ok) return refuse('INVALID_INPUT', reason.message.replace('for the leave', 'for the permission'));

  const loaded = await loadPermissionContext(pool, input.employeeId, input.date);
  if (!loaded) return refuse('EMPLOYEE_NOT_FOUND', 'Employee not found');
  if (!loaded.active) return refuse('EMPLOYEE_INACTIVE', 'This employee is not active.');

  const result = evaluatePermission(loaded.ctx, {
    date: input.date, startTime: input.startTime, endTime: input.endTime, ...clockNow(input.now), byAdmin: input.submittedVia === 'MANUAL',
  });
  if (!result.ok) return refuse(result.code, result.message);

  try {
    await withTransaction(pool, q => insertPermission(q, {
      employeeId: input.employeeId, campusId: result.plan.campusId, date: input.date, startTime: result.plan.startTime, endTime: result.plan.endTime,
      reason: reason.value, submittedVia: input.submittedVia, enteredByUserId: input.enteredByUserId, idempotencyKey: key,
    }));
  } catch (error) {
    if (pgCode(error) === PG_UNIQUE_VIOLATION) {
      const winner = await findPermissionByKey(pool, key);
      if (winner) return { status: 'DUPLICATE', request: winner };
    }
    if ((error as { code?: string }).code === 'LY004') return refuse('NO_ACADEMIC_YEAR', 'There is no academic year set up for that date.');
    throw error;
  }
  return { status: 'SUBMITTED', request: (await findPermissionByKey(pool, key))!, plan: result.plan };
}

// ── The Director's decision ───────────────────────────────────────────────────
export type DecidedVia = 'WEB' | 'WHATSAPP';
export type PermissionDecision =
  | { status: 'DONE'; request: PermissionRecord }
  | { status: 'NOT_FOUND' }
  | { status: 'ALREADY'; request: PermissionRecord }
  | { status: 'REFUSED'; code: 'NOT_ALLOWED' | 'INVALID_INPUT'; message: string };

const refused = (code: 'NOT_ALLOWED' | 'INVALID_INPUT', message: string): PermissionDecision => ({ status: 'REFUSED', code, message });
const tidy = (v: unknown) => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '');

export async function approvePermission(pool: PoolLike, input: { requestId: string; via: DecidedVia; userId: number | null }): Promise<PermissionDecision> {
  return withTransaction<PermissionDecision>(pool, async q => {
    const r = await lockPermission(q, input.requestId);
    if (!r) return { status: 'NOT_FOUND' };
    if (r.status !== 'PENDING') return { status: 'ALREADY', request: r };
    await q.query(`update permission_requests set status = 'APPROVED', decided_via = $2, decided_by_user_id = $3, decided_at = now() where id = $1`, [r.id, input.via, input.userId]);
    return { status: 'DONE', request: (await lockPermission(q, r.id))! };
  });
}

export async function rejectPermission(pool: PoolLike, input: { requestId: string; via: DecidedVia; userId: number | null; note: unknown }): Promise<PermissionDecision> {
  const note = tidy(input.note);
  if (note === '') return refused('INVALID_INPUT', 'Please give a reason for rejecting.');
  if (note.length > 500) return refused('INVALID_INPUT', 'The reason must be at most 500 characters.');
  return withTransaction<PermissionDecision>(pool, async q => {
    const r = await lockPermission(q, input.requestId);
    if (!r) return { status: 'NOT_FOUND' };
    if (r.status !== 'PENDING') return { status: 'ALREADY', request: r };
    await q.query(`update permission_requests set status = 'REJECTED', decided_via = $2, decided_by_user_id = $3, decided_at = now(), decision_note = $4 where id = $1`,
      [r.id, input.via, input.userId, note]);
    return { status: 'DONE', request: (await lockPermission(q, r.id))! };
  });
}

export type PermissionCanceller = { by: 'EMPLOYEE'; employeeId: number } | { by: 'DIRECTOR' | 'ADMIN' };

export async function cancelPermission(pool: PoolLike, input: { requestId: string; canceller: PermissionCanceller; reason: unknown }): Promise<PermissionDecision> {
  const reason = tidy(input.reason);
  if (reason.length > 500) return refused('INVALID_INPUT', 'The reason must be at most 500 characters.');
  return withTransaction<PermissionDecision>(pool, async q => {
    const r = await lockPermission(q, input.requestId);
    if (!r) return { status: 'NOT_FOUND' };
    if (input.canceller.by === 'EMPLOYEE' && input.canceller.employeeId !== r.employeeId) return { status: 'NOT_FOUND' };
    if (r.status === 'CANCELLED') return { status: 'ALREADY', request: r };
    if (r.status === 'REJECTED') return refused('NOT_ALLOWED', 'A rejected request does not need cancelling.');
    if (r.status === 'APPROVED' && input.canceller.by === 'EMPLOYEE') {
      return refused('NOT_ALLOWED', 'This permission is already approved. Please contact the school administration to cancel it.');
    }
    if (r.status === 'APPROVED' && reason === '') return refused('INVALID_INPUT', 'Please give a reason for cancelling an approved permission.');
    await q.query(`update permission_requests set status = 'CANCELLED', cancelled_at = now(), cancelled_by = $2, cancel_reason = $3 where id = $1`,
      [r.id, input.canceller.by, reason === '' ? null : reason]);
    return { status: 'DONE', request: (await lockPermission(q, r.id))! };
  });
}

