import { Router, type IRouter } from "express";
import { desc, eq } from "drizzle-orm";
import { db, auditLogsTable, usersTable } from "@workspace/db";
import { GetAuditLogsQueryParams } from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";

const router: IRouter = Router();

router.get("/audit-logs", requireAuth, async (req, res): Promise<void> => {
  const parsed = GetAuditLogsQueryParams.safeParse(req.query);
  const limit = parsed.success ? parsed.data.limit : 20;

  const logs = await db
    .select({
      id: auditLogsTable.id,
      action: auditLogsTable.action,
      entityType: auditLogsTable.entityType,
      entityId: auditLogsTable.entityId,
      performedBy: auditLogsTable.performedBy,
      details: auditLogsTable.details,
      performedAt: auditLogsTable.performedAt,
    })
    .from(auditLogsTable)
    .orderBy(desc(auditLogsTable.performedAt))
    .limit(limit);

  // Enrich with performer names where available
  const performerIds = [...new Set(logs.map((l) => l.performedBy).filter((id): id is number => id !== null))];
  
  let performerMap = new Map<number, string>();
  if (performerIds.length > 0) {
    const performers = await db
      .select({ id: usersTable.id, name: usersTable.name })
      .from(usersTable);
    performerMap = new Map(performers.map((p) => [p.id, p.name]));
  }

  const result = logs.map((log) => ({
    id: log.id,
    action: log.action,
    entityType: log.entityType ?? null,
    entityId: log.entityId ?? null,
    performedBy: log.performedBy ?? null,
    performedByName: log.performedBy ? (performerMap.get(log.performedBy) ?? null) : null,
    details: log.details ?? null,
    performedAt: log.performedAt.toISOString(),
  }));

  res.json(result);
});

export default router;
