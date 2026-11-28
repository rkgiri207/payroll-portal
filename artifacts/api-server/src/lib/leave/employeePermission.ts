import { withTransaction, type PoolLike } from '../attendance/db';
import { enqueueMessage } from '../attendance/outboxStore';
import { portalBaseUrl } from '../attendance/alerts';
import type { InboundMessage } from '../attendance/inbound';
import { loadSettings } from '../attendance/settings';
import { istParts } from '../attendance/time';
import { cancelPermission, previewPermission, submitPermission } from './permissionService';
import { createFormToken, lookupFormToken, markFormTokenUsed, type FormToken } from './formTokens';
import type { HttpResult, Notifier } from './employeeLeave';
import { permissionWhen } from './permissionNotifications';
import { clockText } from './permissionEvaluate';
import { niceDay } from './leaveEvaluate';

/**
 * What an employee can do about permissions themselves: ask for the form with the PERMISSION command,
 * see what a request would be, send it, and cancel a pending one. Same one-time-link security as the
 * leave form: the link is the only credential and belongs to one employee.
 */

type Deps = { pool: PoolLike; now: () => Date };

const closedFor = (state: 'USED' | 'EXPIRED' | 'NOT_FOUND'): HttpResult => ({ http: state === 'NOT_FOUND' ? 404 : 410, body: { ok: false, state } });
const invalid = (message: string): HttpResult => ({ http: 400, body: { ok: false, state: 'REFUSED', code: 'INVALID_INPUT', message } });

async function openToken(deps: Deps, token: unknown, allowUsed = false): Promise<{ ok: true; record: FormToken } | { ok: false; reply: HttpResult }> {
  const found = await lookupFormToken(deps.pool, token, 'PERMISSION', deps.now());
  if (found.state === 'OPEN' || (allowUsed && found.state === 'USED')) return { ok: true, record: found.record! };
  // An OPEN token has already returned above, so what is left is USED, EXPIRED or NOT_FOUND.
  return { ok: false, reply: closedFor(found.state) };
}

// ── WhatsApp: PERMISSION ──────────────────────────────────────────────────────
export const permissionFormText = (url: string, ttlMinutes: number): string =>
  `Open this link to ask for permission:\n${url}\n\nThe link works for ${ttlMinutes} minutes. Do not share it with anyone.`;

export async function handlePermissionCommand(
  deps: { pool: PoolLike; env: NodeJS.ProcessEnv; now: () => Date }, employee: { employeeId: number }, message: InboundMessage,
): Promise<void> {
  const settings = await loadSettings(deps.pool);
  const baseUrl = portalBaseUrl(settings, deps.env);
  if (!baseUrl) throw new Error('No public base URL is configured for permission links');
  await withTransaction(deps.pool, async q => {
    const token = await createFormToken(q, { employeeId: employee.employeeId, purpose: 'PERMISSION', ttlMinutes: settings.formTokenTtlMinutes, sourceMessageId: message.id, now: deps.now() });
    if (!token) return; // the same WhatsApp message already produced a link
    await enqueueMessage(q, {
      recipientType: 'EMPLOYEE', recipientE164: message.from, employeeId: employee.employeeId, kind: 'LINK', deliveryMode: 'TEXT',
      payload: { body: permissionFormText(`${baseUrl}/p/${token.token}`, settings.formTokenTtlMinutes) },
      idempotencyKey: `permission-form:${token.id}`,
    });
  });
}

// ── The form ─────────────────────────────────────────────────────────────────
export async function getPermissionFormInfo(deps: Deps, token: unknown): Promise<HttpResult> {
  const t = await openToken(deps, token);
  if (!t.ok) return t.reply;
  const now = deps.now();
  const { workDate: today } = istParts(now);
  const { rows: who } = await deps.pool.query<{ employee_name: string; status: string }>('select employee_name, status from employees where id = $1', [t.record.employeeId]);
  if (!who[0] || who[0].status !== 'ACTIVE') return closedFor('NOT_FOUND');
  const settings = await loadSettings(deps.pool);
  const year = await deps.pool.query<{ label: string }>('select label from academic_years where $1::date between start_date and end_date', [today]);
  const used = await deps.pool.query<{ n: number }>(
    `select count(*)::int as n from permission_requests
      where employee_id = $1 and status in ('PENDING', 'APPROVED') and date_trunc('month', permission_date) = date_trunc('month', $2::date)`,
    [t.record.employeeId, today],
  );
  const { rows } = await deps.pool.query<{ id: string; status: string; permission_date: string; start_time: string; end_time: string; decision_note: string | null }>(
    `select id, status, to_char(permission_date, 'YYYY-MM-DD') as permission_date, to_char(start_time, 'HH24:MI') as start_time,
            to_char(end_time, 'HH24:MI') as end_time, decision_note
       from permission_requests where employee_id = $1 order by submitted_at desc limit 10`,
    [t.record.employeeId],
  );
  return {
    http: 200,
    body: {
      ok: true, name: who[0].employee_name, today, serverTime: now.toISOString(), expiresAt: t.record.expiresAt.toISOString(),
      year: year.rows[0] ? { label: year.rows[0].label } : null,
      limits: { maxMinutes: settings.permissionMaxMinutes, maxPerMonth: settings.permissionMaxPerMonth, usedThisMonth: used.rows[0]?.n ?? 0 },
      requests: rows.map(r => ({
        id: r.id, status: r.status, date: niceDay(r.permission_date), from: clockText(r.start_time), to: clockText(r.end_time),
        note: r.status === 'REJECTED' ? r.decision_note : null, canCancel: r.status === 'PENDING',
      })),
    },
  };
}

interface FormInput { date: string; startTime: string; endTime: string; reason: unknown }
function readInput(body: Record<string, unknown> | undefined): FormInput | null {
  if (!body || typeof body.date !== 'string' || typeof body.startTime !== 'string' || typeof body.endTime !== 'string') return null;
  return { date: body.date, startTime: body.startTime, endTime: body.endTime, reason: body.reason };
}

export async function previewPermissionForm(deps: Deps, token: unknown, body: Record<string, unknown> | undefined): Promise<HttpResult> {
  const t = await openToken(deps, token);
  if (!t.ok) return t.reply;
  const input = readInput(body);
  if (!input) return invalid('Please choose a date, a start time and an end time.');
  const result = await previewPermission(deps.pool, { employeeId: t.record.employeeId, ...input, now: deps.now(), byAdmin: false });
  if (!result.ok) return { http: 200, body: { ok: false, state: 'REFUSED', code: result.code, message: result.message } };
  return { http: 200, body: { ok: true, minutes: result.plan.minutes, startTime: result.plan.startTime, endTime: result.plan.endTime } };
}

/** Send the request. The link is used up only when the request is accepted. */
export async function submitPermissionForm(deps: Deps & { notify: PermissionNotifier }, token: unknown, body: Record<string, unknown> | undefined): Promise<HttpResult> {
  const t = await openToken(deps, token);
  if (!t.ok) return t.reply;
  const input = readInput(body);
  if (!input) return invalid('Please choose a date, a start time and an end time.');
  const result = await submitPermission(deps.pool, {
    employeeId: t.record.employeeId, ...input, submittedVia: 'WHATSAPP_LINK', enteredByUserId: null, idempotencyKey: `pform:${t.record.id}`, now: deps.now(),
  });
  if (result.status === 'REFUSED') return { http: 200, body: { ok: false, state: 'REFUSED', code: result.code, message: result.message } };
  await markFormTokenUsed(deps.pool, t.record.id);
  const r = result.request;
  if (result.status === 'SUBMITTED') {
    await deps.notify.permissionSubmitted(r.id);
    await deps.notify.replyToEmployee(t.record.employeeId, `Your permission request for ${permissionWhen(r)} has been sent to the Director. You will get a message when it is decided.`, `permission-submitted:${r.id}`);
  }
  return { http: 200, body: { ok: true, duplicate: result.status === 'DUPLICATE', request: { id: r.id, date: niceDay(r.date), from: clockText(r.startTime), to: clockText(r.endTime) } } };
}

export async function cancelPermissionForm(deps: Deps, token: unknown, body: Record<string, unknown> | undefined): Promise<HttpResult> {
  const t = await openToken(deps, token, true);
  if (!t.ok) return t.reply;
  const requestId = typeof body?.requestId === 'string' ? body.requestId : '';
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(requestId)) return invalid('That request could not be found.');
  const result = await cancelPermission(deps.pool, { requestId, canceller: { by: 'EMPLOYEE', employeeId: t.record.employeeId }, reason: body?.reason ?? '' });
  if (result.status === 'NOT_FOUND') return { http: 404, body: { ok: false, state: 'NOT_FOUND', message: 'That request could not be found.' } };
  if (result.status === 'REFUSED') return { http: 200, body: { ok: false, state: 'REFUSED', code: result.code, message: result.message } };
  return { http: 200, body: { ok: true, already: result.status === 'ALREADY' } };
}

/** The WhatsApp side effects, passed in so they never block a request and can be replaced in tests. */
export interface PermissionNotifier {
  permissionSubmitted(requestId: string): Promise<void>;
  replyToEmployee: Notifier['replyToEmployee'];
}
