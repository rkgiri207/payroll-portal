import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { closedStateOf, loadLink, sendLocation, sendSelfie, type LinkInfo } from './api';
import { ScreenView, type Handlers, type Screen } from './AttendanceLinkPage';
import {
  alreadyMarkedCopy, cameraErrorCopy, closedCopy, formatCountdown, geolocationErrorCopy,
  locationFailureCopy, successCopy,
} from './copy';

// ── Mocked network ────────────────────────────────────────────────────────────
interface Recorded { url: string; init: RequestInit }
function mockFetch(status: number, body: unknown): Recorded[] {
  const calls: Recorded[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return calls;
}
function offline(): void {
  globalThis.fetch = (async () => { throw new TypeError('Failed to fetch'); }) as typeof fetch;
}

const TOKEN = 'A'.repeat(43);

// ── Messages ──────────────────────────────────────────────────────────────────
test('every closed state has a clear message; a locked link uses the exact wording', () => {
  for (const state of ['NOT_FOUND', 'EXPIRED', 'USED', 'LOCKED', 'UNAVAILABLE'] as const) {
    const m = closedCopy(state);
    assert.ok(m.title && m.body, state);
  }
  assert.match(closedCopy('LOCKED').body, /Your attendance marking was not successful due to location mismatch\./);
  assert.match(closedCopy('EXPIRED').body, /Send IN or OUT again on WhatsApp/);
});

test('location problems explain what to do, show attempts, and never blame the employee', () => {
  const outside = locationFailureCopy('OUTSIDE_RADIUS', { attemptsLeft: 2, requiredAccuracyM: 10, locked: false });
  assert.match(outside.body, /Attempts left: 2\./);
  const poor = locationFailureCopy('POOR_ACCURACY', { attemptsLeft: 1, requiredAccuracyM: 10, locked: false, reportedAccuracyM: 38.4 });
  assert.match(poor.body, /within 10 metres/);
  assert.match(poor.body, /about 38 metres/);
  assert.match(poor.body, /Precise Location/);
  assert.equal(locationFailureCopy('OUTSIDE_RADIUS', { attemptsLeft: 0, requiredAccuracyM: 10, locked: true }).title, closedCopy('LOCKED').title);
  assert.match(locationFailureCopy('CAMPUS_NOT_ALLOWED', { attemptsLeft: null, requiredAccuracyM: 10, locked: false }).title, /not assigned/);
});

test('permission and device problems have step-by-step help for iPhone and Android', () => {
  assert.match(geolocationErrorCopy(1).body, /iPhone: Settings/);
  assert.match(geolocationErrorCopy(1).body, /Android: tap the lock icon/);
  assert.match(geolocationErrorCopy(3).title, /too long/);
  assert.ok(geolocationErrorCopy(null).title);
  assert.match(cameraErrorCopy('NotAllowedError').body, /contact the school administration/);
  assert.match(cameraErrorCopy('NotFoundError').title, /No front camera/);
  assert.ok(cameraErrorCopy('SomethingElse').title);
});

test('the confirmation shows time, place and status', () => {
  const late = successCopy({ type: 'IN', campusName: 'Main', time: '09:25 AM', date: '02 Mar 2026', punctuality: 'LATE', lateMinutes: 15, duplicate: false });
  assert.equal(late.title, 'Your check-in is recorded');
  assert.match(late.body, /09:25 AM on 02 Mar 2026 at Main\. You are late by 15 minutes\./);
  const onTime = successCopy({ type: 'IN', campusName: 'Main', time: '09:05 AM', date: '02 Mar 2026', punctuality: 'ON_TIME', lateMinutes: null, duplicate: false });
  assert.match(onTime.body, /You are on time\./);
  const out = successCopy({ type: 'OUT', campusName: 'Main', time: '04:02 PM', date: '02 Mar 2026', punctuality: 'NOT_APPLICABLE', lateMinutes: null, duplicate: false });
  assert.equal(out.title, 'Your check-out is recorded');
  assert.ok(!/late|on time/i.test(out.body));
  assert.equal(successCopy({ ...{ type: 'IN' as const, campusName: 'M', time: 't', date: 'd', punctuality: 'ON_TIME', lateMinutes: null }, duplicate: true }).title, 'Your check-in was already recorded');
  assert.ok(alreadyMarkedCopy().title);
});

test('countdown formatting', () => {
  assert.equal(formatCountdown(187), '3:07');
  assert.equal(formatCountdown(60), '1:00');
  assert.equal(formatCountdown(5), '0:05');
  assert.equal(formatCountdown(-4), '0:00');
});

// ── API client ────────────────────────────────────────────────────────────────
test('loading a link reads the type, campus and a countdown based on the SERVER clock', async () => {
  const serverNow = '2026-03-02T03:55:00.000Z';
  const calls = mockFetch(200, {
    ok: true, state: 'OK', type: 'IN', campusName: 'Main', expiresAt: '2026-03-02T04:00:00.000Z',
    serverTime: serverNow, locationVerified: false, attemptsLeft: 3, requiredAccuracyM: 10,
  });
  const before = Date.now();
  const outcome = await loadLink(TOKEN);
  assert.equal(outcome.kind, 'open');
  if (outcome.kind !== 'open') return;
  assert.equal(outcome.info.type, 'IN');
  assert.equal(outcome.info.campusName, 'Main');
  // Five minutes from now on THIS device, whatever the device clock says.
  const remaining = outcome.info.expiresAt - before;
  assert.ok(remaining > 299_000 && remaining < 302_000, String(remaining));
  // No cookies, no caching, no referrer: the token stays private.
  assert.equal(calls[0].init.credentials, 'omit');
  assert.equal(calls[0].init.cache, 'no-store');
  assert.equal(calls[0].init.referrerPolicy, 'no-referrer');
  assert.equal(calls[0].url, `/api/attendance/link/${TOKEN}`);
});

test('closed links and outages map to the right state', async () => {
  for (const [status, body, expected] of [
    [410, { ok: false, state: 'EXPIRED' }, 'EXPIRED'],
    [409, { ok: false, state: 'USED' }, 'USED'],
    [423, { ok: false, state: 'LOCKED' }, 'LOCKED'],
    [404, { ok: false, state: 'NOT_FOUND' }, 'NOT_FOUND'],
    [404, { error: 'Not found' }, 'UNAVAILABLE'],       // attendance switched off on the server
  ] as const) {
    mockFetch(status, body);
    assert.deepEqual(await loadLink(TOKEN), { kind: 'closed', state: expected });
  }
  offline();
  assert.deepEqual(await loadLink(TOKEN), { kind: 'error' });
  mockFetch(500, { ok: false, error: 'Something went wrong' });
  assert.deepEqual(await loadLink(TOKEN), { kind: 'error' });
});

test('closedStateOf ignores ordinary successes and failures', () => {
  assert.equal(closedStateOf({ status: 200, body: { ok: true } }), null);
  assert.equal(closedStateOf({ status: 422, body: { result: 'OUTSIDE_RADIUS' } }), null);
});

test('sending a location posts coordinates once and reads the verdict', async () => {
  const calls = mockFetch(200, { ok: true, result: 'PASSED', boundary: false });
  assert.deepEqual(await sendLocation(TOKEN, { lat: 17.0001, lng: 78, accuracyM: 5 }), { kind: 'passed' });
  assert.equal(calls[0].url, `/api/attendance/link/${TOKEN}/location`);
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { lat: 17.0001, lng: 78, accuracyM: 5 });

  mockFetch(422, { ok: false, result: 'POOR_ACCURACY', locked: false, attemptsLeft: 2 });
  assert.deepEqual(await sendLocation(TOKEN, { lat: 17, lng: 78, accuracyM: 40 }),
    { kind: 'failed', result: 'POOR_ACCURACY', locked: false, attemptsLeft: 2 });

  mockFetch(422, { ok: false, result: 'OUTSIDE_RADIUS', locked: true, attemptsLeft: 0 });
  assert.deepEqual(await sendLocation(TOKEN, { lat: 17, lng: 78, accuracyM: 5 }),
    { kind: 'failed', result: 'OUTSIDE_RADIUS', locked: true, attemptsLeft: 0 });

  mockFetch(403, { ok: false, result: 'CAMPUS_NOT_ALLOWED' });
  assert.equal((await sendLocation(TOKEN, { lat: 17, lng: 78, accuracyM: 5 })).kind, 'failed');
  mockFetch(423, { ok: false, state: 'LOCKED' });
  assert.deepEqual(await sendLocation(TOKEN, { lat: 17, lng: 78, accuracyM: 5 }), { kind: 'closed', state: 'LOCKED' });
  offline();
  assert.deepEqual(await sendLocation(TOKEN, { lat: null, lng: null, accuracyM: null }), { kind: 'error' });
});

test('sending the selfie reads the confirmation and every refusal', async () => {
  mockFetch(200, { ok: true, duplicate: false, type: 'IN', campusName: 'Main', time: '09:25 AM', date: '02 Mar 2026', punctuality: 'LATE', lateMinutes: 15 });
  const done = await sendSelfie(TOKEN, 'data:image/jpeg;base64,xyz');
  assert.deepEqual(done, { kind: 'done', confirmation: { type: 'IN', campusName: 'Main', time: '09:25 AM', date: '02 Mar 2026', punctuality: 'LATE', lateMinutes: 15, duplicate: false } });

  mockFetch(409, { ok: false, state: 'ALREADY_MARKED' });
  assert.deepEqual(await sendSelfie(TOKEN, 'x'), { kind: 'already' });
  mockFetch(409, { ok: false, state: 'LOCATION_REQUIRED' });
  assert.deepEqual(await sendSelfie(TOKEN, 'x'), { kind: 'needLocation' });
  mockFetch(400, { ok: false, state: 'INVALID_IMAGE' });
  assert.deepEqual(await sendSelfie(TOKEN, 'x'), { kind: 'badImage' });
  mockFetch(410, { ok: false, state: 'EXPIRED' });
  assert.deepEqual(await sendSelfie(TOKEN, 'x'), { kind: 'closed', state: 'EXPIRED' });
  offline();
  assert.deepEqual(await sendSelfie(TOKEN, 'x'), { kind: 'error' });
});

// ── Every screen renders ──────────────────────────────────────────────────────
const handlers: Handlers = { onCheckLocation() {}, onTakePhoto() {}, onRetake() {}, onSubmit() {}, onRetry() {} };
const info: LinkInfo = { type: 'IN', campusName: 'Main Campus', expiresAt: Date.now() + 240_000, locationVerified: false, attemptsLeft: 3, requiredAccuracyM: 10 };
const html = (screen: Screen, secondsLeft = 227) => renderToStaticMarkup(<ScreenView screen={screen} secondsLeft={secondsLeft} handlers={handlers} />);

test('loading, closed, error and done screens', () => {
  assert.match(html({ name: 'loading' }), /Checking your link/);
  const closed = html({ name: 'closed', message: closedCopy('EXPIRED') });
  assert.match(closed, /This link has expired/);
  assert.ok(!/<button/.test(closed));                        // nothing to press on a dead link
  const error = html({ name: 'error', message: { title: 'Could not reach the server', body: 'Check your connection.' } });
  assert.match(error, /Try again/);
  assert.match(html({ name: 'done', message: { title: 'Your check-in is recorded', body: '09:05 AM on 02 Mar 2026 at Main. You are on time.' } }), /Your check-in is recorded/);
});

test('location screen: instructions, countdown, busy state and problems', () => {
  const idle = html({ name: 'location', info, busy: false, problem: null });
  assert.match(idle, /Step 1 of 2/);
  assert.match(idle, /Mark your check-in/);
  assert.match(idle, /Main Campus/);
  assert.match(idle, /Check my location/);
  assert.match(idle, /This link expires in 3:47/);
  assert.match(idle, /you are not tracked/);
  assert.ok(!/role="alert"/.test(idle));

  const busy = html({ name: 'location', info, busy: true, problem: null });
  assert.match(busy, /Checking your location…/);
  assert.match(busy, /disabled/);

  const problem = html({ name: 'location', info, busy: false, problem: locationFailureCopy('OUTSIDE_RADIUS', { attemptsLeft: 2, requiredAccuracyM: 10, locked: false }) });
  assert.match(problem, /role="alert"/);
  assert.match(problem, /outside the campus/);

  assert.match(html({ name: 'location', info, busy: false, problem: null }, 0), /may have expired/);
  assert.match(html({ name: 'location', info: { ...info, type: 'OUT' }, busy: false, problem: null }), /Mark your check-out/);
});

test('selfie screen: each camera phase, with no way to pick a photo from the gallery', () => {
  const base = { name: 'selfie' as const, info, image: null, problem: null, cameraBlocked: false };
  const starting = html({ ...base, phase: 'starting' });
  assert.match(starting, /Step 2 of 2/);
  assert.match(starting, /Starting the camera/);
  assert.match(starting, /<video/);
  assert.match(starting, /playsinline/i);
  assert.match(starting, /never sent on WhatsApp/);

  const live = html({ ...base, phase: 'live' });
  assert.match(live, /Take photo/);

  const preview = html({ ...base, phase: 'preview', image: 'data:image/jpeg;base64,AAAA' });
  assert.match(preview, /<img[^>]+Your selfie/);
  assert.match(preview, /Retake/);
  assert.match(preview, /Submit check-in/);
  assert.ok(!/<video/.test(preview));

  const sending = html({ ...base, phase: 'sending', image: 'data:image/jpeg;base64,AAAA' });
  assert.match(sending, /Sending…/);
  assert.match(sending, /disabled/);

  const blocked = html({ ...base, phase: 'starting', cameraBlocked: true, problem: cameraErrorCopy('NotAllowedError') });
  assert.match(blocked, /Try the camera again/);
  assert.match(blocked, /camera is switched off/);
  assert.ok(!/Starting the camera/.test(blocked));

  for (const markup of [starting, live, preview, sending, blocked, idleLocation()]) {
    assert.ok(!/type="file"/.test(markup), 'no gallery upload');
    assert.ok(!/capture=/.test(markup));
  }
});

function idleLocation(): string {
  return html({ name: 'location', info, busy: false, problem: null });
}
