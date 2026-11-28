import type { Queryable } from '../attendance/db';
import { enqueueMessage } from '../attendance/outboxStore';
import type { AttendanceSettings } from '../attendance/settings';
import { niceDay } from './leaveEvaluate';
import { approvePayload, buildLeaveParams, LEAVE_TEMPLATES, rejectPayload } from './leaveTemplates';
import type { RequestListItem } from './requestQueries';

/**
 * Queue the WhatsApp messages around a leave request. Everything goes through the outbox, so a
 * message is never lost: it is retried until it is delivered or clearly fails, and shows up on the
 * dashboard if it fails. Queuing the same thing twice is harmless (idempotency keys).
 *
 * No message here carries a selfie, a phone number or a link that grants access.
 */

export const dayRangeText = (r: Pick<RequestListItem, 'startDate' | 'endDate' | 'dayMode'>): string => {
  if (r.startDate !== r.endDate) return `${niceDay(r.startDate)} to ${niceDay(r.endDate)}`;
  if (r.dayMode === 'FIRST_HALF') return `${niceDay(r.startDate)} (first half)`;
  if (r.dayMode === 'SECOND_HALF') return `${niceDay(r.startDate)} (second half)`;
  return niceDay(r.startDate);
};

const days = (n: number) => `${n} day${n === 1 ? '' : 's'}`;

/** "2 days: 2 paid, 0 without pay": what the Director sees about the cost before deciding. */
export const splitText = (r: Pick<RequestListItem, 'totalDays' | 'paidDays' | 'lopDays'>): string =>
  `${days(r.totalDays)}: ${r.paidDays} paid, ${r.lopDays} without pay`;

async function employeeWhatsapp(q: Queryable, employeeId: number): Promise<string | null> {
  const { rows } = await q.query<{ whatsapp_e164: string | null }>(
    'select whatsapp_e164 from attendance_employees where employee_id = $1', [employeeId],
  );
  return rows[0]?.whatsapp_e164 ?? null;
}

/** Ask the Director to decide, with Approve and Reject buttons. Returns null if no Director number is set. */
export async function notifyDirectorOfLeave(q: Queryable, settings: AttendanceSettings, r: RequestListItem): Promise<string | null> {
  if (!settings.directorWhatsapp) return null;
  return enqueueMessage(q, {
    recipientType: 'DIRECTOR', recipientE164: settings.directorWhatsapp, employeeId: r.employeeId, kind: 'DIRECTOR_LEAVE_REQUEST',
    deliveryMode: 'TEMPLATE', templateName: settings.leaveTemplates.leaveRequest || LEAVE_TEMPLATES.leaveRequest.defaultName,
    templateLanguage: settings.templateLanguage,
    payload: {
      params: buildLeaveParams('leaveRequest', [r.employeeName, r.employeeCode, r.campusName, r.leaveTypeName, dayRangeText(r), splitText(r), r.reason]),
      buttons: [approvePayload(r.id), rejectPayload(r.id)],
    },
    idempotencyKey: `leave-request:${r.id}`,
  });
}

/** Tell the employee the outcome. A template, because the decision can arrive days after they last wrote. */
export async function notifyEmployeeOfDecision(q: Queryable, settings: AttendanceSettings, r: RequestListItem): Promise<string | null> {
  const whatsapp = await employeeWhatsapp(q, r.employeeId);
  if (!whatsapp || r.status === 'PENDING') return null;
  const outcome = r.status === 'APPROVED' ? 'approved' : r.status === 'REJECTED' ? 'not approved' : 'cancelled';
  const details = r.status === 'APPROVED'
    ? (r.lopDays <= 0 ? 'All days are paid.' : r.lopDays >= r.totalDays ? 'These days are without pay.' : `${days(r.lopDays)} without pay.`)
    : r.status === 'REJECTED' ? (r.decisionNote ? `Reason: ${r.decisionNote}.` : 'Please contact the school administration.')
      : (r.cancelReason ? `Reason: ${r.cancelReason}.` : 'No further action is needed.');
  return enqueueMessage(q, {
    recipientType: 'EMPLOYEE', recipientE164: whatsapp, employeeId: r.employeeId, kind: 'LEAVE_DECISION', deliveryMode: 'TEMPLATE',
    templateName: settings.leaveTemplates.leaveDecision || LEAVE_TEMPLATES.leaveDecision.defaultName,
    templateLanguage: settings.templateLanguage,
    payload: { params: buildLeaveParams('leaveDecision', [r.leaveTypeName, dayRangeText(r), outcome, details]) },
    idempotencyKey: `leave-decision:${r.id}:${r.status}`,
  });
}

/** A free-text reply to an employee, for example "that date is full". Sent inside their 24-hour window. */
export async function queueLeaveReply(q: Queryable, employeeId: number, body: string, key: string): Promise<string | null> {
  const whatsapp = await employeeWhatsapp(q, employeeId);
  if (!whatsapp) return null;
  return enqueueMessage(q, {
    recipientType: 'EMPLOYEE', recipientE164: whatsapp, employeeId, kind: 'LEAVE_INFO', deliveryMode: 'TEXT',
    payload: { body }, idempotencyKey: key,
  });
}

/** A free-text confirmation to the Director after they tap a button. Sent inside their 24-hour window. */
export async function queueDirectorReply(q: Queryable, settings: AttendanceSettings, body: string, key: string): Promise<string | null> {
  if (!settings.directorWhatsapp) return null;
  return enqueueMessage(q, {
    recipientType: 'DIRECTOR', recipientE164: settings.directorWhatsapp, kind: 'DIRECTOR_INFO', deliveryMode: 'TEXT',
    payload: { body }, idempotencyKey: key,
  });
}
