import { formatRange } from './holiday-helpers';
import type { DayMode, LeaveRequest, LeaveStatus } from './leave-requests-api';

export const STATUS_LABELS: Record<LeaveStatus, string> = {
  PENDING: 'Waiting for the Director', APPROVED: 'Approved', REJECTED: 'Not approved', CANCELLED: 'Cancelled',
};
export const STATUS_SHORT: Record<LeaveStatus, string> = { PENDING: 'Pending', APPROVED: 'Approved', REJECTED: 'Not approved', CANCELLED: 'Cancelled' };

export const DAY_MODE_LABELS: Record<DayMode, string> = { FULL: 'Full day', FIRST_HALF: 'First half', SECOND_HALF: 'Second half' };

const days = (n: number) => `${n} day${n === 1 ? '' : 's'}`;

/** "07 Oct 2026 to 08 Oct 2026", or "07 Oct 2026 (first half)". */
export function requestDates(r: Pick<LeaveRequest, 'startDate' | 'endDate' | 'dayMode'>): string {
  const range = formatRange(r.startDate, r.endDate);
  return r.dayMode === 'FULL' ? range : `${range} (${DAY_MODE_LABELS[r.dayMode].toLowerCase()})`;
}

/** "2 days (2 paid)" or "3 days (1 paid, 2 without pay)". */
export function requestCost(r: Pick<LeaveRequest, 'totalDays' | 'paidDays' | 'lopDays'>): string {
  return r.lopDays > 0 ? `${days(r.totalDays)} (${r.paidDays} paid, ${r.lopDays} without pay)` : `${days(r.totalDays)} (${r.paidDays} paid)`;
}

/** Who decided it and how, for the history line. */
export function decisionLine(r: LeaveRequest): string | null {
  if (r.status === 'PENDING') return null;
  if (r.status === 'CANCELLED') {
    const by = r.cancelledBy === 'EMPLOYEE' ? 'the employee' : r.cancelledBy === 'DIRECTOR' ? 'the Director' : 'an administrator';
    return `Cancelled by ${by}${r.cancelReason ? `: ${r.cancelReason}` : ''}`;
  }
  if (r.decidedVia === 'SYSTEM') return r.decisionNote ?? 'Declined automatically';
  const how = r.decidedVia === 'WHATSAPP' ? 'on WhatsApp' : 'on the web';
  return `${r.status === 'APPROVED' ? 'Approved' : 'Not approved'} by the Director ${how}${r.status === 'REJECTED' && r.decisionNote ? `: ${r.decisionNote}` : ''}`;
}

/** A request the system declined because a date was full: kept for the record, never shown to the Director. */
export const isAutoRejected = (r: Pick<LeaveRequest, 'status' | 'decidedVia'>): boolean => r.status === 'REJECTED' && r.decidedVia === 'SYSTEM';

/** Can this request still be cancelled, and by whom? Cancelling approved leave needs a reason. */
export const canCancel = (r: Pick<LeaveRequest, 'status'>): boolean => r.status === 'PENDING' || r.status === 'APPROVED';
export const cancelNeedsReason = (r: Pick<LeaveRequest, 'status'>): boolean => r.status === 'APPROVED';

/** How long a request has been waiting, in whole days, for the "waiting N days" hint. */
export function waitingDays(submittedAt: string, now: Date = new Date()): number {
  // Postgres writes the zone as +00 or +05:30; JavaScript needs +00:00.
  const iso = submittedAt.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00');
  const ms = now.getTime() - new Date(iso).getTime();
  return Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 86_400_000) : 0;
}
