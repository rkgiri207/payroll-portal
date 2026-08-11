import { Router, type Request, type Response } from 'express';
import { requireAuth } from '../middlewares/requireAuth';
import { cleanupExpiredPayslipShares, createPayslipShare } from '../lib/payslipSharing';

const router = Router();

router.post('/payroll-records/:id/share-link', requireAuth, async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) {
    res.status(400).json({ error: 'Invalid payroll record ID' });
    return;
  }
  try {
    const result = await createPayslipShare(id, req.body?.forceNew === true);
    res.status(result.reused ? 200 : 201).json(result);
    void cleanupExpiredPayslipShares(25).catch(error => req.log.warn({ err: error }, 'Lazy share cleanup failed'));
  } catch (error) {
    req.log.error({ err: error, payrollRecordId: id }, 'Failed to create payslip share');
    const message = error instanceof Error && error.message === 'Payroll record not found'
      ? error.message : 'Failed to create payslip share link';
    res.status(message === 'Payroll record not found' ? 404 : 500).json({ error: message });
  }
});

router.post('/payslip-shares/cleanup', requireAuth, async (req: Request, res: Response) => {
  const cleaned = await cleanupExpiredPayslipShares();
  res.json({ cleaned });
});

export default router;
