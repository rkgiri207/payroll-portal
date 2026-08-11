import { Router, type Request, type Response } from 'express';
import { eq } from 'drizzle-orm';
import { db } from '@workspace/db';
import { payrollRecordsTable } from '@workspace/db/schema';
import { ObjectNotFoundError, STORAGE_BUCKETS } from '../lib/objectStorage';
import {
  cleanupExpiredPayslipShares,
  findPayslipShare,
  payslipStorage,
  recordShareAccess,
} from '../lib/payslipSharing';

const router = Router();

function errorPage(res: Response, status: number, title: string, message: string): void {
  res.status(status).type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{margin:0;font-family:system-ui,sans-serif;background:#f5f7fa;color:#172033;display:grid;min-height:100vh;place-items:center}.box{max-width:34rem;padding:2rem;text-align:center}h1{font-size:1.5rem;margin:0 0 .75rem}p{color:#5d687b;line-height:1.5}</style></head><body><main class="box"><h1>${title}</h1><p>${message}</p></main></body></html>`);
}

router.get('/p/:token', async (req: Request, res: Response) => {
  const share = await findPayslipShare(String(req.params.token));
  if (!share || share.revoked) {
    errorPage(res, 404, 'Payslip link unavailable', 'This link is invalid or has been revoked.');
    return;
  }
  if (share.expiresAt.getTime() <= Date.now()) {
    errorPage(res, 410, 'Payslip link expired', 'This secure link has expired. Please request a new link.');
    void cleanupExpiredPayslipShares(25).catch(error => req.log.warn({ err: error }, 'Lazy share cleanup failed'));
    return;
  }

  try {
    const [record] = await db.select({ employeeCode: payrollRecordsTable.employeeCode })
      .from(payrollRecordsTable).where(eq(payrollRecordsTable.id, share.payrollRecordId));
    const file = await payslipStorage.getObjectEntityFile(share.storagePath, STORAGE_BUCKETS.payslips);
    const [buffer] = await file.download();
    await recordShareAccess(share.id);
    const safeCode = (record?.employeeCode ?? 'employee').replace(/[^A-Za-z0-9_-]/g, '_');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="Payslip_${safeCode}.pdf"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(buffer);
  } catch (error) {
    if (error instanceof ObjectNotFoundError) {
      errorPage(res, 404, 'Payslip unavailable', 'The payslip file could not be found. Please request a new link.');
      return;
    }
    req.log.error({ err: error }, 'Failed to serve shared payslip');
    errorPage(res, 502, 'Payslip unavailable', 'The payslip could not be loaded right now.');
  }
});

export default router;
