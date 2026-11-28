/**
 * Calls the public leave-form endpoints. The one-time link token is the only credential: no cookies
 * are sent and nothing is stored in the browser. The token is never logged.
 */

export type ClosedState = 'NOT_FOUND' | 'EXPIRED' | 'USED' | 'UNAVAILABLE';
export type DayMode = 'FULL' | 'FIRST_HALF' | 'SECOND_HALF';

export interface LeaveTypeInfo {
  id: number; name: string; isPaid: boolean; tracksBalance: boolean;
  /** null for leave with no balance (unpaid leave). */
  available: number | null;
  allowHalfDay: boolean; minNoticeDays: number; maxConsecutiveDays: number | null;
}
export interface MyRequest {
  id: string; status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED'; leaveType: string; dates: string;
  totalDays: number; paidDays: number; lopDays: number; note: string | null; canCancel: boolean;
}
export interface FormInfo {
  name: string; today: string; /** Expiry as a time on THIS device's clock. */ expiresAt: number;
  year: { label: string; startDate: string; endDate: string } | null;
  leaveTypes: LeaveTypeInfo[]; requests: MyRequest[];
}

export type LoadOutcome = { kind: 'open'; info: FormInfo } | { kind: 'closed'; state: ClosedState } | { kind: 'error' };

export interface Draft { leaveTypeId: string; startDate: string; endDate: string; dayMode: DayMode; reason: string }

export type PreviewOutcome =
  | { kind: 'ok'; totalDays: number; paidDays: number; lopDays: number }
  | { kind: 'refused'; message: string }
  | { kind: 'closed'; state: ClosedState }
  | { kind: 'error' };

export type SubmitOutcome =
  | { kind: 'sent'; dates: string; totalDays: number; paidDays: number; lopDays: number }
  | { kind: 'full'; message: string }
  | { kind: 'refused'; message: string }
  | { kind: 'closed'; state: ClosedState }
  | { kind: 'error' };

export type CancelOutcome = { kind: 'done' } | { kind: 'refused'; message: string } | { kind: 'closed'; state: ClosedState } | { kind: 'error' };

type Body = Record<string, unknown>;
export interface Reply { status: number; body: Body | null }

export async function call(path: string, init: RequestInit, timeoutMs: number): Promise<Reply | null> {
  try {
    const response = await fetch(path, { ...init, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(timeoutMs) });
    return { status: response.status, body: (await response.json().catch(() => null)) as Body | null };
  } catch {
    return null;
  }
}

export const post = (data: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
const url = (token: string, suffix = '') => `/api/leave-form/${encodeURIComponent(token)}${suffix}`;
const STATES: ClosedState[] = ['NOT_FOUND', 'EXPIRED', 'USED', 'UNAVAILABLE'];

/** Which "this link is closed" state does a reply describe, if any? */
export function closedStateOf(reply: Reply): ClosedState | null {
  const state = reply.body?.state;
  if (typeof state === 'string' && (STATES as string[]).includes(state)) return state as ClosedState;
  // A plain 404 {error} means the module is switched off.
  if (reply.status === 404) return reply.body && 'error' in reply.body ? 'UNAVAILABLE' : 'NOT_FOUND';
  return null;
}

const draftBody = (d: Draft) => ({
  leaveTypeId: Number(d.leaveTypeId), startDate: d.startDate, endDate: d.endDate || d.startDate, dayMode: d.dayMode, reason: d.reason,
});

export async function loadForm(token: string): Promise<LoadOutcome> {
  const reply = await call(url(token), { method: 'GET' }, 20_000);
  if (!reply) return { kind: 'error' };
  const closed = closedStateOf(reply);
  if (closed) return { kind: 'closed', state: closed };
  const b = reply.body;
  if (reply.status !== 200 || !b || b.ok !== true || typeof b.name !== 'string' || !Array.isArray(b.leaveTypes) || typeof b.expiresAt !== 'string') return { kind: 'error' };
  const serverNow = typeof b.serverTime === 'string' ? Date.parse(b.serverTime) : Date.now();
  return {
    kind: 'open',
    info: {
      name: b.name, today: String(b.today ?? ''), expiresAt: Date.now() + (Date.parse(b.expiresAt) - serverNow),
      year: (b.year as FormInfo['year']) ?? null, leaveTypes: b.leaveTypes as LeaveTypeInfo[], requests: (Array.isArray(b.requests) ? b.requests : []) as MyRequest[],
    },
  };
}

export async function previewDraft(token: string, draft: Draft): Promise<PreviewOutcome> {
  const reply = await call(url(token, '/preview'), post(draftBody(draft)), 15_000);
  if (!reply) return { kind: 'error' };
  const b = reply.body;
  if (b?.ok === true && typeof b.totalDays === 'number') return { kind: 'ok', totalDays: b.totalDays, paidDays: Number(b.paidDays ?? 0), lopDays: Number(b.lopDays ?? 0) };
  if (b?.state === 'REFUSED' && typeof b.message === 'string') return { kind: 'refused', message: b.message };
  const closed = closedStateOf(reply);
  return closed ? { kind: 'closed', state: closed } : { kind: 'error' };
}

export async function sendDraft(token: string, draft: Draft): Promise<SubmitOutcome> {
  const reply = await call(url(token, '/submit'), post(draftBody(draft)), 30_000);
  if (!reply) return { kind: 'error' };
  const b = reply.body;
  if (b?.ok === true && b.request && typeof b.request === 'object') {
    const r = b.request as Body;
    return { kind: 'sent', dates: String(r.dates ?? ''), totalDays: Number(r.totalDays ?? 0), paidDays: Number(r.paidDays ?? 0), lopDays: Number(r.lopDays ?? 0) };
  }
  if (b?.state === 'CAP_REACHED' && typeof b.message === 'string') return { kind: 'full', message: b.message };
  if (b?.state === 'REFUSED' && typeof b.message === 'string') return { kind: 'refused', message: b.message };
  const closed = closedStateOf(reply);
  return closed ? { kind: 'closed', state: closed } : { kind: 'error' };
}

export async function cancelRequest(token: string, requestId: string): Promise<CancelOutcome> {
  const reply = await call(url(token, '/cancel'), post({ requestId }), 20_000);
  if (!reply) return { kind: 'error' };
  const b = reply.body;
  if (b?.ok === true) return { kind: 'done' };
  if (b?.state === 'REFUSED' && typeof b.message === 'string') return { kind: 'refused', message: b.message };
  const closed = closedStateOf(reply);
  return closed ? { kind: 'closed', state: closed } : { kind: 'error' };
}
