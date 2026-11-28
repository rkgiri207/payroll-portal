import type { PoolLike, Queryable } from '../attendance/db';
import { istParts } from '../attendance/time';
import { cancelLeave } from './decisionService';
import { createFormToken, lookupFormToken, markFormTokenUsed, type FormToken } from './formTokens';
import { evaluateLeave, type DayMode } from './leaveEvaluate';
import { loadLeaveFacts } from './leaveLoader';
import { dayRangeText } from './leaveNotifications';
import { capReachedText, submitLeaveRequest } from './leaveService';

/**
 * What an employee can do themselves: open their leave form from a WhatsApp link, see what a
 * request would cost, send it, cancel a pending one, and ask for their balance.
 *
 * The one-time link is the only credential and belongs to one employee, so every action here is
 * for that employee and nobody else. Refusals explain themselves in plain words and never reveal
 * anything about other employees (for example who else is on leave).
 */

export interface HttpResult { http: number; body: Record<string, unknown> }

type Deps = { pool: PoolLike; now: () => Date };

const closedFor = (state: 'USED' | 'EXPIRED' | 'NOT_FOUND'): HttpResult =>
  ({ http: state === 'NOT_FOUND' ? 404 : 410, body: { ok: false, state } });

// ── The balance, for the form and for the BALANCE command ─────────────────────
export interface TypeBalance {
  leaveTypeId: number; name: string; isPaid: boolean; tracksBalance: boolean;
  /** Days available now: the balance less paid days already promised to pending requests. */
  available: number;
  allowHalfDay: boolean; minNoticeDays: number; maxConsecutiveDays: number | null;
}

export async function currentYear(q: Queryable, today: string): Promise<{ id: number; label: string; startDate: string; endDate: string } | null> {
  const { rows } = await q.query<{ id: number; label: string; start_date: string; end_date: string }>(
    `select id, label, to_char(start_date, 'YYYY-MM-DD') as start_date, to_char(end_date, 'YYYY-MM-DD') as end_date
       from academic_years where $1::date between start_date and end_date`,
    [today],
  );
  const r = rows[0];
  return r ? { id: r.id, label: r.label, startDate: r.start_date, endDate: r.end_date } : null;
}

export async function listBalances(q: Queryable, employeeId: number, yearId: number): Promise<TypeBalance[]> {
  const { rows } = await q.query<{
    id: number; name: string; is_paid: boolean; tracks_balance: boolean; available: number;
    allow_half_day: boolean | null; min_notice_days: number | null; max_consecutive_days: number | null;
  }>(
    `select t.id, t.name, t.is_paid, t.tracks_balance,
            (coalesce(b.balance, 0) - coalesce(p.reserved, 0))::float8 as available,
            pol.allow_half_day, pol.min_notice_days, pol.max_consecutive_days
       from leave_types t
       left join leave_balances b on b.leave_type_id = t.id and b.employee_id = $1 and b.academic_year_id = $2
       left join (select leave_type_id, sum(paid_days) as reserved from leave_requests
                   where employee_id = $1 and academic_year_id = $2 and status = 'PENDING' group by leave_type_id) p
              on p.leave_type_id = t.id
       left join leave_policies pol on pol.leave_type_id = t.id and pol.academic_year_id = $2
      where t.is_active
      order by t.sort_order, t.id`,
    [employeeId, yearId],
  );
  return rows.map(r => ({
    leaveTypeId: r.id, name: r.name, isPaid: r.is_paid, tracksBalance: r.tracks_balance, available: r.available,
    allowHalfDay: r.allow_half_day ?? true, minNoticeDays: r.min_notice_days ?? 0, maxConsecutiveDays: r.max_consecutive_days,
  }));
}

/** The reply to the BALANCE command. */
export async function balanceText(q: Queryable, employeeId: number, today: string): Promise<string> {
  const year = await currentYear(q, today);
  if (!year) return 'No academic year is set up for today. Please contact the school administration.';
  const lines = (await listBalances(q, employeeId, year.id)).filter(b => b.tracksBalance)
    .map(b => `${b.name}: ${b.available} day${b.available === 1 ? '' : 's'}`);
  if (lines.length === 0) return `No leave balance is set up for ${year.label} yet. Please contact the school administration.`;
  return `Your leave balance for ${year.label} (available now, after any requests waiting for approval):\n${lines.join('\n')}\n\nTo apply for leave, send LEAVE.`;
}

/** The WhatsApp message carrying the form link. */
export const leaveFormText = (url: string, ttlMinutes: number): string =>
  `Open this link to apply for leave:\n${url}\n\nThe link works for ${ttlMinutes} minutes. Do not share it with anyone.`;

export async function startLeaveForm(
  q: Queryable, input: { employeeId: number; sourceMessageId: string; ttlMinutes: number; now: Date },
): Promise<{ id: string; token: string; expiresAt: Date } | null> {
  return createFormToken(q, { employeeId: input.employeeId, purpose: 'LEAVE', ttlMinutes: input.ttlMinutes, sourceMessageId: input.sourceMessageId, now: input.now });
}

// ── The form ─────────────────────────────────────────────────────────────────
async function openToken(deps: Deps, token: unknown, allowUsed = false): Promise<{ ok: true; record: FormToken } | { ok: false; reply: HttpResult }> {
  const found = await lookupFormToken(deps.pool, token, 'LEAVE', deps.now());
  if (found.state === 'OPEN' || (allowUsed && found.state === 'USED')) return { ok: true, record: found.record! };
  // An OPEN token has already returned above, so what is left is USED, EXPIRED or NOT_FOUND.
  return { ok: false, reply: closedFor(found.state) };
}

export async function getFormInfo(deps: Deps, token: unknown): Promise<HttpResult> {
  const t = await openToken(deps, token);
  if (!t.ok) return t.reply;
  const now = deps.now();
  const today = istParts(now).workDate;
  const { rows: who } = await deps.pool.query<{ employee_name: string; status: string }>('select employee_name, status from employees where id = $1', [t.record.employeeId]);
  if (!who[0] || who[0].status !== 'ACTIVE') return closedFor('NOT_FOUND');

  const year = await currentYear(deps.pool, today);
  const balances = year ? await listBalances(deps.pool, t.record.employeeId, year.id) : [];
  const { rows } = await deps.pool.query<{
    id: string; status: string; type_name: string; start_date: string; end_date: string; day_mode: DayMode;
    total_days: number; paid_days: number; lop_days: number; decision_note: string | null;
  }>(
    `select r.id, r.status, t.name as type_name, to_char(r.start_date, 'YYYY-MM-DD') as start_date, to_char(r.end_date, 'YYYY-MM-DD') as end_date,
            r.day_mode, r.total_days::float8 as total_days, r.paid_days::float8 as paid_days, r.lop_days::float8 as lop_days, r.decision_note
       from leave_requests r join leave_types t on t.id = r.leave_type_id
      where r.employee_id = $1 and not (r.status = 'REJECTED' and r.decided_via = 'SYSTEM')
      order by r.submitted_at desc limit 10`,
    [t.record.employeeId],
  );
  return {
    http: 200,
    body: {
      ok: true, name: who[0].employee_name, today, serverTime: now.toISOString(), expiresAt: t.record.expiresAt.toISOString(),
      year: year ? { label: year.label, startDate: year.startDate, endDate: year.endDate } : null,
      leaveTypes: balances.map(b => ({
        id: b.leaveTypeId, name: b.name, isPaid: b.isPaid, tracksBalance: b.tracksBalance, available: b.tracksBalance ? b.available : null,
        allowHalfDay: b.allowHalfDay, minNoticeDays: b.minNoticeDays, maxConsecutiveDays: b.maxConsecutiveDays,
      })),
      requests: rows.map(r => ({
        id: r.id, status: r.status, leaveType: r.type_name, dates: dayRangeText({ startDate: r.start_date, endDate: r.end_date, dayMode: r.day_mode }),
        totalDays: r.total_days, paidDays: r.paid_days, lopDays: r.lop_days, note: r.status === 'REJECTED' ? r.decision_note : null,
        canCancel: r.status === 'PENDING',
      })),
    },
  };
}

interface FormInput { leaveTypeId: number; startDate: string; endDate: string; dayMode: DayMode; reason: unknown }

function readInput(body: Record<string, unknown> | undefined): FormInput | null {
  if (!body) return null;
  const leaveTypeId = Number(body.leaveTypeId);
  const startDate = typeof body.startDate === 'string' ? body.startDate : '';
  const endDate = typeof body.endDate === 'string' && body.endDate !== '' ? body.endDate : startDate;
  const dayMode = body.dayMode === undefined ? 'FULL' : body.dayMode;
  if (!Number.isInteger(leaveTypeId) || leaveTypeId <= 0 || !startDate) return null;
  if (dayMode !== 'FULL' && dayMode !== 'FIRST_HALF' && dayMode !== 'SECOND_HALF') return null;
  return { leaveTypeId, startDate, endDate, dayMode, reason: body.reason };
}

const invalid = (message: string): HttpResult => ({ http: 400, body: { ok: false, state: 'REFUSED', code: 'INVALID_INPUT', message } });

/** What the request would cost, without sending it. */
export async function previewForm(deps: Deps, token: unknown, body: Record<string, unknown> | undefined): Promise<HttpResult> {
  const t = await openToken(deps, token);
  if (!t.ok) return t.reply;
  const input = readInput(body);
  if (!input) return invalid('Please choose a leave type and a start date.');
  const today = istParts(deps.now()).workDate;
  const facts = await loadLeaveFacts(deps.pool, t.record.employeeId, input.leaveTypeId, input.startDate, input.endDate);
  if ('error' in facts) return invalid('Please choose a leave type.');
  const result = evaluateLeave(facts.context, { startDate: input.startDate, endDate: input.endDate, dayMode: input.dayMode, today, byAdmin: false });
  if (!result.ok) return { http: 200, body: { ok: false, state: 'REFUSED', code: result.code, message: result.message } };
  return {
    http: 200,
    body: {
      ok: true, totalDays: result.plan.totalDays, paidDays: result.plan.paidDays, lopDays: result.plan.lopDays,
      dates: result.plan.days.map(d => d.date), yearLabel: facts.context.year?.label ?? null,
    },
  };
}

/** Send the request. The link is used up only when the request is accepted or declined for a full date. */
export async function submitForm(
  deps: Deps & { notify: Notifier }, token: unknown, body: Record<string, unknown> | undefined,
): Promise<HttpResult> {
  const t = await openToken(deps, token);
  if (!t.ok) return t.reply;
  const input = readInput(body);
  if (!input) return invalid('Please choose a leave type and a start date.');

  const result = await submitLeaveRequest(deps.pool, {
    employeeId: t.record.employeeId, leaveTypeId: input.leaveTypeId, startDate: input.startDate, endDate: input.endDate, dayMode: input.dayMode,
    reason: input.reason, submittedVia: 'WHATSAPP_LINK', enteredByUserId: null, idempotencyKey: `form:${t.record.id}`, today: istParts(deps.now()).workDate,
  });

  if (result.status === 'REFUSED') {
    return { http: 200, body: { ok: false, state: 'REFUSED', code: result.code, message: result.message } };
  }
  await markFormTokenUsed(deps.pool, t.record.id);

  if (result.status === 'CAP_REACHED') {
    const message = capReachedText(result.cap, result.fullDates);
    await deps.notify.replyToEmployee(t.record.employeeId, message, `cap:${result.request.id}`);
    return { http: 200, body: { ok: false, state: 'CAP_REACHED', message } };
  }

  const r = result.request;
  const summary = { id: r.id, dates: dayRangeText(r), totalDays: r.totalDays, paidDays: r.paidDays, lopDays: r.lopDays };
  if (result.status === 'SUBMITTED') {
    await deps.notify.requestSubmitted(r.id);
    await deps.notify.replyToEmployee(
      t.record.employeeId,
      `Your leave request for ${dayRangeText(r)} (${r.totalDays} day${r.totalDays === 1 ? '' : 's'}) has been sent to the Director. You will get a message when it is decided.`,
      `submitted:${r.id}`,
    );
  }
  return { http: 200, body: { ok: true, duplicate: result.status === 'DUPLICATE', request: summary } };
}

/** Cancel one of the employee's own pending requests. */
export async function cancelForm(deps: Deps, token: unknown, body: Record<string, unknown> | undefined): Promise<HttpResult> {
  const t = await openToken(deps, token, true);
  if (!t.ok) return t.reply;
  const requestId = typeof body?.requestId === 'string' ? body.requestId : '';
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(requestId)) return invalid('That request could not be found.');
  const result = await cancelLeave(deps.pool, {
    requestId, canceller: { by: 'EMPLOYEE', employeeId: t.record.employeeId }, reason: body?.reason ?? '', today: istParts(deps.now()).workDate,
  });
  if (result.status === 'NOT_FOUND') return { http: 404, body: { ok: false, state: 'NOT_FOUND', message: 'That request could not be found.' } };
  if (result.status === 'REFUSED') return { http: 200, body: { ok: false, state: 'REFUSED', code: result.code, message: result.message } };
  return { http: 200, body: { ok: true, already: result.status === 'ALREADY' } };
}

/** The WhatsApp side effects, passed in so they can be replaced in tests and never block a request. */
export interface Notifier {
  requestSubmitted(requestId: string): Promise<void>;
  replyToEmployee(employeeId: number, body: string, key: string): Promise<void>;
}

