import { NETWORK_PROBLEM, STATUS_LABELS, minutesLeft, type Message } from '../leave-form/copy';
import type { ClosedState, Draft, PermissionInfo } from './api';

/** Plain, short wording for a phone screen. Every sentence says what happened and what to do next. */

export { NETWORK_PROBLEM, STATUS_LABELS, minutesLeft };
export type { Message };

export function closedCopy(state: ClosedState): Message {
  switch (state) {
    case 'EXPIRED':
      return { title: 'This link has expired', body: 'Please send PERMISSION on WhatsApp to get a new link.' };
    case 'USED':
      return { title: 'This link was already used', body: 'To ask again or to cancel a request, send PERMISSION on WhatsApp for a new link.' };
    case 'UNAVAILABLE':
      return { title: 'Permission is not available right now', body: 'Please contact the school administration.' };
    default:
      return { title: 'This link does not work', body: 'Please send PERMISSION on WhatsApp to get a new link.' };
  }
}

export const NO_YEAR: Message = {
  title: 'No academic year is set up for today',
  body: 'Permission can only be requested within an academic year. Please contact the school administration.',
};

/** How long a permission is, in words. */
export function lengthText(minutes: number): string {
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h} hour${h === 1 ? '' : 's'}${m ? ` ${m} minute${m === 1 ? '' : 's'}` : ''}`;
}

/** The limits the Director has set, as one short line (empty when there are none). */
export function limitsLine(l: PermissionInfo['limits']): string {
  const parts: string[] = [];
  if (l.maxPerMonth !== null) parts.push(`${l.usedThisMonth} of ${l.maxPerMonth} permissions used this month`);
  if (l.maxMinutes !== null) parts.push(`each can be up to ${lengthText(l.maxMinutes)}`);
  return parts.join('; ');
}

/** Is the draft complete enough to ask the server about? */
export const canPreview = (d: Draft): boolean => d.date !== '' && d.startTime !== '' && d.endTime !== '';
