import { createHash, timingSafeEqual } from 'node:crypto';
import express, { Router, type Request, type Response } from 'express';
import { pool } from '@workspace/db';
import { requireAttendanceEnabled } from '../middlewares/attendanceEnabled';
import { flushOutbox, handleDeliveryStatus, handleInboundMessage, type ServiceDeps } from '../lib/attendance/attendanceService';
import { asPoolLike } from '../lib/attendance/db';
import { extractInbound } from '../lib/attendance/inbound';
import { verifyMetaSignature } from '../lib/attendance/webhookSecurity';
import { loadWhatsAppConfig } from '../lib/attendance/whatsappSender';

/**
 * Meta WhatsApp webhook for attendance. Mounted BEFORE the JSON body parser (see app.ts) so
 * the exact raw bytes are available for signature verification.
 *
 *   GET  /api/attendance/webhook   Meta's one-time verification handshake
 *   POST /api/attendance/webhook   inbound messages and delivery statuses
 *
 * Unsigned or wrongly signed requests are rejected. Every valid request is answered 200 so
 * Meta does not retry; duplicates are dropped by message ID.
 */
const router = Router();
router.use(requireAttendanceEnabled);

function buildDeps(): ServiceDeps {
  return { pool: asPoolLike(pool), wa: loadWhatsAppConfig(), env: process.env, now: () => new Date() };
}

const sameSecret = (a: string, b: string): boolean => {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
};

router.get('/', (req: Request, res: Response) => {
  const expected = process.env.ATTENDANCE_WA_VERIFY_TOKEN?.trim();
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (expected && mode === 'subscribe' && typeof token === 'string' && typeof challenge === 'string' && sameSecret(token, expected)) {
    res.status(200).type('text/plain').send(challenge);
    return;
  }
  res.sendStatus(403);
});

router.post('/', express.raw({ type: () => true, limit: '1mb' }), async (req: Request, res: Response) => {
  const secret = process.env.ATTENDANCE_WA_APP_SECRET?.trim();
  if (!secret) {
    req.log.error('ATTENDANCE_WA_APP_SECRET is not configured; rejecting webhook');
    res.sendStatus(503);
    return;
  }
  if (!Buffer.isBuffer(req.body)) {
    res.sendStatus(400);
    return;
  }
  if (!verifyMetaSignature(req.body, req.get('x-hub-signature-256'), secret)) {
    req.log.warn('Rejected attendance webhook with an invalid signature');
    res.sendStatus(401);
    return;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(req.body.toString('utf8'));
  } catch {
    res.sendStatus(400);
    return;
  }

  const deps = buildDeps();
  const { messages, statuses } = extractInbound(payload);

  for (const message of messages) {
    try {
      await handleInboundMessage(deps, message);
    } catch (error) {
      // Never log the sender's number or the message text.
      req.log.error({ err: error instanceof Error ? error.message : 'unknown' }, 'Attendance webhook message failed');
    }
  }
  for (const status of statuses) {
    try {
      await handleDeliveryStatus(deps, status);
    } catch (error) {
      req.log.error({ err: error instanceof Error ? error.message : 'unknown' }, 'Attendance delivery status failed');
    }
  }
  if (statuses.length > 0) await flushOutbox(deps, 1_500); // pick up any retries that became due

  res.sendStatus(200);
});

export default router;
