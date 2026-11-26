/**
 * Calls the public, token-protected attendance endpoints. The one-time token in the link is the
 * only credential; no cookies are sent and nothing is stored in the browser. The token,
 * coordinates and image are never logged.
 */

export type ClosedState = 'NOT_FOUND' | 'EXPIRED' | 'USED' | 'LOCKED' | 'UNAVAILABLE';

export interface LinkInfo {
  type: 'IN' | 'OUT';
  campusName: string;
  /** Expiry as a time on THIS device's clock (derived from the server's clock). */
  expiresAt: number;
  locationVerified: boolean;
  attemptsLeft: number;
  requiredAccuracyM: number;
}

export type LoadOutcome =
  | { kind: 'open'; info: LinkInfo }
  | { kind: 'closed'; state: ClosedState }
  | { kind: 'error' };

export type LocationFailure =
  | 'OUTSIDE_RADIUS' | 'POOR_ACCURACY' | 'NO_LOCATION' | 'CAMPUS_NOT_ALLOWED' | 'CAMPUS_NOT_CONFIGURED';

export type LocationOutcome =
  | { kind: 'passed' }
  | { kind: 'failed'; result: LocationFailure; locked: boolean; attemptsLeft: number | null }
  | { kind: 'closed'; state: ClosedState }
  | { kind: 'error' };

export interface Confirmation {
  type: 'IN' | 'OUT';
  campusName: string;
  time: string;
  date: string;
  punctuality: string;
  lateMinutes: number | null;
  duplicate: boolean;
}

export type SelfieOutcome =
  | { kind: 'done'; confirmation: Confirmation }
  | { kind: 'already' }
  | { kind: 'needLocation' }
  | { kind: 'badImage' }
  | { kind: 'closed'; state: ClosedState }
  | { kind: 'error' };

const RESULTS: LocationFailure[] = [
  'OUTSIDE_RADIUS', 'POOR_ACCURACY', 'NO_LOCATION', 'CAMPUS_NOT_ALLOWED', 'CAMPUS_NOT_CONFIGURED',
];
const STATES: ClosedState[] = ['NOT_FOUND', 'EXPIRED', 'USED', 'LOCKED', 'UNAVAILABLE'];

type Body = Record<string, unknown>;
interface Reply { status: number; body: Body | null }

async function call(path: string, init: RequestInit, timeoutMs: number): Promise<Reply | null> {
  try {
    const response = await fetch(path, {
      ...init,
      cache: 'no-store',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = (await response.json().catch(() => null)) as Body | null;
    return { status: response.status, body };
  } catch {
    return null; // network problem or timeout
  }
}

const post = (data: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(data),
});

/** Which "this link is closed" state does a reply describe, if any? */
export function closedStateOf(reply: Reply): ClosedState | null {
  const state = reply.body?.state;
  if (typeof state === 'string' && (STATES as string[]).includes(state)) return state as ClosedState;
  // The server answers a plain 404 {error} when the attendance module is switched off.
  if (reply.status === 404) return reply.body && 'error' in reply.body ? 'UNAVAILABLE' : 'NOT_FOUND';
  return null;
}

const url = (token: string, suffix = '') => `/api/attendance/link/${encodeURIComponent(token)}${suffix}`;

export async function loadLink(token: string): Promise<LoadOutcome> {
  const reply = await call(url(token), { method: 'GET' }, 20_000);
  if (!reply) return { kind: 'error' };
  const closed = closedStateOf(reply);
  if (closed) return { kind: 'closed', state: closed };
  const b = reply.body;
  if (
    reply.status === 200 && b && (b.type === 'IN' || b.type === 'OUT') && typeof b.campusName === 'string' &&
    typeof b.expiresAt === 'string' && typeof b.requiredAccuracyM === 'number'
  ) {
    // Count down against the server's clock: expiry as "milliseconds from now" on this device.
    const serverNow = typeof b.serverTime === 'string' ? Date.parse(b.serverTime) : Date.now();
    const expiresAt = Date.now() + (Date.parse(b.expiresAt) - serverNow);
    return {
      kind: 'open',
      info: {
        type: b.type, campusName: b.campusName, expiresAt,
        locationVerified: b.locationVerified === true,
        attemptsLeft: typeof b.attemptsLeft === 'number' ? b.attemptsLeft : 0,
        requiredAccuracyM: b.requiredAccuracyM,
      },
    };
  }
  return { kind: 'error' };
}

export interface Position { lat: number | null; lng: number | null; accuracyM: number | null }

export async function sendLocation(token: string, position: Position): Promise<LocationOutcome> {
  const reply = await call(url(token, '/location'), post(position), 20_000);
  if (!reply) return { kind: 'error' };
  const b = reply.body;
  if (reply.status === 200 && b?.result === 'PASSED') return { kind: 'passed' };
  const result = b?.result;
  if (typeof result === 'string' && (RESULTS as string[]).includes(result)) {
    return {
      kind: 'failed', result: result as LocationFailure, locked: b?.locked === true,
      attemptsLeft: typeof b?.attemptsLeft === 'number' ? b.attemptsLeft : null,
    };
  }
  const closed = closedStateOf(reply);
  return closed ? { kind: 'closed', state: closed } : { kind: 'error' };
}

export async function sendSelfie(token: string, image: string): Promise<SelfieOutcome> {
  const reply = await call(url(token, '/selfie'), post({ image }), 45_000);
  if (!reply) return { kind: 'error' };
  const b = reply.body;
  if (reply.status === 200 && b?.ok === true && (b.type === 'IN' || b.type === 'OUT')) {
    return {
      kind: 'done',
      confirmation: {
        type: b.type, campusName: String(b.campusName ?? ''), time: String(b.time ?? ''), date: String(b.date ?? ''),
        punctuality: String(b.punctuality ?? ''), lateMinutes: typeof b.lateMinutes === 'number' ? b.lateMinutes : null,
        duplicate: b.duplicate === true,
      },
    };
  }
  if (b?.state === 'ALREADY_MARKED') return { kind: 'already' };
  if (b?.state === 'LOCATION_REQUIRED') return { kind: 'needLocation' };
  if (b?.state === 'INVALID_IMAGE') return { kind: 'badImage' };
  const closed = closedStateOf(reply);
  return closed ? { kind: 'closed', state: closed } : { kind: 'error' };
}
