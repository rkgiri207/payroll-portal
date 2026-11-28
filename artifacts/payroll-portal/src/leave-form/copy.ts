import type { ClosedState, DayMode, Draft, LeaveTypeInfo, MyRequest, PreviewOutcome } from './api';

/** Plain, short wording for a phone screen. Every sentence says what happened and what to do next. */

export interface Message { title: string; body: string }

export function closedCopy(state: ClosedState): Message {
  switch (state) {
    case 'EXPIRED':
      return { title: 'This link has expired', body: 'Please send LEAVE on WhatsApp to get a new link.' };
    case 'USED':
      return { title: 'This link was already used', body: 'To apply again or to cancel a request, send LEAVE on WhatsApp for a new link.' };
    case 'UNAVAILABLE':
      return { title: 'Leave is not available right now', body: 'Please contact the school administration.' };
    default:
      return { title: 'This link does not work', body: 'Please send LEAVE on WhatsApp to get a new link.' };
  }
}

export const NETWORK_PROBLEM: Message = {
  title: 'Could not reach the server',
  body: 'Please check your internet connection and try again.',
};

export const NO_YEAR: Message = {
  title: 'No academic year is set up for today',
  body: 'Leave can only be requested within an academic year. Please contact the school administration.',
};

export const DAY_MODE_LABELS: Record<DayMode, string> = { FULL: 'Full day', FIRST_HALF: 'First half', SECOND_HALF: 'Second half' };

export const STATUS_LABELS: Record<MyRequest['status'], string> = {
  PENDING: 'Waiting for the Director', APPROVED: 'Approved', REJECTED: 'Not approved', CANCELLED: 'Cancelled',
};

const days = (n: number) => `${n} day${n === 1 ? '' : 's'}`;

/** The option text for a leave type: its balance, when it has one. */
export function typeLabel(t: LeaveTypeInfo): string {
  return t.available === null ? `${t.name} (no balance)` : `${t.name} (${days(t.available)} left)`;
}

/** What a request would cost, in one line. */
export function costLine(p: Extract<PreviewOutcome, { kind: 'ok' }>): string {
  return p.lopDays > 0
    ? `${days(p.totalDays)}: ${p.paidDays} paid, ${p.lopDays} without pay`
    : `${days(p.totalDays)}, all paid`;
}

export const LOP_NOTE = 'Days without pay are decided by the Director, like every request.';

/** Is the draft complete enough to ask the server what it would cost? */
export const canPreview = (d: Draft): boolean => d.leaveTypeId !== '' && d.startDate !== '';

/** A half-day only makes sense for one date. */
export const isSingleDay = (d: Pick<Draft, 'startDate' | 'endDate'>): boolean => d.endDate === '' || d.endDate === d.startDate;

/** Minutes left on the link, rounded up, never negative. */
export function minutesLeft(expiresAt: number, now: number = Date.now()): number {
  return Math.max(Math.ceil((expiresAt - now) / 60_000), 0);
}
