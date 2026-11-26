/**
 * Free-form replies to employees. They are only ever sent in response to a message the
 * employee just sent (inside WhatsApp's 24-hour window), so no template is needed.
 * No message here contains a selfie, coordinates, or another person's details.
 */
import { ATTENDANCE_TIME_ZONE } from './time';

const timeFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: ATTENDANCE_TIME_ZONE, hour: '2-digit', minute: '2-digit', hour12: true,
});
const dateFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: ATTENDANCE_TIME_ZONE, day: '2-digit', month: 'short', year: 'numeric',
});

/** '09:05 AM' in IST. */
export function formatIstTime(at: Date): string {
  return timeFormat.format(at).replace(/\b(am|pm)\b/i, m => m.toUpperCase());
}

/** '02 Mar 2026' in IST. */
export function formatIstDate(at: Date): string {
  return dateFormat.format(at);
}

const label = (type: 'IN' | 'OUT') => (type === 'IN' ? 'check-in' : 'check-out');

export function linkText(opts: { type: 'IN' | 'OUT'; campusName: string; url: string; ttlMinutes: number }): string {
  return (
    `Open this link to mark your ${label(opts.type)} at ${opts.campusName}:\n${opts.url}\n\n` +
    `The link works once and expires in ${opts.ttlMinutes} minutes. ` +
    'Please allow location and camera access when your phone asks.'
  );
}

export function describePunctuality(punctuality: string, lateMinutes: number | null): string {
  if (punctuality === 'ON_TIME') return 'On time';
  if (punctuality === 'LATE') return lateMinutes ? `Late by ${lateMinutes} min` : 'Late';
  if (punctuality === 'NO_SHIFT') return 'No shift configured';
  return '';
}

export function confirmText(opts: {
  type: 'IN' | 'OUT'; campusName: string; at: Date; punctuality: string; lateMinutes: number | null;
}): string {
  const status = opts.type === 'IN' ? ` Status: ${describePunctuality(opts.punctuality, opts.lateMinutes)}.` : '';
  return `Your ${label(opts.type)} is recorded at ${formatIstTime(opts.at)} on ${formatIstDate(opts.at)} at ${opts.campusName}.${status}`;
}

export function alreadyMarkedText(opts: { type: 'IN' | 'OUT'; at: Date }): string {
  return `You have already marked your ${label(opts.type)} today at ${formatIstTime(opts.at)}.`;
}

/** The exact wording requested for a locked link. */
export function lockedText(): string {
  return 'Your attendance marking was not successful due to location mismatch.';
}

export function noCampusText(): string {
  return 'You are not assigned to a campus for today. Please contact the school administration.';
}

export function needInFirstText(): string {
  return 'No check-in is recorded for you today. Please send IN first, or contact the school administration.';
}

export function helpText(): string {
  return (
    'Available commands:\nIN - mark your check-in\nOUT - mark your check-out\nHELP - show this message\n\n' +
    'LEAVE, PERMISSION and BALANCE are coming soon.'
  );
}

export function comingSoonText(): string {
  return 'This feature is coming soon. For now you can send IN, OUT or HELP.';
}

export function campusChoiceText(type: 'IN' | 'OUT', options: { campusName: string }[]): string {
  const lines = options.map((o, i) => `${i + 1}. ${o.campusName}`).join('\n');
  return `Where are you today? Reply with the number:\n${lines}\n\nFor example: ${type} 1`;
}
