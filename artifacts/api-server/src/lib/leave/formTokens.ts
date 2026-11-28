import type { Queryable } from '../attendance/db';
import { generateToken, hashToken, isTokenShape } from '../attendance/token';

/**
 * One-time links to the leave form (and later the permission form). Same security design as the
 * attendance links: the token is 32 random bytes, only its hash is stored, it expires after a
 * short time, and it belongs to exactly one employee. The token is never logged.
 *
 * A link is "used" only when a request was ACCEPTED, so an employee whose first try was refused
 * (for example a date mix-up) can correct it and try again with the same link.
 */

export type FormPurpose = 'LEAVE' | 'PERMISSION';

export interface FormToken { id: string; employeeId: number; purpose: FormPurpose; expiresAt: Date; usedAt: Date | null }
export type FormTokenState = 'OPEN' | 'USED' | 'EXPIRED' | 'NOT_FOUND';

export async function createFormToken(
  q: Queryable,
  input: { employeeId: number; purpose: FormPurpose; ttlMinutes: number; sourceMessageId: string | null; now: Date },
): Promise<{ id: string; token: string; expiresAt: Date } | null> {
  const token = generateToken();
  const { rows } = await q.query<{ id: string; expires_at: Date }>(
    `insert into form_tokens (token_hash, employee_id, purpose, expires_at, source_message_id)
     values ($1, $2, $3, $4::timestamptz + ($5 || ' minutes')::interval, $6)
     on conflict do nothing
     returning id, expires_at`,
    [hashToken(token), input.employeeId, input.purpose, input.now.toISOString(), String(input.ttlMinutes), input.sourceMessageId],
  );
  // No row means this WhatsApp message already produced a link (a duplicate delivery).
  return rows[0] ? { id: rows[0].id, token, expiresAt: rows[0].expires_at } : null;
}

export async function lookupFormToken(
  q: Queryable, token: unknown, purpose: FormPurpose, now: Date,
): Promise<{ state: FormTokenState; record: FormToken | null }> {
  if (!isTokenShape(token)) return { state: 'NOT_FOUND', record: null };
  const { rows } = await q.query<{ id: string; employee_id: number; purpose: FormPurpose; expires_at: Date; used_at: Date | null }>(
    'select id, employee_id, purpose, expires_at, used_at from form_tokens where token_hash = $1',
    [hashToken(token)],
  );
  const r = rows[0];
  if (!r || r.purpose !== purpose) return { state: 'NOT_FOUND', record: null };
  const record: FormToken = { id: r.id, employeeId: r.employee_id, purpose: r.purpose, expiresAt: new Date(r.expires_at), usedAt: r.used_at ? new Date(r.used_at) : null };
  if (record.expiresAt.getTime() <= now.getTime()) return { state: 'EXPIRED', record };
  if (record.usedAt) return { state: 'USED', record };
  return { state: 'OPEN', record };
}

/** Mark the link used. Returns false if it was already used (so only one request can win). */
export async function markFormTokenUsed(q: Queryable, id: string): Promise<boolean> {
  const { rows } = await q.query<{ id: string }>('update form_tokens set used_at = now() where id = $1 and used_at is null returning id', [id]);
  return rows.length > 0;
}
