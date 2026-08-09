import { Router, type IRouter } from "express";
import { desc } from "drizzle-orm";
import { db, auditLogsTable, usersTable } from "@workspace/db";
import { requireAuth } from "../middlewares/requireAuth";
import { eq } from "drizzle-orm";

const router: IRouter = Router();

router.get("/dashboard/stats", requireAuth, async (req, res): Promise<void> => {
  // Stage 1: employee/payroll/payslip counts are all 0 — modules not yet built
  const totalEmployees = 0;
  const payrollRuns = 0;
  const payslipsGenerated = 0;

  // Recent activity from audit logs
  const recentLogs = await db
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
    .limit(10);

  // Fetch performer names
  const performerIds = recentLogs
    .map((l) => l.performedBy)
    .filter((id): id is number => id !== null);

  const performers = performerIds.length
    ? await db
        .select({ id: usersTable.id, name: usersTable.name })
        .from(usersTable)
        .where(
          eq(usersTable.id, performerIds[0]) // simplified for stage 1
        )
    : [];

  const performerMap = new Map(performers.map((p) => [p.id, p.name]));

  const recentActivity = recentLogs.map((log) => ({
    id: log.id,
    action: log.action,
    entityType: log.entityType ?? null,
    entityId: log.entityId ?? null,
    performedBy: log.performedBy ?? null,
    performedByName: log.performedBy ? (performerMap.get(log.performedBy) ?? null) : null,
    details: log.details ?? null,
    performedAt: log.performedAt.toISOString(),
  }));

  res.json({
    totalEmployees,
    payrollRuns,
    payslipsGenerated,
    recentActivity,
  });
});

export default router;
