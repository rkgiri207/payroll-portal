/**
 * Payroll Runs (History) routes:
 *   GET   /payroll-runs        — list runs
 *   GET   /payroll-runs/:id    — get run detail + records
 *   PATCH /payroll-runs/:id/cancel — cancel run
 */
import { Router, type IRouter, type Request, type Response } from 'express';
import { db } from '@workspace/db';
import {
  payrollRunsTable,
  payrollRecordsTable,
  employeesTable,
  usersTable,
} from '@workspace/db/schema';
import { eq, desc, count, and, ilike } from 'drizzle-orm';
import { requireAuth } from '../middlewares/requireAuth';
import { createAuditLog } from '../lib/audit';

const router: IRouter = Router();

// ─── List payroll runs ────────────────────────────────────────────────────────
router.get('/payroll-runs', requireAuth, async (req: Request, res: Response) => {
  const status = (req.query.status as string) || '';
  const page = Math.max(1, parseInt(String(req.query.page || '1'), 10));
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || '20'), 10)));
  const offset = (page - 1) * limit;

  // Build base query
  const whereConditions = [];
  if (status && ['DRAFT','VALIDATED','IMPORTED','CANCELLED'].includes(status)) {
    whereConditions.push(eq(payrollRunsTable.status, status as any));
  }
  const where = whereConditions.length > 0 ? and(...whereConditions) : undefined;

  const [runs, [{ total }]] = await Promise.all([
    db
      .select({
        id: payrollRunsTable.id,
        payrollMonth: payrollRunsTable.payrollMonth,
        payrollYear: payrollRunsTable.payrollYear,
        originalFileName: payrollRunsTable.originalFileName,
        fileStoragePath: payrollRunsTable.fileStoragePath,
        uploadedBy: payrollRunsTable.uploadedBy,
        uploadedByName: usersTable.name,
        uploadTimestamp: payrollRunsTable.uploadTimestamp,
        employeeCount: payrollRunsTable.employeeCount,
        totalGross: payrollRunsTable.totalGross,
        totalDeductions: payrollRunsTable.totalDeductions,
        totalNet: payrollRunsTable.totalNet,
        status: payrollRunsTable.status,
        createdAt: payrollRunsTable.createdAt,
        updatedAt: payrollRunsTable.updatedAt,
      })
      .from(payrollRunsTable)
      .leftJoin(usersTable, eq(payrollRunsTable.uploadedBy, usersTable.id))
      .where(where)
      .orderBy(desc(payrollRunsTable.payrollYear), desc(payrollRunsTable.payrollMonth), desc(payrollRunsTable.createdAt))
      .limit(limit)
      .offset(offset),
    db.select({ total: count() }).from(payrollRunsTable).where(where),
  ]);

  res.json({ runs, total: Number(total), page, limit });
});

// ─── Get payroll run detail ───────────────────────────────────────────────────
router.get('/payroll-runs/:id', requireAuth, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) {
    res.status(400).json({ error: 'Invalid payroll run ID' });
    return;
  }

  const [run] = await db
    .select({
      id: payrollRunsTable.id,
      payrollMonth: payrollRunsTable.payrollMonth,
      payrollYear: payrollRunsTable.payrollYear,
      originalFileName: payrollRunsTable.originalFileName,
      fileStoragePath: payrollRunsTable.fileStoragePath,
      uploadedBy: payrollRunsTable.uploadedBy,
      uploadedByName: usersTable.name,
      uploadTimestamp: payrollRunsTable.uploadTimestamp,
      employeeCount: payrollRunsTable.employeeCount,
      totalGross: payrollRunsTable.totalGross,
      totalDeductions: payrollRunsTable.totalDeductions,
      totalNet: payrollRunsTable.totalNet,
      status: payrollRunsTable.status,
      createdAt: payrollRunsTable.createdAt,
      updatedAt: payrollRunsTable.updatedAt,
    })
    .from(payrollRunsTable)
    .leftJoin(usersTable, eq(payrollRunsTable.uploadedBy, usersTable.id))
    .where(eq(payrollRunsTable.id, id));

  if (!run) {
    res.status(404).json({ error: 'Payroll run not found' });
    return;
  }

  // Fetch records with employee info
  const records = await db
    .select({
      id: payrollRecordsTable.id,
      payrollRunId: payrollRecordsTable.payrollRunId,
      employeeId: payrollRecordsTable.employeeId,
      employeeCode: employeesTable.employeeCode,
      employeeName: employeesTable.employeeName,
      basic: payrollRecordsTable.basic,
      da: payrollRecordsTable.da,
      hra: payrollRecordsTable.hra,
      otherEarnings: payrollRecordsTable.otherEarnings,
      grossSalary: payrollRecordsTable.grossSalary,
      pf: payrollRecordsTable.pf,
      esi: payrollRecordsTable.esi,
      tds: payrollRecordsTable.tds,
      otherDeductions: payrollRecordsTable.otherDeductions,
      netSalary: payrollRecordsTable.netSalary,
      additionalComponents: payrollRecordsTable.additionalComponents,
    })
    .from(payrollRecordsTable)
    .leftJoin(employeesTable, eq(payrollRecordsTable.employeeId, employeesTable.id))
    .where(eq(payrollRecordsTable.payrollRunId, id))
    .orderBy(employeesTable.employeeCode);

  res.json({ ...run, records });
});

// ─── Cancel payroll run ───────────────────────────────────────────────────────
router.patch('/payroll-runs/:id/cancel', requireAuth, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) {
    res.status(400).json({ error: 'Invalid payroll run ID' });
    return;
  }

  const [existing] = await db
    .select()
    .from(payrollRunsTable)
    .where(eq(payrollRunsTable.id, id));

  if (!existing) {
    res.status(404).json({ error: 'Payroll run not found' });
    return;
  }

  if (existing.status === 'CANCELLED') {
    res.status(400).json({ error: 'Payroll run is already cancelled' });
    return;
  }

  const [updated] = await db
    .update(payrollRunsTable)
    .set({ status: 'CANCELLED' })
    .where(eq(payrollRunsTable.id, id))
    .returning();

  await createAuditLog({
    action: 'PAYROLL_RUN_CANCELLED',
    entityType: 'payroll_run',
    entityId: id,
    performedBy: req.session.userId!,
    details: `Payroll run for ${MONTH_NAMES[existing.payrollMonth - 1]} ${existing.payrollYear} cancelled`,
  });

  res.json(updated);
});

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export default router;
