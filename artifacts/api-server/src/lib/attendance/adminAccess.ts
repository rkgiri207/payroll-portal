import type { Queryable } from './db';

export type AttendanceRole = 'DIRECTOR' | 'ADMIN';

/**
 * Who a signed-in portal user is for attendance. An explicit row in attendance_roles wins.
 * Without one, an existing active ADMIN login is treated as the DIRECTOR (the portal has a
 * single ADMIN role today). A user who is inactive or unknown gets no access.
 */
export async function resolveRole(q: Queryable, userId: number): Promise<AttendanceRole | null> {
  const { rows } = await q.query<{ attendance_role: AttendanceRole | null; user_role: string; is_active: boolean }>(
    `select ar.role as attendance_role, u.role::text as user_role, u.is_active
       from users u left join attendance_roles ar on ar.user_id = u.id
      where u.id = $1`,
    [userId],
  );
  const row = rows[0];
  if (!row || !row.is_active) return null;
  if (row.attendance_role) return row.attendance_role;
  return row.user_role === 'ADMIN' ? 'DIRECTOR' : null;
}

/** Settings that only the Director may change (alerts and who receives them). */
export const DIRECTOR_ONLY_SETTINGS: ReadonlySet<string> = new Set([
  'director_whatsapp_e164', 'alert_mode', 'digest_interval_minutes',
  'leave_cap_per_campus_per_day',
]);

export function canEditSetting(role: AttendanceRole, key: string): boolean {
  return role === 'DIRECTOR' || !DIRECTOR_ONLY_SETTINGS.has(key);
}

/** PostgreSQL error codes we turn into friendly messages. */
export const PG_UNIQUE_VIOLATION = '23505';
export const PG_FOREIGN_KEY_VIOLATION = '23503';

export function pgCode(error: unknown): string | null {
  return typeof error === 'object' && error !== null && 'code' in error && typeof (error as { code: unknown }).code === 'string'
    ? (error as { code: string }).code
    : null;
}
