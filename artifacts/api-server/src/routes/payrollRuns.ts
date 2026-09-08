/**
 * Payroll Runs (History) routes:
 *   GET   /payroll-runs        — list runs
 *   GET   /payroll-runs/:id    — get run detail + records
 *   PATCH /payroll-runs/:id/cancel — cancel run
 *
 * NOTE: Records now store employee identity directly (no join to employees table).
 */
import { Router, type IRouter, type Request, type Response } from 'express';
import { db } from '@workspace/db';
import {
  payrollRunsTable,
  payrollRecordsTable,
  payslipSharesTable,
  usersTable,
} from '@workspace/db/schema';
import { eq, desc, count, and, inArray, sql } from 'drizzle-orm';
import { requireAuth } from '../middlewares/requireAuth';
import { createAuditLog } from '../lib/audit';
import { ObjectStorageService, STORAGE_BUCKETS } from '../lib/objectStorage';

const router: IRouter = Router();
const objectStorageService = new ObjectStorageService();

// ─── List payroll runs ────────────────────────────────────────────────────────
router.get('/payroll-runs', requireAuth, async (req: Request, res: Response) => {
  const status = (req.query.status as string) || '';
  const page = Math.max(1, parseInt(String(req.query.page || '1'), 10));
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || '20'), 10)));
  const offset = (page - 1) * limit;

  const whereConditions = [];
  if (status && ['DRAFT', 'VALIDATED', 'IMPORTED', 'CANCELLED'].includes(status)) {
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
      .orderBy(desc(payrollRunsTable.uploadTimestamp), desc(payrollRunsTable.id))
      .limit(limit)
      .offset(offset),
    db.select({ total: count() }).from(payrollRunsTable).where(where),
  ]);

  const branchRows = runs.length > 0
    ? await db
        .select({
          payrollRunId: payrollRecordsTable.payrollRunId,
          branch: payrollRecordsTable.branch,
        })
        .from(payrollRecordsTable)
        .where(inArray(payrollRecordsTable.payrollRunId, runs.map(run => run.id)))
    : [];
  const branchesByRun = new Map<number, Set<string>>();
  for (const row of branchRows) {
    const branch = row.branch?.trim();
    if (!branch) continue;
    const branches = branchesByRun.get(row.payrollRunId) ?? new Set<string>();
    branches.add(branch);
    branchesByRun.set(row.payrollRunId, branches);
  }

  res.json({
    runs: runs.map(run => ({
      ...run,
      branchNames: [...(branchesByRun.get(run.id) ?? [])].sort((a, b) => a.localeCompare(b)),
    })),
    total: Number(total),
    page,
    limit,
  });
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

  // Fetch records — employee info is stored directly on each record
  const records = await db
    .select({
      id: payrollRecordsTable.id,
      payrollRunId: payrollRecordsTable.payrollRunId,
      employeeCode: payrollRecordsTable.employeeCode,
      employeeName: payrollRecordsTable.employeeName,
      mobileNumber: payrollRecordsTable.mobileNumber,
      email: payrollRecordsTable.email,
      designation: payrollRecordsTable.designation,
      branch: payrollRecordsTable.branch,
      basic: payrollRecordsTable.basic,
      da: payrollRecordsTable.da,
      hra: payrollRecordsTable.hra,
      otherEarnings: payrollRecordsTable.otherEarnings,
      grossSalary: payrollRecordsTable.grossSalary,
      pfEmployee: payrollRecordsTable.pfEmployee,
      pfEmployer: payrollRecordsTable.pfEmployer,
      esiEmployee: payrollRecordsTable.esiEmployee,
      esiEmployer: payrollRecordsTable.esiEmployer,
      pt: payrollRecordsTable.pt,
      lop: payrollRecordsTable.lop,
      otherDeductions: payrollRecordsTable.otherDeductions,
      netSalary: payrollRecordsTable.netSalary,
      additionalComponents: payrollRecordsTable.additionalComponents,
    })
    .from(payrollRecordsTable)
    .where(eq(payrollRecordsTable.payrollRunId, id))
    .orderBy(payrollRecordsTable.employeeCode);

  res.json({ ...run, records });
});

router.delete('/payroll-runs/:runId/records/:recordId', requireAuth, async (req: Request, res: Response) => {
  const runId = Number(req.params.runId);
  const recordId = Number(req.params.recordId);
  if (!Number.isSafeInteger(runId) || !Number.isSafeInteger(recordId) || runId < 1 || recordId < 1) {
    res.status(400).json({ error: 'Invalid payroll run or record ID' });
    return;
  }

  const [record] = await db.select().from(payrollRecordsTable)
    .where(and(eq(payrollRecordsTable.id, recordId), eq(payrollRecordsTable.payrollRunId, runId)));
  if (!record) {
    res.status(404).json({ error: 'Payslip record not found' });
    return;
  }

  const [share] = await db.select({ storagePath: payslipSharesTable.storagePath })
    .from(payslipSharesTable).where(eq(payslipSharesTable.payrollRecordId, recordId));
  if (share) {
    try {
      await objectStorageService.deleteObject(share.storagePath, STORAGE_BUCKETS.payslips);
    } catch (error) {
      if (!(error instanceof Error && error.message.includes('(404)'))) {
        req.log.error({ err: error, recordId }, 'Failed to remove shared payslip before record deletion');
        res.status(502).json({ error: 'Could not remove the stored payslip. The record was not deleted.' });
        return;
      }
    }
  }

  await db.transaction(async tx => {
    await tx.delete(payrollRecordsTable).where(eq(payrollRecordsTable.id, recordId));
    const [totals] = await tx.select({
      employeeCount: count(),
      totalGross: sql<string>`coalesce(sum(${payrollRecordsTable.grossSalary}), 0)`,
      totalDeductions: sql<string>`coalesce(sum(
        coalesce(${payrollRecordsTable.pfEmployee}, 0) + coalesce(${payrollRecordsTable.pfEmployer}, 0) +
        coalesce(${payrollRecordsTable.esiEmployee}, 0) + coalesce(${payrollRecordsTable.esiEmployer}, 0) +
        coalesce(${payrollRecordsTable.pt}, 0) + coalesce(${payrollRecordsTable.lop}, 0) +
        coalesce(${payrollRecordsTable.otherDeductions}, 0)
      ), 0)`,
      totalNet: sql<string>`coalesce(sum(${payrollRecordsTable.netSalary}), 0)`,
    }).from(payrollRecordsTable).where(eq(payrollRecordsTable.payrollRunId, runId));
    await tx.update(payrollRunsTable).set({
      employeeCount: Number(totals.employeeCount),
      totalGross: totals.totalGross,
      totalDeductions: totals.totalDeductions,
      totalNet: totals.totalNet,
    }).where(eq(payrollRunsTable.id, runId));
  });

  await createAuditLog({
    action: 'PAYSLIP_RECORD_DELETED', entityType: 'payroll_record', entityId: recordId,
    performedBy: req.session.userId!, details: `Deleted payslip record for ${record.employeeCode}`,
  });
  res.json({ success: true });
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
