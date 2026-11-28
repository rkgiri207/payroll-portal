import { call, closedStateOf, post, type ClosedState } from '../leave-form/api';

/**
 * Calls the public permission-form endpoints. The one-time link token is the only credential: no
 * cookies are sent and nothing is stored in the browser. The token is never logged.
 */
export type { ClosedState };

export interface MyPermission {
  id: string; status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED'; date: string; from: string; to: string; note: string | null; canCancel: boolean;
}
export interface PermissionInfo {
  name: string; today: string; /** Expiry as a time on THIS device's clock. */ expiresAt: number;
  year: { label: string } | null;
  limits: { maxMinutes: number | null; maxPerMonth: number | null; usedThisMonth: number };
  requests: MyPermission[];
}
export type LoadOutcome = { kind: 'open'; info: PermissionInfo } | { kind: 'closed'; state: ClosedState } | { kind: 'error' };

export interface Draft { date: string; startTime: string; endTime: string; reason: string }

export type PreviewOutcome =
  | { kind: 'ok'; minutes: number }
  | { kind: 'refused'; message: string }
  | { kind: 'closed'; state: ClosedState }
  | { kind: 'error' };
export type SubmitOutcome =
  | { kind: 'sent'; date: string; from: string; to: string }
  | { kind: 'refused'; message: string }
  | { kind: 'closed'; state: ClosedState }
  | { kind: 'error' };
export type CancelOutcome = { kind: 'done' } | { kind: 'refused'; message: string } | { kind: 'closed'; state: ClosedState } | { kind: 'error' };

const url = (token: string, suffix = '') => `/api/permission-form/${encodeURIComponent(token)}${suffix}`;
const body = (d: Draft) => ({ date: d.date, startTime: d.startTime, endTime: d.endTime, reason: d.reason });

export async function loadForm(token: string): Promise<LoadOutcome> {
  const reply = await call(url(token), { method: 'GET' }, 20_000);
  if (!reply) return { kind: 'error' };
  const closed = closedStateOf(reply);
  if (closed) return { kind: 'closed', state: closed };
  const b = reply.body;
  if (reply.status !== 200 || !b || b.ok !== true || typeof b.name !== 'string' || typeof b.expiresAt !== 'string' || !b.limits) return { kind: 'error' };
  const serverNow = typeof b.serverTime === 'string' ? Date.parse(b.serverTime) : Date.now();
  return {
    kind: 'open',
    info: {
      name: b.name, today: String(b.today ?? ''), expiresAt: Date.now() + (Date.parse(b.expiresAt) - serverNow),
      year: (b.year as PermissionInfo['year']) ?? null, limits: b.limits as PermissionInfo['limits'],
      requests: (Array.isArray(b.requests) ? b.requests : []) as MyPermission[],
    },
  };
}

export async function previewDraft(token: string, draft: Draft): Promise<PreviewOutcome> {
  const reply = await call(url(token, '/preview'), post(body(draft)), 15_000);
  if (!reply) return { kind: 'error' };
  const b = reply.body;
  if (b?.ok === true && typeof b.minutes === 'number') return { kind: 'ok', minutes: b.minutes };
  if (b?.state === 'REFUSED' && typeof b.message === 'string') return { kind: 'refused', message: b.message };
  const closed = closedStateOf(reply);
  return closed ? { kind: 'closed', state: closed } : { kind: 'error' };
}

export async function sendDraft(token: string, draft: Draft): Promise<SubmitOutcome> {
  const reply = await call(url(token, '/submit'), post(body(draft)), 30_000);
  if (!reply) return { kind: 'error' };
  const b = reply.body;
  if (b?.ok === true && b.request && typeof b.request === 'object') {
    const r = b.request as Record<string, unknown>;
    return { kind: 'sent', date: String(r.date ?? ''), from: String(r.from ?? ''), to: String(r.to ?? '') };
  }
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
