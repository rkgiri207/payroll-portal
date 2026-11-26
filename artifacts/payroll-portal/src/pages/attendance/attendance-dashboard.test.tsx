import assert from 'node:assert/strict';
import test from 'node:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { Router } from 'wouter';
import type { Dashboard, EmployeeProfile, ExceptionRow, FeedEvent, UnmarkedEmployee } from './api';
import { DashboardView } from './dashboard';
import {
  alertKindLabel, describeAlert, describeEvent, describeGps, describeReview, exceptionLabel, formatDay, formatTime,
  newEventIds, timeAgo,
} from './dashboard-helpers';
import { ProfileView } from './employee-profile';
import { keys } from './use-attendance';

// ── Labels and times ──────────────────────────────────────────────────────────
test('times and days are shown in India time', () => {
  assert.equal(formatTime('2026-03-02T03:35:00Z'), '09:05 AM');
  assert.equal(formatTime('2026-03-02T10:30:00Z'), '04:00 PM');
  assert.equal(formatTime('nonsense'), '—');
  assert.equal(formatDay('2026-03-02'), '02 Mar 2026');
  assert.equal(formatDay('2026-03-01T19:00:00Z'), '02 Mar 2026');   // already 2 March in IST
});

test('relative times', () => {
  const now = Date.parse('2026-03-02T05:00:00Z');
  assert.equal(timeAgo('2026-03-02T04:59:40Z', now), 'just now');
  assert.equal(timeAgo('2026-03-02T04:55:00Z', now), '5 min ago');
  assert.equal(timeAgo('2026-03-02T02:00:00Z', now), '3 h ago');
  assert.equal(timeAgo('2026-02-28T05:00:00Z', now), '2 d ago');
});

test('an event reads at a glance: on time, late, no shift, out, manual', () => {
  assert.deepEqual(describeEvent({ eventType: 'IN', punctuality: 'ON_TIME', lateMinutes: null, source: 'WHATSAPP_LINK' }), { text: 'On time', tone: 'good' });
  assert.deepEqual(describeEvent({ eventType: 'IN', punctuality: 'LATE', lateMinutes: 15, source: 'WHATSAPP_LINK' }), { text: 'Late by 15 min', tone: 'warn' });
  assert.equal(describeEvent({ eventType: 'IN', punctuality: 'NO_SHIFT', lateMinutes: null, source: 'WHATSAPP_LINK' }).text, 'No shift set');
  assert.deepEqual(describeEvent({ eventType: 'OUT', punctuality: 'NOT_APPLICABLE', lateMinutes: null, source: 'WHATSAPP_LINK' }), { text: 'Checked out', tone: 'neutral' });
  assert.equal(describeEvent({ eventType: 'IN', punctuality: 'ON_TIME', lateMinutes: null, source: 'MANUAL' }).text, 'On time (manual)');
});

test('location, alert and review labels', () => {
  assert.equal(describeGps({ gpsResult: 'PASSED', gpsDistanceM: 11.4 }).text, 'Location verified (11 m)');
  assert.equal(describeGps({ gpsResult: 'MANUAL', gpsDistanceM: null }).text, 'Recorded manually');
  assert.equal(describeGps({ gpsResult: null, gpsDistanceM: null }).text, 'Not checked');

  assert.deepEqual(describeAlert('DELIVERED'), { text: 'Delivered', tone: 'good' });
  assert.deepEqual(describeAlert('FAILED'), { text: 'Failed to send', tone: 'bad' });
  assert.deepEqual(describeAlert('STUBBED'), { text: 'Test mode (not sent)', tone: 'warn' });
  assert.equal(describeAlert('QUEUED').text, 'Sending…');
  assert.equal(describeAlert(null).text, 'No alert');

  assert.deepEqual(describeReview('PENDING'), { text: 'Needs review', tone: 'warn' });
  assert.equal(describeReview('APPROVED').tone, 'good');
  assert.equal(describeReview('REJECTED').tone, 'bad');
  assert.equal(describeReview('NOT_REQUIRED').text, 'Not required');

  assert.equal(exceptionLabel('MISSING_OUT'), 'No check-out recorded');
  assert.equal(exceptionLabel('UNKNOWN_KIND'), 'UNKNOWN_KIND');
  assert.equal(alertKindLabel('DIRECTOR_LATE'), 'Director: late arrival');
});

test('new arrivals are found by comparing with the previous update', () => {
  const ev = (id: string) => ({ id }) as FeedEvent;
  assert.deepEqual([...newEventIds(undefined, [ev('a')])], []);              // first load: nothing is "new"
  assert.deepEqual([...newEventIds([ev('a')], [ev('b'), ev('a')])], ['b']);
  assert.deepEqual([...newEventIds([ev('a')], [ev('a')])], []);
});

// ── Sample data ───────────────────────────────────────────────────────────────
const event = (over: Partial<FeedEvent>): FeedEvent => ({
  id: 'e1', eventType: 'IN', serverTs: '2026-03-02T03:55:00Z', punctuality: 'LATE', lateMinutes: 15, reviewStatus: 'PENDING',
  gpsResult: 'PASSED', gpsDistanceM: 11.1, hasSelfie: true, source: 'WHATSAPP_LINK', employeeId: 7, employeeCode: 'T001',
  employeeName: 'Asha Rao', campusName: 'Main Campus', directorAlert: 'DELIVERED', ...over,
});

const data = (over: Partial<Dashboard> = {}): Dashboard => ({
  workDate: '2026-03-02', serverTime: '2026-03-02T05:30:00Z', alertMode: 'individual',
  summary: { expected: 50, present: 41, late: 3, unmarked: 9, openExceptions: 2, pendingReview: 4 },
  campuses: [
    { campusId: 1, campusName: 'Main Campus', expected: 30, present: 27, late: 2, unmarked: 3 },
    { campusId: 2, campusName: 'North Campus', expected: 20, present: 14, late: 1, unmarked: 6 },
  ],
  feed: [
    event({ id: 'e1' }),
    event({ id: 'e2', employeeId: 8, employeeName: 'Ravi Kumar', employeeCode: 'T002', punctuality: 'ON_TIME', lateMinutes: null, hasSelfie: false, directorAlert: 'FAILED', campusName: 'North Campus' }),
    event({ id: 'e3', eventType: 'OUT', employeeId: 9, employeeName: 'Meena Iyer', employeeCode: 'T003', punctuality: 'NOT_APPLICABLE', lateMinutes: null, directorAlert: 'STUBBED' }),
  ],
  alertProblems: [
    { id: 'm1', kind: 'DIRECTOR_CHECKIN', status: 'FAILED', recipientType: 'DIRECTOR', employeeName: 'Ravi Kumar', lastError: '131047: Re-engagement message', attempts: 5, createdAt: '2026-03-02T03:56:00Z' },
    { id: 'm2', kind: 'CHECKIN_CONFIRM', status: 'QUEUED', recipientType: 'EMPLOYEE', employeeName: 'Asha Rao', lastError: 'Could not reach WhatsApp', attempts: 2, createdAt: '2026-03-02T03:57:00Z' },
  ],
  warnings: ["The Director's WhatsApp number is not set, so no alerts are being sent to the Director."], ...over,
});

function render(node: React.ReactElement, preload: (c: QueryClient) => void = () => {}): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  preload(client);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}><Router ssrPath="/attendance">{node}</Router></QueryClientProvider>,
  );
}
const view = (d: Dashboard, tab: 'feed' | 'unmarked' | 'exceptions' | 'review' | 'alerts' = 'feed', fresh = new Set<string>(), preload?: (c: QueryClient) => void) =>
  render(<DashboardView data={d} fresh={fresh} tab={tab} onTab={() => {}} />, preload);

// ── The dashboard ─────────────────────────────────────────────────────────────
test('summary tiles show today\'s numbers', () => {
  const html = view(data());
  for (const [label, value] of [['Expected', 50], ['Present', 41], ['Late', 3], ['Unmarked', 9], ['Needs review', 4], ['Open exceptions', 2]] as const) {
    assert.match(html, new RegExp(`data-testid="tile-${label.toLowerCase().replace(/\s+/g, '-')}"[^>]*>[\\s\\S]*?${label}[\\s\\S]*?>${value}<`), label);
  }
});

test('warnings appear with a link to setup', () => {
  const html = view(data());
  assert.match(html, /data-testid="warnings"/);
  assert.match(html, /Director&#x27;s WhatsApp number is not set|Director's WhatsApp number is not set/);
  assert.match(html, /href="\/attendance\/setup"/);
  assert.ok(!/data-testid="warnings"/.test(view(data({ warnings: [] }))));
});

test('campus-wise counts', () => {
  const html = view(data());
  assert.equal((html.match(/data-testid="campus-row"/g) ?? []).length, 2);
  assert.match(html, /Main Campus[\s\S]*?>30<[\s\S]*?>27<[\s\S]*?>2<[\s\S]*?>3</);
  assert.ok(!/By campus/.test(view(data({ campuses: [] }))));
});

test('live feed: clickable names, status, location, alert state, and selfie only when one exists', () => {
  const html = view(data());
  assert.equal((html.match(/data-testid="feed-row"/g) ?? []).length, 3);
  assert.match(html, /href="\/attendance\/employees\/7"[^>]*>Asha Rao</);       // name opens the employee profile
  assert.match(html, /href="\/attendance\/employees\/8"[^>]*>Ravi Kumar</);
  assert.match(html, /09:25 AM/);                                               // 03:55 UTC
  assert.match(html, /Late by 15 min/);
  assert.match(html, /On time/);
  assert.match(html, /Checked out/);
  assert.match(html, /Location verified \(11 m\)/);
  assert.match(html, /Delivered/);
  assert.match(html, /Failed to send/);                                         // a failed alert is visible in the feed
  assert.match(html, /Test mode \(not sent\)/);
  assert.match(html, /Needs review/);
  assert.equal((html.match(/View selfie of/g) ?? []).length, 2);                 // e2 has none
  assert.ok(!/View selfie of Ravi Kumar/.test(html));
});

test('a new arrival is highlighted', () => {
  const html = view(data(), 'feed', new Set(['e2']));
  assert.equal((html.match(/bg-primary\/10/g) ?? []).length, 1);                       // exactly one row
  const highlighted = /<tr[^>]*bg-primary\/10[^>]*>[\s\S]*?<\/tr>/.exec(html)?.[0] ?? '';
  assert.match(highlighted, /Ravi Kumar/);                                              // and it is the new one
  assert.ok(!/bg-primary\/10/.test(view(data(), 'feed', new Set())));
});

test('an empty day says so', () => {
  assert.match(view(data({ feed: [], summary: { expected: 0, present: 0, late: 0, unmarked: 0, openExceptions: 0, pendingReview: 0 }, warnings: [] })), /No attendance recorded yet today/);
});

test('tab labels carry the counts, and failed alerts are called out', () => {
  const html = view(data());
  assert.match(html, />Unmarked \(9\)</);
  assert.match(html, />Exceptions \(2\)</);
  assert.match(html, />Needs review \(4\)</);
  assert.match(html, /Alert problems \(2\)/);
  assert.match(html, /1 failed/);
});

test('alert problems tab shows failures and retries with plain reasons', () => {
  const html = view(data(), 'alerts');
  assert.equal((html.match(/data-testid="alert-problem-row"/g) ?? []).length, 2);
  assert.match(html, /Director: check-in/);
  assert.match(html, /131047: Re-engagement message/);
  assert.match(html, /Retrying \(2\)/);
  assert.match(html, /never lost/);
  assert.match(view(data({ alertProblems: [] }), 'alerts'), /No WhatsApp alert problems/);
});

test('unmarked tab lists people and explains it is not an absence', () => {
  const unmarked: UnmarkedEmployee[] = [{ employeeId: 11, employeeCode: 'T010', employeeName: 'Kiran Shah', campusName: 'North Campus' }];
  const html = view(data(), 'unmarked', new Set(), c => c.setQueryData(keys.unmarked, { workDate: '2026-03-02', unmarked }));
  assert.match(html, /Kiran Shah/);
  assert.match(html, /href="\/attendance\/employees\/11"/);
  assert.match(html, /not an absence/);
  assert.match(view(data(), 'unmarked', new Set(), c => c.setQueryData(keys.unmarked, { workDate: '2026-03-02', unmarked: [] })), /Nobody is unmarked/);
});

test('exceptions tab lists open issues with a review button', () => {
  const exceptions: ExceptionRow[] = [{
    id: 'x1', employeeId: 7, employeeCode: 'T001', employeeName: 'Asha Rao', campusId: 1, campusName: 'Main Campus',
    workDate: '2026-03-01', kind: 'MISSING_OUT', detail: 'No check-out recorded (shift ends 16:00)', status: 'OPEN', createdAt: '2026-03-01T12:00:00Z',
  }];
  const html = view(data(), 'exceptions', new Set(), c => c.setQueryData(keys.exceptions, { exceptions }));
  assert.match(html, /No check-out recorded/);
  assert.match(html, /shift ends 16:00/);
  assert.match(html, /01 Mar 2026/);
  assert.match(html, />Review</);
  assert.match(view(data(), 'exceptions', new Set(), c => c.setQueryData(keys.exceptions, { exceptions: [] })), /No open exceptions/);
});

test('review tab offers approve and reject, and a selfie button when one exists', () => {
  const html = view(data(), 'review', new Set(), c => c.setQueryData(keys.pending, { events: [event({ id: 'e1' }), event({ id: 'e2', hasSelfie: false, employeeName: 'Ravi Kumar', employeeId: 8 })] }));
  assert.equal((html.match(/data-testid="pending-row"/g) ?? []).length, 2);
  assert.equal((html.match(/Approve/g) ?? []).length, 2);                               // one per row
  assert.equal((html.match(/Reject/g) ?? []).length, 2);
  assert.equal((html.match(/View selfie of/g) ?? []).length, 1);
  assert.match(html, /Selfies are for review only/);
  assert.match(view(data(), 'review', new Set(), c => c.setQueryData(keys.pending, { events: [] })), /Nothing is waiting for review/);
});

test('a dashboard in digest mode explains it is quieter on WhatsApp only', () => {
  // The note lives on the page; the view itself stays the same in every mode.
  assert.match(view(data({ alertMode: 'digest' })), /Live feed/);
});

// ── Employee profile (basic) ──────────────────────────────────────────────────
test('the employee profile shows registration, campuses and recent attendance, without selfies', () => {
  const profile: EmployeeProfile = {
    employee: { id: 7, employeeCode: 'T001', employeeName: 'Asha Rao', designation: 'Teacher', branch: 'Main', status: 'ACTIVE' },
    registration: { whatsapp: '********6605', attendanceApplicable: true },
    assignments: [
      { id: 1, employeeId: 7, campusId: 1, campusName: 'Main Campus', kind: 'PRIMARY', mode: 'REPLACE', startDate: '2026-01-05', endDate: null, note: null },
      { id: 2, employeeId: 7, campusId: 2, campusName: 'North Campus', kind: 'TEMPORARY', mode: 'ADDITIONAL', startDate: '2026-03-02', endDate: '2026-03-06', note: 'exam duty' },
    ],
    recentEvents: [event({ id: 'e1' })],
  };
  const html = render(<ProfileView profile={profile} />);
  assert.match(html, /Asha Rao/);
  assert.match(html, /T001 · Teacher · Main/);
  assert.match(html, /\*{8}6605/);                    // masked number
  assert.match(html, /Main Campus/);
  assert.match(html, /Temporary/);
  assert.match(html, /05 Jan 2026/);
  assert.match(html, /later phase/);
  assert.ok(!/View selfie/.test(html));                // selfies are never on the ordinary profile
  assert.match(render(<ProfileView profile={{ ...profile, assignments: [], registration: null, recentEvents: [] }} />), /Not registered[\s\S]*No campus assigned[\s\S]*No attendance recorded yet/);
});
