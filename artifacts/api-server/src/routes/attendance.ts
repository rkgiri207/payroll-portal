import { createHash, timingSafeEqual } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { pool } from '@workspace/db';
import { requireAttendanceEnabled } from '../middlewares/attendanceEnabled';
import adminRouter from './attendanceAdmin';
import { asPoolLike } from '../lib/attendance/db';
import { getLinkInfo, submitLocation, submitSelfie, type HttpResult, type LinkDeps } from '../lib/attendance/linkService';
import { createSelfieStorage } from '../lib/attendance/selfieStorage';
import { runSweep } from '../lib/attendance/sweeper';
import { loadWhatsAppConfig } from '../lib/attendance/whatsappSender';

/**
 * Attendance routes. This file holds the PUBLIC, token-protected endpoints used by the phone
 * page. They have no login: the one-time token in the link is the credential (single use,
 * about 5 minutes, bound to one employee, campus and IN/OUT, validated on the server).
 * Admin endpoints are added in a later step.
 */
const router = Router();
router.use('/attendance', requireAttendanceEnabled);
// Signed-in admin endpoints (setup screens and dashboard). Each needs a portal login.
router.use('/attendance/admin', adminRouter);

function buildDeps(): LinkDeps {
  return {
    pool: asPoolLike(pool),
    wa: loadWhatsAppConfig(),
    env: process.env,
    now: () => new Date(),
    storage: createSelfieStorage(),
  };
}

async function respond(req: Request, res: Response, run: () => Promise<HttpResult>): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  try {
    const result = await run();
    res.status(result.http).json(result.body);
  } catch (error) {
    // Never log the token, coordinates or image.
    req.log.error({ err: error instanceof Error ? error.message : 'unknown' }, 'Attendance link request failed');
    res.status(500).json({ ok: false, error: 'Something went wrong. Please try again.' });
  }
}

/**
 * Trigger a sweep from outside (an external cron, if Netlify's schedule is not running on this
 * deploy). Protected by a shared secret header; never exposed to the browser.
 */
router.post('/attendance/sweep', async (req: Request, res: Response) => {
  const expected = process.env.ATTENDANCE_SWEEP_SECRET?.trim();
  if (!expected) {
    res.status(503).json({ ok: false, error: 'Sweep trigger is not configured' });
    return;
  }
  const provided = req.get('x-sweep-secret') ?? '';
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(expected).digest();
  if (!timingSafeEqual(a, b)) {
    res.status(401).json({ ok: false, error: 'Unauthorized' });
    return;
  }
  try {
    const { wa, pool: db, env, now } = buildDeps();
    res.json({ ok: true, ...(await runSweep({ pool: db, wa, env, now })) });
  } catch (error) {
    req.log.error({ err: error instanceof Error ? error.message : 'unknown' }, 'Attendance sweep failed');
    res.status(500).json({ ok: false, error: 'Sweep failed' });
  }
});

router.get('/attendance/link/:token', (req: Request, res: Response) =>
  respond(req, res, () => getLinkInfo(buildDeps(), req.params.token)));

router.post('/attendance/link/:token/location', (req: Request, res: Response) =>
  respond(req, res, () =>
    submitLocation(buildDeps(), req.params.token, {
      lat: req.body?.lat,
      lng: req.body?.lng,
      accuracyM: req.body?.accuracyM,
      userAgent: req.get('user-agent') ?? null,
    })));

router.post('/attendance/link/:token/selfie', (req: Request, res: Response) =>
  respond(req, res, () => submitSelfie(buildDeps(), req.params.token, { image: req.body?.image })));

export default router;
