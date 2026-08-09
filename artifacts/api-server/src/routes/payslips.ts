/**
 * Payslip generation status routes:
 *   GET  /payroll-runs/:id/payslip-statuses          — list generation status for all records
 *   PATCH /payroll-runs/:id/payslip-statuses          — bulk-upsert generation statuses
 *   GET  /company-settings/logo                       — proxy company logo from object storage
 */
import { Router, type IRouter, type Request, type Response } from 'express';
import { db } from '@workspace/db';
import {
  payrollRecordsTable,
  payrollRunsTable,
  payslipGenerationsTable,
} from '@workspace/db/schema';
import { eq, inArray } from 'drizzle-orm';
import { requireAuth } from '../middlewares/requireAuth';
import { ObjectStorageService } from '../lib/objectStorage';

const router: IRouter = Router();
const objectStorageService = new ObjectStorageService();

// ─── GET /payroll-runs/:id/payslip-statuses ───────────────────────────────────
router.get('/payroll-runs/:id/payslip-statuses', requireAuth, async (req: Request, res: Response) => {
  const runId = parseInt(String(req.params.id), 10);
  if (isNaN(runId)) {
    res.status(400).json({ error: 'Invalid payroll run ID' });
    return;
  }

  // Verify run exists
  const [run] = await db
    .select({ id: payrollRunsTable.id })
    .from(payrollRunsTable)
    .where(eq(payrollRunsTable.id, runId));
  if (!run) {
    res.status(404).json({ error: 'Payroll run not found' });
    return;
  }

  const statuses = await db
    .select({
      payrollRecordId: payslipGenerationsTable.payrollRecordId,
      status: payslipGenerationsTable.status,
      generatedAt: payslipGenerationsTable.generatedAt,
      errorMessage: payslipGenerationsTable.errorMessage,
    })
    .from(payslipGenerationsTable)
    .where(eq(payslipGenerationsTable.payrollRunId, runId));

  res.json({ statuses });
});

// ─── PATCH /payroll-runs/:id/payslip-statuses ─────────────────────────────────
// Body: { updates: Array<{ payrollRecordId, status, errorMessage? }> }
router.patch('/payroll-runs/:id/payslip-statuses', requireAuth, async (req: Request, res: Response) => {
  const runId = parseInt(String(req.params.id), 10);
  if (isNaN(runId)) {
    res.status(400).json({ error: 'Invalid payroll run ID' });
    return;
  }

  const { updates } = req.body;
  if (!Array.isArray(updates) || updates.length === 0) {
    res.status(400).json({ error: 'updates array is required' });
    return;
  }

  // Upsert each record status
  for (const update of updates) {
    const { payrollRecordId, status, errorMessage } = update;
    if (!payrollRecordId || !status) continue;

    const now = new Date();
    await db
      .insert(payslipGenerationsTable)
      .values({
        payrollRecordId,
        payrollRunId: runId,
        status,
        generatedAt: status === 'GENERATED' ? now : null,
        errorMessage: errorMessage ?? null,
      })
      .onConflictDoUpdate({
        target: payslipGenerationsTable.payrollRecordId,
        set: {
          status,
          generatedAt: status === 'GENERATED' ? now : null,
          errorMessage: errorMessage ?? null,
          updatedAt: now,
        },
      });
  }

  res.json({ updated: updates.length });
});

// ─── GET /company-settings/logo ───────────────────────────────────────────────
// Proxies the company logo from object storage so the browser doesn't need
// direct (unauthenticated) storage access. Required by react-pdf in the browser.
router.get('/company-settings/logo', requireAuth, async (req: Request, res: Response) => {
  const { companySettingsTable } = await import('@workspace/db/schema');
  const [settings] = await db.select({ logoPath: companySettingsTable.logoPath }).from(companySettingsTable).limit(1);

  if (!settings?.logoPath) {
    res.status(404).json({ error: 'No logo configured' });
    return;
  }

  try {
    const file = await objectStorageService.getObjectEntityFile(settings.logoPath);
    const [buffer] = await file.download();

    // Detect basic content type from extension
    const ext = settings.logoPath.toLowerCase().split('.').pop() ?? '';
    const mimeMap: Record<string, string> = {
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      gif: 'image/gif',
      webp: 'image/webp',
      svg: 'image/svg+xml',
    };
    const contentType = mimeMap[ext] ?? 'image/png';

    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'private, max-age=300'); // 5-min cache
    res.send(buffer);
  } catch (err) {
    req.log.error({ err }, 'Failed to proxy company logo');
    res.status(502).json({ error: 'Failed to load logo from storage' });
  }
});

export default router;
