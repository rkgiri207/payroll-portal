import { formatDay } from './holiday-helpers';
import type { PermissionRequest } from './permission-requests-api';

/** "10:00 AM". */
export function clockText(time: string): string {
  const [h, m] = time.split(':').map(Number);
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

export function minutesOf(r: Pick<PermissionRequest, 'startTime' | 'endTime'>): number {
  const [sh, sm] = r.startTime.split(':').map(Number);
  const [eh, em] = r.endTime.split(':').map(Number);
  return eh * 60 + em - (sh * 60 + sm);
}

/** "08 Sep 2026, 10:00 AM to 11:00 AM (1 hour)". */
export function permissionWhen(r: Pick<PermissionRequest, 'date' | 'startTime' | 'endTime'>): string {
  const m = minutesOf(r);
  const length = m < 60 ? `${m} minute${m === 1 ? '' : 's'}` : `${Math.floor(m / 60)} hour${Math.floor(m / 60) === 1 ? '' : 's'}${m % 60 ? ` ${m % 60} minutes` : ''}`;
  return `${formatDay(r.date)}, ${clockText(r.startTime)} to ${clockText(r.endTime)} (${length})`;
}

/** Who decided it and how, for the history line. */
export function permissionDecisionLine(r: PermissionRequest): string | null {
  if (r.status === 'PENDING') return null;
  if (r.status === 'CANCELLED') {
    const by = r.cancelledBy === 'EMPLOYEE' ? 'the employee' : r.cancelledBy === 'DIRECTOR' ? 'the Director' : 'an administrator';
    return `Cancelled by ${by}${r.cancelReason ? `: ${r.cancelReason}` : ''}`;
  }
  const how = r.decidedVia === 'WHATSAPP' ? 'on WhatsApp' : 'on the web';
  return `${r.status === 'APPROVED' ? 'Approved' : 'Not approved'} by the Director ${how}${r.status === 'REJECTED' && r.decisionNote ? `: ${r.decisionNote}` : ''}`;
}
