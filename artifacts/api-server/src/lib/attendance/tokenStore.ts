import type { Queryable } from './db';
import { generateToken, hashToken } from './token';

export type EventType = 'IN' | 'OUT';

export interface CreatedToken {
  id: string;
  /** The raw token. It exists only here and in the link sent to the employee; never stored or logged. */
  token: string;
  expiresAt: Date;
}

/**
 * Issue a one-time link token. Only its SHA-256 hash is stored. Any earlier unused link for
 * the same employee, type and day is expired, so only the newest link works. Returns null if
 * the same WhatsApp message already produced a token (duplicate delivery).
 */
export async function createToken(
  q: Queryable,
  input: {
    employeeId: number;
    campusId: number;
    eventType: EventType;
    workDate: string;
    ttlMinutes: number;
    sourceMessageId?: string | null;
  },
): Promise<CreatedToken | null> {
  const token = generateToken();
  const inserted = await q.query<{ id: string; expires_at: Date }>(
    `insert into attendance_tokens
       (token_hash, employee_id, campus_id, event_type, work_date, expires_at, source_message_id)
     values ($1, $2, $3, $4, $5::date, now() + make_interval(mins => $6::int), $7)
     on conflict do nothing
     returning id, expires_at`,
    [
      hashToken(token), input.employeeId, input.campusId, input.eventType,
      input.workDate, input.ttlMinutes, input.sourceMessageId ?? null,
    ],
  );
  const row = inserted.rows[0];
  if (!row) return null;

  await q.query(
    `update attendance_tokens set expires_at = now()
      where employee_id = $1 and event_type = $2 and work_date = $3::date
        and id <> $4 and used_at is null and locked_at is null and expires_at > now()`,
    [input.employeeId, input.eventType, input.workDate, row.id],
  );
  return { id: row.id, token, expiresAt: row.expires_at };
}

export interface TokenRecord {
  id: string;
  employeeId: number;
  campusId: number;
  eventType: EventType;
  workDate: string;
  expiresAt: Date;
  locationVerifiedAt: Date | null;
  usedAt: Date | null;
  failedAttempts: number;
  lockedAt: Date | null;
}

export async function getTokenByHash(q: Queryable, tokenHash: string): Promise<TokenRecord | null> {
  const { rows } = await q.query<{
    id: string; employee_id: number; campus_id: number; event_type: EventType; work_date: string;
    expires_at: Date; location_verified_at: Date | null; used_at: Date | null;
    failed_attempts: number; locked_at: Date | null;
  }>(
    `select id, employee_id, campus_id, event_type, work_date::text as work_date, expires_at,
            location_verified_at, used_at, failed_attempts, locked_at
       from attendance_tokens where token_hash = $1`,
    [tokenHash],
  );
  const r = rows[0];
  return r
    ? {
        id: r.id, employeeId: r.employee_id, campusId: r.campus_id, eventType: r.event_type,
        workDate: r.work_date, expiresAt: r.expires_at, locationVerifiedAt: r.location_verified_at,
        usedAt: r.used_at, failedAttempts: r.failed_attempts, lockedAt: r.locked_at,
      }
    : null;
}

export type TokenState = 'OK' | 'NOT_FOUND' | 'EXPIRED' | 'USED' | 'LOCKED';

/** Decide whether a token can still be used. Order matters: used, locked, then expired. */
export function tokenState(record: TokenRecord | null, now: Date = new Date()): TokenState {
  if (!record) return 'NOT_FOUND';
  if (record.usedAt) return 'USED';
  if (record.lockedAt) return 'LOCKED';
  if (record.expiresAt.getTime() <= now.getTime()) return 'EXPIRED';
  return 'OK';
}

export interface AttemptInput {
  tokenId: string;
  employeeId: number;
  campusId: number;
  lat: number | null;
  lng: number | null;
  accuracyM: number | null;
  distanceM: number | null;
  result:
    | 'PASSED' | 'OUTSIDE_RADIUS' | 'POOR_ACCURACY' | 'NO_LOCATION' | 'TOKEN_LOCKED'
    | 'TOKEN_EXPIRED' | 'TOKEN_USED' | 'CAMPUS_NOT_ALLOWED' | 'ERROR';
  reason?: string | null;
  userAgent?: string | null;
}

/** Log one attempt with the reported coordinates and accuracy (audit requirement). */
export async function recordAttempt(q: Queryable, a: AttemptInput): Promise<void> {
  await q.query(
    `insert into attendance_attempts
       (token_id, employee_id, campus_id, reported_lat, reported_lng, accuracy_m, distance_m, result, reason, user_agent)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      a.tokenId, a.employeeId, a.campusId, a.lat, a.lng, a.accuracyM, a.distanceM,
      a.result, a.reason ?? null, a.userAgent ? a.userAgent.slice(0, 300) : null,
    ],
  );
}

export interface VerifiedLocation {
  lat: number;
  lng: number;
  accuracyM: number;
  distanceM: number;
}

/** The location that passed for this token (GPS is captured once, at the location step). */
export async function getVerifiedLocation(q: Queryable, tokenId: string): Promise<VerifiedLocation | null> {
  const { rows } = await q.query<{
    reported_lat: number | null; reported_lng: number | null; accuracy_m: number | null; distance_m: number | null;
  }>(
    `select reported_lat::float8 as reported_lat, reported_lng::float8 as reported_lng,
            accuracy_m::float8 as accuracy_m, distance_m::float8 as distance_m
       from attendance_attempts
      where token_id = $1 and result = 'PASSED'
      order by attempted_at desc limit 1`,
    [tokenId],
  );
  const r = rows[0];
  if (!r || r.reported_lat === null || r.reported_lng === null || r.accuracy_m === null || r.distance_m === null) {
    return null;
  }
  return { lat: r.reported_lat, lng: r.reported_lng, accuracyM: r.accuracy_m, distanceM: r.distance_m };
}

/**
 * Count one failed attempt, atomically. When the count reaches the limit the token is locked.
 * Returns null if the token is no longer open (already used or locked).
 */
export async function registerFailedAttempt(
  q: Queryable,
  tokenId: string,
  maxAttempts: number,
): Promise<{ failedAttempts: number; locked: boolean } | null> {
  const { rows } = await q.query<{ failed_attempts: number; locked_at: Date | null }>(
    `update attendance_tokens
        set failed_attempts = failed_attempts + 1,
            locked_at = case when failed_attempts + 1 >= $2 then now() else locked_at end
      where id = $1 and used_at is null and locked_at is null
      returning failed_attempts, locked_at`,
    [tokenId, maxAttempts],
  );
  const r = rows[0];
  return r ? { failedAttempts: r.failed_attempts, locked: r.locked_at !== null } : null;
}

/** Mark that step 1 (location) passed. False if the token is no longer open. */
export async function markLocationVerified(q: Queryable, tokenId: string): Promise<boolean> {
  const { rowCount } = await q.query(
    `update attendance_tokens set location_verified_at = now()
      where id = $1 and used_at is null and locked_at is null and expires_at > now()`,
    [tokenId],
  );
  return (rowCount ?? 0) === 1;
}

/**
 * Use the token up (single use). Succeeds for exactly one caller even under concurrent
 * requests: the row update takes a lock, so a second request sees used_at already set.
 * Requires that the location step passed.
 */
export async function consumeToken(q: Queryable, tokenId: string): Promise<boolean> {
  const { rowCount } = await q.query(
    `update attendance_tokens set used_at = now()
      where id = $1 and used_at is null and locked_at is null
        and expires_at > now() and location_verified_at is not null`,
    [tokenId],
  );
  return (rowCount ?? 0) === 1;
}
