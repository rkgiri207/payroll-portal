import { db, auditLogsTable } from "@workspace/db";
import { logger } from "./logger";

interface AuditLogEntry {
  action: string;
  entityType?: string;
  entityId?: number;
  performedBy?: number;
  details?: string;
}

export async function createAuditLog(entry: AuditLogEntry): Promise<void> {
  try {
    await db.insert(auditLogsTable).values({
      action: entry.action,
      entityType: entry.entityType ?? null,
      entityId: entry.entityId ?? null,
      performedBy: entry.performedBy ?? null,
      details: entry.details ?? null,
    });
  } catch (err) {
    logger.error({ err, entry }, "Failed to create audit log");
  }
}
