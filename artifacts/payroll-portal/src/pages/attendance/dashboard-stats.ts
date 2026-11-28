import type { CampusSummary, DayNotice, DaySummary, PermissionToday } from './api';

/** The numbers and wording behind the dashboard cards. Pure, so every rule is easy to check. */

export type SegmentKey = 'onTime' | 'late' | 'unmarked' | 'onLeave';
export interface Segment { key: SegmentKey; label: string; value: number; percent: number }

const LABELS: Record<SegmentKey, string> = { onTime: 'On time', late: 'Late', unmarked: 'Not checked in yet', onLeave: 'On leave' };

/**
 * Everyone, split four ways, for the one-line bar: on time, late, not checked in yet, on leave.
 * The percentages always add up to 100 (the last non-empty segment takes the rounding).
 */
export function attendanceSegments(s: Pick<DaySummary, 'present' | 'late' | 'unmarked' | 'onLeave'>): { segments: Segment[]; total: number } {
  const values: Record<SegmentKey, number> = {
    onTime: Math.max(s.present - s.late, 0), late: s.late, unmarked: s.unmarked, onLeave: s.onLeave,
  };
  const total = values.onTime + values.late + values.unmarked + values.onLeave;
  const order: SegmentKey[] = ['onTime', 'late', 'unmarked', 'onLeave'];
  const percents = order.map(k => (total === 0 ? 0 : Math.round((values[k] / total) * 100)));
  if (total > 0) {
    const drift = 100 - percents.reduce((a, b) => a + b, 0);
    const last = order.map((k, i) => (values[k] > 0 ? i : -1)).filter(i => i >= 0).pop();
    if (last !== undefined) percents[last] += drift;
  }
  return { total, segments: order.map((key, i) => ({ key, label: LABELS[key], value: values[key], percent: percents[i] })) };
}

/** Of the people expected today, the percentage who have checked in. null when nobody is expected. */
export function checkInRate(s: Pick<DaySummary, 'expected' | 'present'>): number | null {
  return s.expected === 0 ? null : Math.min(100, Math.round((s.present / s.expected) * 100));
}

export type Tone = 'good' | 'warn' | 'bad' | 'info' | 'neutral';

/** The tone of the headline percentage: calm when most are in, a warning when many are missing. */
export function rateTone(rate: number | null): Tone {
  if (rate === null) return 'neutral';
  return rate >= 90 ? 'good' : rate >= 60 ? 'warn' : 'bad';
}

export interface Notice { tone: Tone; title: string; body: string }

/**
 * A banner for a day that is not a normal working day, from the confirmed calendar. With no calendar
 * entry but nobody expected, say so, so an empty dashboard is never a mystery.
 */
export function noticeFor(notice: DayNotice | null, s: Pick<DaySummary, 'expected' | 'onLeave'>): Notice | null {
  if (notice) {
    switch (notice.kind) {
      case 'HOLIDAY': return { tone: 'info', title: `Holiday: ${notice.name}`, body: 'Nobody is expected to check in today.' };
      case 'WEEKLY_OFF': return { tone: 'info', title: `Weekly off: ${notice.name}`, body: 'Nobody is expected to check in today.' };
      case 'VACATION': return { tone: 'info', title: `School vacation: ${notice.name}`, body: 'Only staff marked "reports during vacations" are expected.' };
      case 'SPECIAL_WORKING_DAY': return { tone: 'warn', title: `Special working day: ${notice.name}`, body: 'Everyone is expected today, even if it is normally a day off.' };
      case 'OPTIONAL': return { tone: 'neutral', title: `Optional holiday: ${notice.name}`, body: 'The school is open. Staff may take it as leave.' };
    }
  }
  if (s.expected === 0 && s.onLeave === 0) {
    return { tone: 'neutral', title: 'No shifts today', body: 'No campus has a shift running today, so nobody is expected.' };
  }
  return null;
}

/** How many things need the Director's attention right now, and a calm message when none do. */
export interface Attention { leave: number; permission: number; review: number; exceptions: number; failedAlerts: number }
export const attentionTotal = (a: Attention): number => a.leave + a.permission + a.review + a.exceptions + a.failedAlerts;

export const percentOf = (value: number, of: number): number => (of === 0 ? 0 : Math.round((value / of) * 100));

/** A campus's headline: how many of those expected are in. */
export function campusRate(c: Pick<CampusSummary, 'expected' | 'present'>): number | null {
  return checkInRate(c);
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Wed" for a YYYY-MM-DD date, in any time zone. */
export const weekdayShort = (date: string): string => WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()];
/** "09 Sep". */
export const dayMonth = (date: string): string => `${date.slice(8, 10)} ${MONTHS[Number(date.slice(5, 7)) - 1]}`;

/** "10:00 AM". */
export function clock(time: string): string {
  const [h, m] = time.split(':').map(Number);
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}
export const permissionRange = (p: Pick<PermissionToday, 'startTime' | 'endTime'>): string => `${clock(p.startTime)} to ${clock(p.endTime)}`;

/** Is a permission going on right now? `nowMinutes` is minutes since midnight in India time. */
export function permissionActive(p: Pick<PermissionToday, 'startTime' | 'endTime'>, nowMinutes: number): boolean {
  const [sh, sm] = p.startTime.split(':').map(Number);
  const [eh, em] = p.endTime.split(':').map(Number);
  return nowMinutes >= sh * 60 + sm && nowMinutes < eh * 60 + em;
}

/** "Leave to approve" etc. with the right singular or plural. */
export const countLabel = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** Minutes since midnight in India time for an ISO timestamp (used to tell who is on permission right now). */
export function istMinutes(iso: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(iso));
  const get = (type: string) => Number(parts.find(p => p.type === type)?.value ?? 0);
  return get('hour') * 60 + get('minute');
}
