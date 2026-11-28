import { Router, type Request, type Response } from 'express';
import { pool } from '@workspace/db';
import { requireAttendanceEnabled } from '../middlewares/attendanceEnabled';
import { asPoolLike } from '../lib/attendance/db';
import type { HttpResult } from '../lib/leave/employeeLeave';
import {
  cancelPermissionForm, getPermissionFormInfo, previewPermissionForm, submitPermissionForm, type PermissionNotifier,
} from '../lib/leave/employeePermission';
import { onPermissionSubmitted, replyToEmployee } from '../lib/leave/leaveEvents';

/**
 * The employee's permission form. No login: the one-time link sent on WhatsApp is the credential
 * (random, hashed, short-lived, bound to one employee). The token is never logged. Switched off
 * with the rest of the module (ATTENDANCE_ENABLED).
 */
const router = Router();
router.use('/permission-form', requireAttendanceEnabled);

const db = asPoolLike(pool);

async function respond(req: Request, res: Response, run: () => Promise<HttpResult>): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  try {
    const result = await run();
    res.status(result.http).json(result.body);
  } catch (error) {
    req.log.error({ err: error instanceof Error ? error.message : 'unknown' }, 'Permission form request failed');
    res.status(500).json({ ok: false, error: 'Something went wrong. Please try again.' });
  }
}

/** A WhatsApp problem must never undo or hide a request that is already saved. */
const notifier = (req: Request): PermissionNotifier => ({
  permissionSubmitted: async id => {
    try { await onPermissionSubmitted(db, id); } catch (error) {
      req.log.error({ err: error instanceof Error ? error.message : 'unknown' }, 'Permission WhatsApp notification failed');
    }
  },
  replyToEmployee: async (employeeId, body, key) => {
    try { await replyToEmployee(db, employeeId, body, key); } catch (error) {
      req.log.error({ err: error instanceof Error ? error.message : 'unknown' }, 'Permission WhatsApp reply failed');
    }
  },
});

const deps = () => ({ pool: db, now: () => new Date() });

router.get('/permission-form/:token', (req, res) => respond(req, res, () => getPermissionFormInfo(deps(), req.params.token)));
router.post('/permission-form/:token/preview', (req, res) => respond(req, res, () => previewPermissionForm(deps(), req.params.token, req.body)));
router.post('/permission-form/:token/submit', (req, res) => respond(req, res, () => submitPermissionForm({ ...deps(), notify: notifier(req) }, req.params.token, req.body)));
router.post('/permission-form/:token/cancel', (req, res) => respond(req, res, () => cancelPermissionForm(deps(), req.params.token, req.body)));

export default router;
