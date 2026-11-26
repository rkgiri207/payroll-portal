import type { Queryable } from './db';

export interface AuditEntry {
  actorType: 'USER' | 'EMPLOYEE' | 'SYSTEM' | 'WEBHOOK';
  actorUserId?: number | null;
  actorEmployeeId?: number | null;
  /** e.g. SELFIE_VIEWED, SETTING_CHANGED, CAMPUS_UPDATED, EXCEPTION_REVIEWED */
  action: string;
  entityType?: string | null;
  entityId?: string | null;
  oldValue?: unknown;
  newValue?: unknown;
  reason?: string | null;
}

/** Append one entry to the attendance audit log (the table is append-only in the database). */
export async function writeAudit(q: Queryable, e: AuditEntry): Promise<void> {
  await q.query(
    `insert into attendance_audit_log
       (actor_type, actor_user_id, actor_employee_id, action, entity_type, entity_id, old_value, new_value, reason)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9)`,
    [
      e.actorType, e.actorUserId ?? null, e.actorEmployeeId ?? null, e.action,
      e.entityType ?? null, e.entityId ?? null,
      e.oldValue === undefined ? null : JSON.stringify(e.oldValue),
      e.newValue === undefined ? null : JSON.stringify(e.newValue),
      e.reason ?? null,
    ],
  );
}
