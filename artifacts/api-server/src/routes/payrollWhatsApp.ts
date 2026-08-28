import { Router, type Request, type Response } from 'express';
import { requireAuth } from '../middlewares/requireAuth';
import {
  PayrollWhatsAppError,
  previewBulkPayrollWhatsApp,
  sendBulkPayrollWhatsApp,
  sendTestPayrollWhatsApp,
} from '../lib/payrollWhatsAppService';

const router = Router();

function recordIds(body: unknown, maximum = 200): number[] | null {
  const values = (body as { recordIds?: unknown })?.recordIds;
  if (!Array.isArray(values) || values.length < 1 || values.length > maximum) return null;
  const ids = [...new Set(values.map(Number))];
  return ids.every(id => Number.isSafeInteger(id) && id > 0) ? ids : null;
}

function handleError(req: Request, res: Response, error: unknown, operation: string) {
  if (error instanceof PayrollWhatsAppError) {
    req.log.warn({ code: error.code, operation }, 'Payroll WhatsApp operation did not complete');
    res.status(error.statusCode).json({ error: error.message, code: error.code });
    return;
  }
  const message = error instanceof Error ? error.message : 'WhatsApp operation failed';
  req.log.error({ err: error, operation }, 'Unexpected Payroll WhatsApp failure');
  res.status(500).json({ error: message, code: 'INTERNAL_ERROR' });
}

router.post('/payroll-whatsapp/batch/preview', requireAuth, async (req: Request, res: Response) => {
  const ids = recordIds(req.body);
  if (!ids) {
    res.status(400).json({ error: 'recordIds must contain between 1 and 200 unique positive integers', code: 'INVALID_RECORD_IDS' });
    return;
  }
  try {
    res.json(await previewBulkPayrollWhatsApp(ids, req.body?.override === true));
  } catch (error) {
    handleError(req, res, error, 'payroll_whatsapp.batch_preview');
  }
});

router.post('/payroll-whatsapp/batch/send', requireAuth, async (req: Request, res: Response) => {
  const ids = recordIds(req.body, 10);
  const requestId = typeof req.body?.requestId === 'string' ? req.body.requestId.trim() : '';
  if (!ids || !/^[A-Za-z0-9_-]{8,64}$/.test(requestId)) {
    res.status(400).json({ error: 'Between 1 and 10 valid recordIds and a requestId are required', code: 'INVALID_BATCH_REQUEST' });
    return;
  }
  try {
    res.json(await sendBulkPayrollWhatsApp(ids, requestId, req.body?.override === true));
  } catch (error) {
    handleError(req, res, error, 'payroll_whatsapp.batch_send');
  }
});

router.post('/payroll-records/:id/whatsapp/send-test', requireAuth, async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) {
    res.status(400).json({ error: 'Invalid payroll record ID', code: 'INVALID_RECORD_ID' });
    return;
  }
  try {
    res.json(await sendTestPayrollWhatsApp(id));
  } catch (error) {
    handleError(req, res, error, 'payroll_whatsapp.send_test');
  }
});

export default router;
