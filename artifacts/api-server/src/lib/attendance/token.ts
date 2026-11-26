import { createHash, randomBytes } from 'node:crypto';

/** 32 cryptographically secure random bytes, URL-safe (43 characters). */
export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Only this hash is stored in the database; the token itself exists only in the link. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function isTokenShape(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
}
