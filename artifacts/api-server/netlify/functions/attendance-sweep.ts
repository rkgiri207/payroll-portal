/**
 * Scheduled Netlify function: runs the attendance sweeper every 5 minutes.
 *
 * It retries queued/failed WhatsApp messages, raises missing check-out exceptions, and sends
 * the digest when digest mode is on. It does nothing unless ATTENDANCE_ENABLED=true.
 *
 * Note: Netlify runs scheduled functions only on a site's PUBLISHED (production) deploy. If
 * this branch is deployed as a branch deploy or deploy preview, the schedule will not fire;
 * use POST /api/attendance/sweep (with the ATTENDANCE_SWEEP_SECRET header) from an external
 * cron instead. The dashboard also triggers a throttled sweep while someone has it open.
 */
import { pool } from '@workspace/db';
import { asPoolLike } from '../../src/lib/attendance/db';
import { runSweep } from '../../src/lib/attendance/sweeper';
import { loadWhatsAppConfig } from '../../src/lib/attendance/whatsappSender';

export default async function handler(): Promise<Response> {
  if (process.env.ATTENDANCE_ENABLED !== 'true') {
    return new Response('Attendance is disabled', { status: 200 });
  }
  try {
    const summary = await runSweep({
      pool: asPoolLike(pool), wa: loadWhatsAppConfig(), env: process.env, now: () => new Date(),
    });
    console.info(`[attendance-sweep] ${JSON.stringify(summary)}`); // counts only; no personal data
    return new Response(JSON.stringify(summary), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (error) {
    console.error('[attendance-sweep] failed', error instanceof Error ? error.message : 'unknown');
    return new Response('Sweep failed', { status: 500 });
  }
}

export const config = { schedule: '*/5 * * * *' };
