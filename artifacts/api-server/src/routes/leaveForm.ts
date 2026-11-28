import { Router, type Request, type Response } from 'express';
import { pool } from '@workspace/db';
import { requireAttendanceEnabled } from '../middlewares/attendanceEnabled';
import { asPoolLike } from '../lib/attendance/db';
import { cancelForm, getFormInfo, previewForm, submitForm, type HttpResult, type Notifier } from '../lib/leave/employeeLeave';
import { onLeaveSubmitted, replyToEmployee } from '../lib/leave/leaveEvents';

/**
 * The employee's leave form. These endpoints have no login: the one-time link sent to the
 * employee on WhatsApp is the credential (random, hashed, short-lived, bound to one employee).
 * The token is never logged. Switched off with the rest of the module (ATTENDANCE_ENABLED).
 */
const router = Router();
router.use('/leave-form', requireAttendanceEnabled);

const db = asPoolLike(pool);

async function respond(req: Request, res: Response, run: () => Promise<HttpResult>): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  try {
    const result = await run();
    res.status(result.http).json(result.body);
  } catch (error) {
    req.log.error({ err: error instanceof Error ? error.message : 'unknown' }, 'Leave form request failed');
    res.status(500).json({ ok: false, error: 'Something went wrong. Please try again.' });
  }
}

/** A WhatsApp problem must never undo or hide a request that is already saved. */
const notifier = (req: Request): Notifier => ({
  requestSubmitted: async id => {
    try { await onLeaveSubmitted(db, id); } catch (error) {
      req.log.error({ err: error instanceof Error ? error.message : 'unknown' }, 'Leave WhatsApp notification failed');
    }
  },
  replyToEmployee: async (employeeId, body, key) => {
    try { await replyToEmployee(db, employeeId, body, key); } catch (error) {
      req.log.error({ err: error instanceof Error ? error.message : 'unknown' }, 'Leave WhatsApp reply failed');
    }
  },
});

const deps = () => ({ pool: db, now: () => new Date() });

router.get('/leave-form/:token', (req, res) => respond(req, res, () => getFormInfo(deps(), req.params.token)));
router.post('/leave-form/:token/preview', (req, res) => respond(req, res, () => previewForm(deps(), req.params.token, req.body)));
router.post('/leave-form/:token/submit', (req, res) => respond(req, res, () => submitForm({ ...deps(), notify: notifier(req) }, req.params.token, req.body)));
router.post('/leave-form/:token/cancel', (req, res) => respond(req, res, () => cancelForm(deps(), req.params.token, req.body)));

export default router;
