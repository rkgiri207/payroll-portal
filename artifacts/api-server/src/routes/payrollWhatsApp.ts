import { Router, type Request, type Response } from 'express';
import { requireAuth } from '../middlewares/requireAuth';
import { PayrollWhatsAppError, sendTestPayrollWhatsApp } from '../lib/payrollWhatsAppService';

const router = Router();

router.post('/payroll-records/:id/whatsapp/send-test', requireAuth, async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) {
    res.status(400).json({ error: 'Invalid payroll record ID', code: 'INVALID_RECORD_ID' });
    return;
  }
  try {
    res.json(await sendTestPayrollWhatsApp(id));
  } catch (error) {
    if (error instanceof PayrollWhatsAppError) {
      req.log.warn({ payrollRecordId: id, code: error.code }, 'Payroll WhatsApp send did not complete');
      res.status(error.statusCode).json({ error: error.message, code: error.code });
      return;
    }
    req.log.error({ err: error, payrollRecordId: id }, 'Unexpected Payroll WhatsApp failure');
    res.status(500).json({ error: 'WhatsApp send failed', code: 'INTERNAL_ERROR' });
  }
});

export default router;
