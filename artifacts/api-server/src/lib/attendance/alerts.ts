import type { Queryable } from './db';
import type { ExceptionKind } from './exceptionStore';
import { confirmText, describePunctuality, formatIstDate, formatIstTime, linkText } from './messages';
import { enqueueMessage } from './outboxStore';
import type { DaySummary } from './rosterStore';
import type { AlertMode, AttendanceSettings } from './settings';
import { buildParams, DIRECTOR_TEMPLATES, type DirectorTemplateKey } from './templates';

export type AlertKind = 'NORMAL_IN' | 'NORMAL_OUT' | 'LATE' | 'EXCEPTION' | 'MISSING_OUT';

/**
 * Which alerts go to the Director individually, by alert mode:
 *  - individual:  everything
 *  - mute_normal: late, exceptions and missing OUT only (normal IN/OUT are muted)
 *  - digest:      same as mute_normal; normal IN/OUT are covered by the periodic summary
 * Muting never hides anything from the dashboard; it only changes WhatsApp alerts.
 */
export function shouldAlertDirector(mode: AlertMode, kind: AlertKind): boolean {
  if (mode === 'individual') return true;
  return kind === 'LATE' || kind === 'EXCEPTION' || kind === 'MISSING_OUT';
}

/** Public address used in links: the setting if set, otherwise APP_BASE_URL. No trailing slash. */
export function portalBaseUrl(settings: AttendanceSettings, env: NodeJS.ProcessEnv = process.env): string {
  return (settings.linkBaseUrl || env.APP_BASE_URL || '').replace(/\/+$/, '');
}

export const attendanceLink = (baseUrl: string, token: string) => `${baseUrl}/a/${token}`;
export const dashboardLink = (baseUrl: string) => `${baseUrl}/attendance`;

export const EXCEPTION_REASONS: Record<ExceptionKind, string> = {
  GPS_OUTSIDE_RADIUS: 'Location outside campus',
  POOR_ACCURACY: 'Poor GPS accuracy',
  TOKEN_LOCKED: 'Link locked after repeated location failures',
  MISSING_OUT: 'No check-out recorded',
  NO_SHIFT: 'No shift configured for this day',
  OUTSIDE_WORKING_DAY: 'Check-in on a non-working day',
  SUSPICIOUS: 'Suspicious submission',
  OTHER: 'Other exception',
};

function templateName(settings: AttendanceSettings, key: DirectorTemplateKey): string {
  return settings.templates[key] || DIRECTOR_TEMPLATES[key].defaultName;
}

async function queueDirector(
  q: Queryable,
  settings: AttendanceSettings,
  input: {
    key: DirectorTemplateKey;
    kind: 'DIRECTOR_CHECKIN' | 'DIRECTOR_CHECKOUT' | 'DIRECTOR_LATE' | 'DIRECTOR_EXCEPTION'
      | 'DIRECTOR_MISSING_OUT' | 'DIRECTOR_DIGEST';
    values: unknown[];
    employeeId: number | null;
    eventId?: string | null;
    exceptionId?: string | null;
    idempotencyKey: string;
  },
): Promise<string | null> {
  if (!settings.directorWhatsapp) return null; // dashboard warns when no Director number is set
  return enqueueMessage(q, {
    recipientType: 'DIRECTOR',
    recipientE164: settings.directorWhatsapp,
    employeeId: input.employeeId,
    eventId: input.eventId ?? null,
    exceptionId: input.exceptionId ?? null,
    kind: input.kind,
    deliveryMode: 'TEMPLATE',
    templateName: templateName(settings, input.key),
    templateLanguage: settings.templateLanguage,
    payload: { params: buildParams(input.key, input.values) },
    idempotencyKey: input.idempotencyKey,
  });
}

export interface EventAlertInput {
  settings: AttendanceSettings;
  baseUrl: string;
  eventId: string;
  eventType: 'IN' | 'OUT';
  serverTs: Date;
  punctuality: string;
  lateMinutes: number | null;
  employee: { id: number; code: string; name: string; whatsapp: string };
  campusName: string;
}

/**
 * Queue what an IN or OUT produces: a confirmation to the employee, and a Director alert.
 * A late IN produces ONE Director message (the late alert, which also carries the check-in
 * details) instead of two. Safe to call inside the attendance transaction.
 */
export async function queueEventAlerts(q: Queryable, a: EventAlertInput): Promise<{ employee: boolean; director: boolean }> {
  const employeeQueued = await enqueueMessage(q, {
    recipientType: 'EMPLOYEE',
    recipientE164: a.employee.whatsapp,
    employeeId: a.employee.id,
    eventId: a.eventId,
    kind: a.eventType === 'IN' ? 'CHECKIN_CONFIRM' : 'CHECKOUT_CONFIRM',
    deliveryMode: 'TEXT',
    payload: {
      body: confirmText({
        type: a.eventType, campusName: a.campusName, at: a.serverTs,
        punctuality: a.punctuality, lateMinutes: a.lateMinutes,
      }),
    },
    idempotencyKey: `confirm:${a.eventId}`,
  });

  const date = formatIstDate(a.serverTs);
  const time = formatIstTime(a.serverTs);
  const link = dashboardLink(a.baseUrl);
  const base = [a.employee.name, a.employee.code, a.campusName, date, time];
  let directorQueued: string | null = null;

  if (a.eventType === 'OUT') {
    if (shouldAlertDirector(a.settings.alertMode, 'NORMAL_OUT')) {
      directorQueued = await queueDirector(q, a.settings, {
        key: 'checkout', kind: 'DIRECTOR_CHECKOUT', values: [...base, link],
        employeeId: a.employee.id, eventId: a.eventId, idempotencyKey: `director:${a.eventId}`,
      });
    }
  } else if (a.punctuality === 'LATE') {
    if (shouldAlertDirector(a.settings.alertMode, 'LATE')) {
      directorQueued = await queueDirector(q, a.settings, {
        key: 'late', kind: 'DIRECTOR_LATE', values: [...base, a.lateMinutes ?? '-', link],
        employeeId: a.employee.id, eventId: a.eventId, idempotencyKey: `director:${a.eventId}`,
      });
    }
  } else if (shouldAlertDirector(a.settings.alertMode, 'NORMAL_IN')) {
    directorQueued = await queueDirector(q, a.settings, {
      key: 'checkin', kind: 'DIRECTOR_CHECKIN',
      values: [...base, describePunctuality(a.punctuality, a.lateMinutes) || 'Recorded', link],
      employeeId: a.employee.id, eventId: a.eventId, idempotencyKey: `director:${a.eventId}`,
    });
  }
  return { employee: employeeQueued !== null, director: directorQueued !== null };
}

export interface ExceptionAlertInput {
  settings: AttendanceSettings;
  baseUrl: string;
  exceptionId: string;
  kind: ExceptionKind;
  workDate: string;            // YYYY-MM-DD
  at: Date;
  employee: { id: number; code: string; name: string };
  campusName: string | null;
}

/** Queue the Director alert for an exception (always sent, in every alert mode). */
export async function queueExceptionAlert(q: Queryable, a: ExceptionAlertInput): Promise<boolean> {
  const campus = a.campusName ?? 'Unknown campus';
  const link = dashboardLink(a.baseUrl);
  const date = formatIstDate(a.at);

  if (a.kind === 'MISSING_OUT') {
    return (await queueDirector(q, a.settings, {
      key: 'missingOut', kind: 'DIRECTOR_MISSING_OUT',
      values: [a.employee.name, a.employee.code, campus, date, link],
      employeeId: a.employee.id, exceptionId: a.exceptionId, idempotencyKey: `director-exception:${a.exceptionId}`,
    })) !== null;
  }
  return (await queueDirector(q, a.settings, {
    key: 'exception', kind: 'DIRECTOR_EXCEPTION',
    values: [a.employee.name, a.employee.code, campus, date, EXCEPTION_REASONS[a.kind], link],
    employeeId: a.employee.id, exceptionId: a.exceptionId, idempotencyKey: `director-exception:${a.exceptionId}`,
  })) !== null;
}

/** Queue the periodic summary for the Director (digest mode). */
export async function queueDigestAlert(
  q: Queryable,
  a: { settings: AttendanceSettings; baseUrl: string; at: Date; summary: DaySummary; idempotencyKey: string },
): Promise<boolean> {
  return (await queueDirector(q, a.settings, {
    key: 'digest', kind: 'DIRECTOR_DIGEST',
    values: [
      formatIstDate(a.at), formatIstTime(a.at), a.summary.present, a.summary.late,
      a.summary.unmarked, a.summary.openExceptions, dashboardLink(a.baseUrl),
    ],
    employeeId: null, idempotencyKey: a.idempotencyKey,
  })) !== null;
}

/** Queue the one-time link message to an employee. The URL is cleared from the outbox once sent. */
export async function queueLinkMessage(
  q: Queryable,
  input: {
    employee: { id: number; whatsapp: string };
    tokenId: string;
    type: 'IN' | 'OUT';
    campusName: string;
    url: string;
    ttlMinutes: number;
  },
): Promise<boolean> {
  return (await enqueueMessage(q, {
    recipientType: 'EMPLOYEE',
    recipientE164: input.employee.whatsapp,
    employeeId: input.employee.id,
    kind: 'LINK',
    deliveryMode: 'TEXT',
    payload: { body: linkText({ type: input.type, campusName: input.campusName, url: input.url, ttlMinutes: input.ttlMinutes }) },
    idempotencyKey: `link:${input.tokenId}`,
  })) !== null;
}

/** Queue a plain reply to an employee (help, errors, locked-link notice, ...). */
export async function queueEmployeeText(
  q: Queryable,
  input: {
    employee: { id: number | null; whatsapp: string };
    kind: 'FAILED_VERIFICATION' | 'TOKEN_LOCKED' | 'HELP' | 'COMING_SOON' | 'CAMPUS_CHOICE';
    body: string;
    idempotencyKey: string;
  },
): Promise<boolean> {
  return (await enqueueMessage(q, {
    recipientType: 'EMPLOYEE',
    recipientE164: input.employee.whatsapp,
    employeeId: input.employee.id,
    kind: input.kind,
    deliveryMode: 'TEXT',
    payload: { body: input.body },
    idempotencyKey: input.idempotencyKey,
  })) !== null;
}
