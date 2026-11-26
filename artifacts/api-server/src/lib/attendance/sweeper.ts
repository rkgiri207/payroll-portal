import { portalBaseUrl, queueDigestAlert, queueExceptionAlert } from './alerts';
import { withTransaction, type Queryable } from './db';
import type { ServiceDeps } from './attendanceService';
import { openException } from './exceptionStore';
import { processOutbox, type ProcessSummary } from './outboxWorker';
import { countActivitySince, findInsWithoutOut, getDaySummary } from './rosterStore';
import { loadSettings, type AttendanceSettings } from './settings';
import { istParts, timeToMinutes, type IstParts } from './time';

export interface SweepSummary {
  outbox: ProcessSummary;
  missingOutFlagged: number;
  digestQueued: boolean;
  /** Names of steps that failed (details are logged by the caller). A failed step never blocks the others. */
  failedSteps: string[];
}

/** YYYY-MM-DD minus N days (calendar arithmetic only). */
export function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * A missing OUT is due once the shift's logout time plus the configured delay has passed
 * today, or at any time for an earlier day. It is an exception to review, never an absence.
 */
export function isMissingOutDue(workDate: string, logoutTime: string, delayMinutes: number, now: IstParts): boolean {
  if (workDate < now.workDate) return true;
  if (workDate > now.workDate) return false;
  return now.minuteOfDay >= timeToMinutes(logoutTime) + delayMinutes;
}

/** Raise MISSING_OUT exceptions (once per employee per day) and queue the Director alert. */
export async function flagMissingOuts(deps: ServiceDeps, settings: AttendanceSettings, ist: IstParts): Promise<number> {
  const candidates = await findInsWithoutOut(deps.pool, shiftDate(ist.workDate, -1), ist.workDate);
  const baseUrl = portalBaseUrl(settings, deps.env);
  let flagged = 0;

  for (const c of candidates) {
    if (!isMissingOutDue(c.workDate, c.shiftLogoutTime, settings.missingOutAfterMinutes, ist)) continue;
    await withTransaction(deps.pool, async q => {
      const id = await openException(q, {
        employeeId: c.employeeId, campusId: c.campusId, workDate: c.workDate, kind: 'MISSING_OUT',
        detail: `No check-out recorded (shift ends ${c.shiftLogoutTime.slice(0, 5)})`, eventId: c.eventId,
      });
      if (!id) return; // already flagged on an earlier sweep
      flagged += 1;
      await queueExceptionAlert(q, {
        settings, baseUrl, exceptionId: id, kind: 'MISSING_OUT', workDate: c.workDate,
        at: new Date(`${c.workDate}T12:00:00+05:30`), // so the alert shows the missed day
        employee: { id: c.employeeId, code: c.employeeCode, name: c.employeeName },
        campusName: c.campusName,
      });
    });
  }
  return flagged;
}

async function readSettingTimestamp(q: Queryable, key: string): Promise<Date | null> {
  const { rows } = await q.query<{ v: string | null }>(
    `select value #>> '{}' as v from attendance_settings where key = $1`,
    [key],
  );
  const parsed = rows[0]?.v ? new Date(rows[0].v) : null;
  return parsed && !Number.isNaN(parsed.getTime()) ? parsed : null;
}

/**
 * In digest mode, queue a summary for the Director every `digest_interval_minutes`, but only
 * when something happened since the last one (so nights and quiet days send nothing).
 */
export async function maybeQueueDigest(deps: ServiceDeps, settings: AttendanceSettings, ist: IstParts): Promise<boolean> {
  if (settings.alertMode !== 'digest' || !settings.directorWhatsapp) return false;
  const now = deps.now();
  const lastSent = await readSettingTimestamp(deps.pool, 'digest_last_sent_at');
  if (lastSent && now.getTime() - lastSent.getTime() < settings.digestIntervalMinutes * 60_000) return false;

  const startOfDay = new Date(`${ist.workDate}T00:00:00+05:30`);
  const since = lastSent && lastSent > startOfDay ? lastSent : startOfDay;
  if ((await countActivitySince(deps.pool, since)) === 0) return false;

  const summary = await getDaySummary(deps.pool, ist.workDate, ist.weekday);
  if (summary.expected === 0 && summary.present === 0) return false;

  const slot = Math.floor(ist.minuteOfDay / Math.max(settings.digestIntervalMinutes, 1));
  return withTransaction(deps.pool, async q => {
    const queued = await queueDigestAlert(q, {
      settings, baseUrl: portalBaseUrl(settings, deps.env), at: now, summary,
      idempotencyKey: `digest:${ist.workDate}:${slot}`,
    });
    if (queued) {
      await q.query(`update attendance_settings set value = to_jsonb($2::text), updated_at = now() where key = $1`,
        ['digest_last_sent_at', now.toISOString()]);
    }
    return queued;
  });
}

/**
 * One background pass: flag missing check-outs, queue the digest if due, then send/retry the
 * outbox. Every step is idempotent and safe if two sweeps overlap. A failing step is reported
 * but does not stop the others.
 */
export async function runSweep(deps: ServiceDeps): Promise<SweepSummary> {
  const summary: SweepSummary = {
    outbox: { claimed: 0, sent: 0, stubbed: 0, retried: 0, failed: 0 },
    missingOutFlagged: 0, digestQueued: false, failedSteps: [],
  };
  const ist = istParts(deps.now());
  let settings: AttendanceSettings;
  try {
    settings = await loadSettings(deps.pool);
  } catch {
    summary.failedSteps.push('settings');
    return summary;
  }

  try { summary.missingOutFlagged = await flagMissingOuts(deps, settings, ist); }
  catch { summary.failedSteps.push('missingOut'); }

  try { summary.digestQueued = await maybeQueueDigest(deps, settings, ist); }
  catch { summary.failedSteps.push('digest'); }

  try {
    // A few batches per pass; whatever is left is picked up on the next pass.
    for (let batch = 0; batch < 4; batch += 1) {
      const result = await processOutbox(deps.pool, deps.wa, { limit: 25 });
      for (const key of ['claimed', 'sent', 'stubbed', 'retried', 'failed'] as const) summary.outbox[key] += result[key];
      if (result.claimed < 25) break;
    }
  } catch { summary.failedSteps.push('outbox'); }

  return summary;
}

/**
 * Run a sweep at most once per `minSeconds` across all callers (used by the dashboard poll as a
 * fallback when the scheduled function is not running). Returns null if another sweep ran recently.
 */
export async function maybeSweep(deps: ServiceDeps, minSeconds = 60): Promise<SweepSummary | null> {
  const { rows } = await deps.pool.query<{ key: string }>(
    `update attendance_settings
        set value = to_jsonb($2::text), updated_at = now()
      where key = 'sweeper_last_run_at'
        and (value = 'null'::jsonb or (value #>> '{}')::timestamptz < now() - make_interval(secs => $1::int))
      returning key`,
    [minSeconds, deps.now().toISOString()],
  );
  return rows.length === 1 ? runSweep(deps) : null;
}
