import type { Queryable } from '../attendance/db';
import { enqueueMessage } from '../attendance/outboxStore';
import type { AttendanceSettings } from '../attendance/settings';
import { timeToMinutes } from '../attendance/time';
import { niceDay } from './leaveEvaluate';
import { approvePermissionPayload, buildLeaveParams, LEAVE_TEMPLATES, rejectPermissionPayload } from './leaveTemplates';
import { clockText } from './permissionEvaluate';
import type { PermissionListItem } from './permissionStore';

/** The WhatsApp messages around a permission request. Same outbox rules as leave: never lost, never doubled. */

export const minutesBetween = (p: Pick<PermissionListItem, 'startTime' | 'endTime'>): number => timeToMinutes(p.endTime) - timeToMinutes(p.startTime);
const lengthText = (p: Pick<PermissionListItem, 'startTime' | 'endTime'>): string => {
  const m = minutesBetween(p);
  return `${m} minute${m === 1 ? '' : 's'}`;
};

async function employeeWhatsapp(q: Queryable, employeeId: number): Promise<string | null> {
  const { rows } = await q.query<{ whatsapp_e164: string | null }>('select whatsapp_e164 from attendance_employees where employee_id = $1', [employeeId]);
  return rows[0]?.whatsapp_e164 ?? null;
}

/** Ask the Director to decide, with Approve and Reject buttons. */
export async function notifyDirectorOfPermission(q: Queryable, settings: AttendanceSettings, p: PermissionListItem): Promise<string | null> {
  if (!settings.directorWhatsapp) return null;
  return enqueueMessage(q, {
    recipientType: 'DIRECTOR', recipientE164: settings.directorWhatsapp, employeeId: p.employeeId, kind: 'DIRECTOR_PERMISSION_REQUEST',
    deliveryMode: 'TEMPLATE', templateName: settings.leaveTemplates.permissionRequest || LEAVE_TEMPLATES.permissionRequest.defaultName,
    templateLanguage: settings.templateLanguage,
    payload: {
      params: buildLeaveParams('permissionRequest', [p.employeeName, p.employeeCode, p.campusName, niceDay(p.date), clockText(p.startTime), clockText(p.endTime), lengthText(p), p.reason]),
      buttons: [approvePermissionPayload(p.id), rejectPermissionPayload(p.id)],
    },
    idempotencyKey: `permission-request:${p.id}`,
  });
}

/** Tell the employee the outcome. A template, because the decision can arrive days after they last wrote. */
export async function notifyEmployeeOfPermissionDecision(q: Queryable, settings: AttendanceSettings, p: PermissionListItem): Promise<string | null> {
  const whatsapp = await employeeWhatsapp(q, p.employeeId);
  if (!whatsapp || p.status === 'PENDING') return null;
  const outcome = p.status === 'APPROVED' ? 'approved' : p.status === 'REJECTED' ? 'not approved' : 'cancelled';
  const details = p.status === 'REJECTED' ? (p.decisionNote ? `Reason: ${p.decisionNote}.` : 'Please contact the school administration.')
    : p.status === 'CANCELLED' && p.cancelReason ? `Reason: ${p.cancelReason}.` : 'No further action is needed.';
  return enqueueMessage(q, {
    recipientType: 'EMPLOYEE', recipientE164: whatsapp, employeeId: p.employeeId, kind: 'PERMISSION_DECISION', deliveryMode: 'TEMPLATE',
    templateName: settings.leaveTemplates.permissionDecision || LEAVE_TEMPLATES.permissionDecision.defaultName,
    templateLanguage: settings.templateLanguage,
    payload: { params: buildLeaveParams('permissionDecision', [niceDay(p.date), clockText(p.startTime), clockText(p.endTime), outcome, details]) },
    idempotencyKey: `permission-decision:${p.id}:${p.status}`,
  });
}

/** "10:00 AM to 11:00 AM on 07 Sep 2026", for confirmations. */
export const permissionWhen = (p: Pick<PermissionListItem, 'date' | 'startTime' | 'endTime'>): string =>
  `${clockText(p.startTime)} to ${clockText(p.endTime)} on ${niceDay(p.date)}`;
