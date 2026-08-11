import { Router, type IRouter, type Request, type Response } from 'express';
import { db } from '@workspace/db';
import {
  auditLogsTable,
  usersTable,
  employeesTable,
  payrollRunsTable,
  payslipGenerationsTable,
} from '@workspace/db/schema';
import { desc, count, eq } from 'drizzle-orm';
import { requireAuth } from '../middlewares/requireAuth';

const router: IRouter = Router();

router.get('/dashboard/stats', requireAuth, async (req: Request, res: Response) => {
  const [
    [{ totalEmployees }],
    [{ payrollRuns }],
    [{ payslipsGenerated }],
    recentLogs,
  ] = await Promise.all([
    db.select({ totalEmployees: count() }).from(employeesTable).where(eq(employeesTable.status, 'ACTIVE')),
    db.select({ payrollRuns: count() }).from(payrollRunsTable).where(eq(payrollRunsTable.status, 'IMPORTED')),
    db
      .select({ payslipsGenerated: count() })
      .from(payslipGenerationsTable)
      .where(eq(payslipGenerationsTable.status, 'GENERATED')),
    db
      .select({
        id: auditLogsTable.id,
        action: auditLogsTable.action,
        entityType: auditLogsTable.entityType,
        entityId: auditLogsTable.entityId,
        performedBy: auditLogsTable.performedBy,
        performedByName: usersTable.name,
        details: auditLogsTable.details,
        performedAt: auditLogsTable.performedAt,
      })
      .from(auditLogsTable)
      .leftJoin(usersTable, eq(auditLogsTable.performedBy, usersTable.id))
      .orderBy(desc(auditLogsTable.performedAt))
      .limit(10),
  ]);

  res.json({
    totalEmployees: Number(totalEmployees),
    payrollRuns: Number(payrollRuns),
    payslipsGenerated: Number(payslipsGenerated),
    recentActivity: recentLogs,
  });
});

export default router;
