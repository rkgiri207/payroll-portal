/** Plain-language labels and time formatting for the dashboard. All times are shown in India time. */
import type { FeedEvent } from './api';

const TZ = 'Asia/Kolkata';

/** "09:05 AM" in IST. */
export function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString('en-IN', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: true }).replace(/\b(am|pm)\b/, m => m.toUpperCase());
}

/** "02 Mar 2026" in IST. */
export function formatDay(isoOrDate: string): string {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(isoOrDate) ? new Date(`${isoOrDate}T12:00:00+05:30`) : new Date(isoOrDate);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-GB', { timeZone: TZ, day: '2-digit', month: 'short', year: 'numeric' });
}

export type Tone = 'good' | 'warn' | 'bad' | 'neutral';
export interface Label { text: string; tone: Tone }

/** What an IN or OUT means at a glance. */
export function describeEvent(e: Pick<FeedEvent, 'eventType' | 'punctuality' | 'lateMinutes' | 'source'>): Label {
  const manual = e.source === 'MANUAL' ? ' (manual)' : '';
  if (e.eventType === 'OUT') return { text: `Checked out${manual}`, tone: 'neutral' };
  if (e.punctuality === 'LATE') return { text: `Late${e.lateMinutes ? ` by ${e.lateMinutes} min` : ''}${manual}`, tone: 'warn' };
  if (e.punctuality === 'NO_SHIFT') return { text: `No shift set${manual}`, tone: 'warn' };
  return { text: `On time${manual}`, tone: 'good' };
}

export function describeGps(e: Pick<FeedEvent, 'gpsResult' | 'gpsDistanceM'>): Label {
  if (e.gpsResult === 'PASSED') {
    return { text: e.gpsDistanceM === null ? 'Location verified' : `Location verified (${Math.round(e.gpsDistanceM)} m)`, tone: 'good' };
  }
  if (e.gpsResult === 'MANUAL') return { text: 'Recorded manually', tone: 'neutral' };
  return { text: 'Not checked', tone: 'neutral' };
}

/** The state of the Director's WhatsApp alert for an event. */
export function describeAlert(status: string | null): Label {
  switch (status) {
    case 'DELIVERED': return { text: 'Delivered', tone: 'good' };
    case 'READ': return { text: 'Read', tone: 'good' };
    case 'SENT': return { text: 'Sent', tone: 'good' };
    case 'QUEUED': case 'SENDING': return { text: 'Sending…', tone: 'neutral' };
    case 'STUBBED': return { text: 'Test mode (not sent)', tone: 'warn' };
    case 'FAILED': return { text: 'Failed to send', tone: 'bad' };
    case 'CANCELLED': return { text: 'Cancelled', tone: 'neutral' };
    default: return { text: 'No alert', tone: 'neutral' };
  }
}

export function describeReview(status: string): Label {
  switch (status) {
    case 'PENDING': return { text: 'Needs review', tone: 'warn' };
    case 'APPROVED': return { text: 'Approved', tone: 'good' };
    case 'REJECTED': return { text: 'Rejected', tone: 'bad' };
    default: return { text: 'Not required', tone: 'neutral' };
  }
}

const EXCEPTIONS: Record<string, string> = {
  GPS_OUTSIDE_RADIUS: 'Location outside campus',
  POOR_ACCURACY: 'Poor GPS accuracy',
  TOKEN_LOCKED: 'Link locked after failed attempts',
  MISSING_OUT: 'No check-out recorded',
  NO_SHIFT: 'No shift set for this day',
  OUTSIDE_WORKING_DAY: 'Check-in on a non-working day',
  SUSPICIOUS: 'Suspicious submission',
  OTHER: 'Other',
};
export const exceptionLabel = (kind: string): string => EXCEPTIONS[kind] ?? kind;

const ALERT_KINDS: Record<string, string> = {
  LINK: 'Attendance link', CHECKIN_CONFIRM: 'Check-in confirmation', CHECKOUT_CONFIRM: 'Check-out confirmation',
  FAILED_VERIFICATION: 'Failed verification notice', TOKEN_LOCKED: 'Locked link notice', HELP: 'Reply', COMING_SOON: 'Reply',
  CAMPUS_CHOICE: 'Campus question', DIRECTOR_CHECKIN: 'Director: check-in', DIRECTOR_CHECKOUT: 'Director: check-out',
  DIRECTOR_LATE: 'Director: late arrival', DIRECTOR_EXCEPTION: 'Director: exception', DIRECTOR_MISSING_OUT: 'Director: missing check-out',
  DIRECTOR_DIGEST: 'Director: summary',
};
export const alertKindLabel = (kind: string): string => ALERT_KINDS[kind] ?? kind;

/** "just now", "5 min ago", "2 h ago" relative to `now`. */
export function timeAgo(iso: string, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (Number.isNaN(seconds)) return '';
  if (seconds < 45) return 'just now';
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))} min ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} h ago`;
  return `${Math.round(seconds / 86_400)} d ago`;
}

/** IDs of feed events not present in the previous snapshot (used to highlight new arrivals). */
export function newEventIds(previous: FeedEvent[] | undefined, current: FeedEvent[]): Set<string> {
  if (!previous) return new Set();
  const seen = new Set(previous.map(e => e.id));
  return new Set(current.filter(e => !seen.has(e.id)).map(e => e.id));
}
