import assert from 'node:assert/strict';
import test from 'node:test';
import { asPoolLike } from './db';
import { getLinkInfo, submitLocation, submitSelfie, type LinkDeps } from './linkService';
import type { SelfieStorage } from './selfieStorage';
import { FakeDb } from './testSupport';
import { generateToken } from './token';
import type { WhatsAppConfig } from './whatsappSender';

const wa: WhatsAppConfig = { mode: 'stub', accessToken: null, phoneNumberId: null, graphVersion: null };
const NOW = new Date('2026-03-02T03:55:00Z'); // 09:25 IST on Monday 2 March 2026

const campusRow = {
  id: 2, code: 'M', name: 'Main', latitude: 17.0, longitude: 78.0,
  geofence_radius_m: 25, required_accuracy_m: null, is_active: true,
};
const tokenRow = (over: Record<string, unknown> = {}) => ({
  id: 'tok1', employee_id: 7, campus_id: 2, event_type: 'IN', work_date: '2026-03-02',
  expires_at: new Date('2026-03-02T04:00:00Z'), location_verified_at: null, used_at: null,
  failed_attempts: 0, locked_at: null, ...over,
});
const contact = { id: 7, employee_code: 'T001', employee_name: 'Asha Rao', whatsapp_e164: '919849136605' };
const shiftRow = {
  id: 1, login_time: '09:00:00', logout_time: '16:00:00', grace_minutes: 10,
  weekdays: [0, 1, 2, 3, 4, 5, 6], effective_from: '2026-01-01',
};
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(3000, 7)]).toString('base64');

interface Overrides {
  token?: Record<string, unknown> | null;
  allowed?: boolean;
  failure?: { failed_attempts: number; locked_at: Date | null } | null;
  verified?: boolean;
  eventInsert?: 'saved' | 'duplicate';
  consume?: number;
  shifts?: unknown[];
  eventByToken?: unknown;
  /** When true no Director WhatsApp number is configured. */
  noDirector?: boolean;
}

function build(over: Overrides = {}) {
  const uploads: { path: string; size: number }[] = [];
  const removed: string[] = [];
  const storage: SelfieStorage = {
    upload: async (path, bytes) => { uploads.push({ path, size: bytes.length }); },
    remove: async path => { removed.push(path); },
    signedUrl: async () => 'https://signed.example/x',
  };
  const db = new FakeDb()
    .on(/from attendance_tokens where token_hash/, { rows: over.token === null ? [] : [over.token ?? tokenRow()] })
    .on(/from campuses where id/, { rows: [campusRow] })
    .on(/from attendance_settings/, {
      rows: over.noDirector ? [] : [{ key: 'director_whatsapp_e164', value: '919000000001' }],
    })
    .on(/from employees e left join attendance_employees/, { rows: [contact] })
    .on(/from employee_campus_assignments a/, {
      rows: over.allowed === false ? [] : [{ campus_id: 2, code: 'M', name: 'Main', kind: 'PRIMARY', mode: 'REPLACE' }],
    })
    .on(/insert into attendance_attempts/, { rowCount: 1 })
    .on(/set location_verified_at/, { rowCount: 1 })
    .on(/set failed_attempts = failed_attempts \+ 1/, { rows: over.failure ? [over.failure] : [] })
    .on(/from attendance_attempts\s+where token_id/, {
      rows: over.verified === false ? [] : [{ reported_lat: 17.0001, reported_lng: 78.0, accuracy_m: 5, distance_m: 11.1 }],
    })
    .on(/from campus_shifts/, { rows: over.shifts ?? [shiftRow] })
    .on(/insert into attendance_events/, over.eventInsert === 'duplicate'
      ? { rows: [] } : { rows: [{ id: 'ev1', server_ts: NOW }] })
    .on(/set used_at/, { rowCount: over.consume ?? 1 })
    .on(/from attendance_events where token_id/, { rows: over.eventByToken ? [over.eventByToken] : [] })
    .on(/insert into attendance_exceptions/, { rows: [{ id: 'x1' }] })
    .on(/insert into notification_outbox/, { rows: [{ id: 'msg' }] })
    .on(/with due as/, { rows: [] });
  const deps: LinkDeps = { pool: asPoolLike(db.asPool()), wa, env: { APP_BASE_URL: 'https://portal.test' }, now: () => NOW, storage };
  return { db, deps, uploads, removed, token: generateToken() };
}

const outboxKinds = (db: FakeDb) => db.where(/insert into notification_outbox/).map(c => String(c.params[5]));
const attemptResults = (db: FakeDb) => db.where(/insert into attendance_attempts/).map(c => String(c.params[7]));

// ── Link information ──────────────────────────────────────────────────────────
test('link info shows only what the page needs, never employee details', async () => {
  const { deps, token } = build();
  const result = await getLinkInfo(deps, token);
  assert.equal(result.http, 200);
  assert.deepEqual(Object.keys(result.body).sort(),
    ['attemptsLeft', 'campusName', 'expiresAt', 'locationVerified', 'ok', 'requiredAccuracyM', 'serverTime', 'state', 'type']);
  assert.equal(result.body.campusName, 'Main');
  assert.equal(result.body.attemptsLeft, 3);
  assert.equal(result.body.requiredAccuracyM, 10);
  assert.ok(!JSON.stringify(result.body).includes('Asha'));
});

test('link info reports not found, expired, used and locked', async () => {
  assert.equal((await getLinkInfo(build().deps, 'short')).http, 404);                       // bad shape
  assert.equal((await getLinkInfo(build({ token: null }).deps, generateToken())).http, 404); // unknown
  const expired = build({ token: tokenRow({ expires_at: new Date('2026-03-02T03:54:00Z') }) });
  assert.deepEqual(await getLinkInfo(expired.deps, expired.token), { http: 410, body: { ok: false, state: 'EXPIRED' } });
  const used = build({ token: tokenRow({ used_at: NOW }) });
  assert.equal((await getLinkInfo(used.deps, used.token)).http, 409);
  const locked = build({ token: tokenRow({ locked_at: NOW }) });
  assert.equal((await getLinkInfo(locked.deps, locked.token)).http, 423);
});

// ── Location step ─────────────────────────────────────────────────────────────
test('a location inside the radius with good accuracy passes and is logged', async () => {
  const { db, deps, token } = build();
  const result = await submitLocation(deps, token, { lat: 17.0001, lng: 78.0, accuracyM: 5 });
  assert.equal(result.http, 200);
  assert.equal(result.body.result, 'PASSED');
  assert.deepEqual(attemptResults(db), ['PASSED']);
  assert.equal(db.where(/set failed_attempts/).length, 0);
});

test('the first failure is counted, logged with coordinates, and raises an exception + Director alert', async () => {
  const { db, deps, token } = build({ failure: { failed_attempts: 1, locked_at: null } });
  const result = await submitLocation(deps, token, { lat: 17.0005, lng: 78.0, accuracyM: 5 }); // ~55 m
  assert.equal(result.http, 422);
  assert.deepEqual(result.body, { ok: false, result: 'OUTSIDE_RADIUS', locked: false, attemptsLeft: 2 });
  const attempt = db.where(/insert into attendance_attempts/)[0];
  assert.equal(attempt.params[3], 17.0005);        // reported latitude kept for audit
  assert.equal(attempt.params[5], 5);              // reported accuracy kept for audit
  assert.equal(attempt.params[7], 'OUTSIDE_RADIUS');
  assert.equal(db.where(/insert into attendance_exceptions/)[0].params[3], 'GPS_OUTSIDE_RADIUS');
  assert.deepEqual(outboxKinds(db), ['DIRECTOR_EXCEPTION']);
});

test('a second failure is counted but does not repeat the alert', async () => {
  const { db, deps, token } = build({ failure: { failed_attempts: 2, locked_at: null } });
  const result = await submitLocation(deps, token, { lat: 17.0005, lng: 78.0, accuracyM: 5 });
  assert.equal(result.body.attemptsLeft, 1);
  assert.equal(db.where(/insert into attendance_exceptions/).length, 0);
  assert.equal(outboxKinds(db).length, 0);
});

test('the third failure locks the link, messages the employee, and alerts the Director', async () => {
  const { db, deps, token } = build({ failure: { failed_attempts: 3, locked_at: NOW } });
  const result = await submitLocation(deps, token, { lat: 17.0005, lng: 78.0, accuracyM: 5 });
  assert.deepEqual(result.body, { ok: false, result: 'OUTSIDE_RADIUS', locked: true, attemptsLeft: 0 });
  assert.equal(db.where(/insert into attendance_exceptions/)[0].params[3], 'TOKEN_LOCKED');
  const messages = db.where(/insert into notification_outbox/).map(c => ({ kind: String(c.params[5]), payload: String(c.params[9]) }));
  assert.deepEqual(messages.map(m => m.kind).sort(), ['DIRECTOR_EXCEPTION', 'TOKEN_LOCKED']);
  assert.ok(messages.find(m => m.kind === 'TOKEN_LOCKED')?.payload.includes(
    'Your attendance marking was not successful due to location mismatch.'));
  // The failure limit comes from the settings (default 3).
  assert.equal(db.where(/set failed_attempts/)[0].params[1], 3);
});

test('poor accuracy is a counted failure even right at the campus', async () => {
  const { db, deps, token } = build({ failure: { failed_attempts: 1, locked_at: null } });
  const result = await submitLocation(deps, token, { lat: 17.0, lng: 78.0, accuracyM: 40 });
  assert.equal(result.body.result, 'POOR_ACCURACY');
  assert.deepEqual(attemptResults(db), ['POOR_ACCURACY']);
  assert.equal(db.where(/insert into attendance_exceptions/)[0].params[3], 'POOR_ACCURACY');
});

test('a missing location is logged but does not count towards the lock', async () => {
  const { db, deps, token } = build();
  const result = await submitLocation(deps, token, { lat: null, lng: null, accuracyM: null });
  assert.equal(result.http, 422);
  assert.equal(result.body.result, 'NO_LOCATION');
  assert.deepEqual(attemptResults(db), ['NO_LOCATION']);
  assert.equal(db.where(/set failed_attempts/).length, 0);
});

test('an employee not assigned to the campus today cannot mark there', async () => {
  const { db, deps, token } = build({ allowed: false });
  const result = await submitLocation(deps, token, { lat: 17.0001, lng: 78.0, accuracyM: 5 });
  assert.equal(result.http, 403);
  assert.equal(result.body.result, 'CAMPUS_NOT_ALLOWED');
  assert.deepEqual(attemptResults(db), ['CAMPUS_NOT_ALLOWED']);
  assert.equal(db.where(/set location_verified_at/).length, 0);
});

test('location checks on a closed link are refused', async () => {
  const locked = build({ token: tokenRow({ locked_at: NOW }) });
  assert.equal((await submitLocation(locked.deps, locked.token, { lat: 17, lng: 78, accuracyM: 5 })).http, 423);
  assert.equal(locked.db.where(/insert into attendance_attempts/).length, 0);
});

// ── Selfie step ───────────────────────────────────────────────────────────────
const verifiedToken = (over: Record<string, unknown> = {}) => tokenRow({ location_verified_at: NOW, ...over });

test('a late check-in is recorded with the server time and shift snapshot, and alerts are queued', async () => {
  const { db, deps, uploads, token } = build({ token: verifiedToken() });
  const result = await submitSelfie(deps, token, { image: jpeg });
  assert.equal(result.http, 200);
  assert.deepEqual(
    [result.body.ok, result.body.duplicate, result.body.type, result.body.time, result.body.punctuality, result.body.lateMinutes],
    [true, false, 'IN', '09:25 AM', 'LATE', 15],
  );

  const insert = db.where(/insert into attendance_events/)[0].params;
  assert.deepEqual(insert.slice(0, 6), [7, 2, 'IN', '2026-03-02', 'LATE', 15]);
  assert.deepEqual(insert.slice(6, 9), ['09:00:00', '16:00:00', 10]);      // shift snapshot
  assert.equal(insert[15], NOW);                                           // server time, not client time
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].path, '2026/03/tok1.jpg');                       // private path, no personal details
  assert.deepEqual(outboxKinds(db).sort(), ['CHECKIN_CONFIRM', 'DIRECTOR_LATE']);
});

test('without a Director number attendance is still recorded and the employee is still confirmed', async () => {
  const { db, deps, token } = build({ token: verifiedToken(), noDirector: true });
  const result = await submitSelfie(deps, token, { image: jpeg });
  assert.equal(result.http, 200);
  assert.deepEqual(outboxKinds(db), ['CHECKIN_CONFIRM']);
});

test('the same shift on time: 09:10 is on time', async () => {
  const early = build({ token: verifiedToken() });
  early.deps.now = () => new Date('2026-03-02T03:40:59Z'); // 09:10:59 IST
  const result = await submitSelfie(early.deps, early.token, { image: jpeg });
  assert.equal(result.body.punctuality, 'ON_TIME');
  assert.deepEqual(outboxKinds(early.db).sort(), ['CHECKIN_CONFIRM', 'DIRECTOR_CHECKIN']);
});

test('OUT is recorded with no late calculation', async () => {
  const { db, deps, token } = build({ token: verifiedToken({ event_type: 'OUT' }) });
  const result = await submitSelfie(deps, token, { image: jpeg });
  assert.equal(result.body.punctuality, 'NOT_APPLICABLE');
  assert.equal(db.where(/from campus_shifts/).length, 0);
  assert.deepEqual(outboxKinds(db).sort(), ['CHECKOUT_CONFIRM', 'DIRECTOR_CHECKOUT']);
});

test('a campus with no shift for the day records NO_SHIFT (never late) and raises an exception', async () => {
  const { db, deps, token } = build({ token: verifiedToken(), shifts: [] });
  const result = await submitSelfie(deps, token, { image: jpeg });
  assert.equal(result.body.punctuality, 'NO_SHIFT');
  assert.equal(db.where(/insert into attendance_exceptions/)[0].params[3], 'NO_SHIFT');
});

test('the selfie step needs the location step first, and a real image', async () => {
  const noLocation = build({ token: tokenRow() });
  assert.deepEqual(await submitSelfie(noLocation.deps, noLocation.token, { image: jpeg }),
    { http: 409, body: { ok: false, state: 'LOCATION_REQUIRED' } });
  assert.equal(noLocation.uploads.length, 0);

  const badImage = build({ token: verifiedToken() });
  assert.deepEqual(await submitSelfie(badImage.deps, badImage.token, { image: 'not an image' }),
    { http: 400, body: { ok: false, state: 'INVALID_IMAGE' } });
  assert.equal(badImage.uploads.length, 0);
});

test('a link opened before midnight cannot record attendance after it', async () => {
  const { deps, token, uploads } = build({ token: verifiedToken({ expires_at: new Date('2026-03-02T19:00:00Z') }) });
  deps.now = () => new Date('2026-03-02T18:35:00Z'); // 00:05 IST on 3 March
  assert.equal((await submitSelfie(deps, token, { image: jpeg })).http, 410);
  assert.equal(uploads.length, 0);
});

test('a second valid event for the day is refused and the stray selfie is removed', async () => {
  const { deps, token, uploads, removed } = build({ token: verifiedToken(), eventInsert: 'duplicate' });
  const result = await submitSelfie(deps, token, { image: jpeg });
  assert.deepEqual(result, { http: 409, body: { ok: false, state: 'ALREADY_MARKED' } });
  assert.deepEqual(removed, uploads.map(u => u.path));
});

test('losing the race for the token rolls back and removes the selfie', async () => {
  const { db, deps, token, removed } = build({ token: verifiedToken(), consume: 0 });
  const result = await submitSelfie(deps, token, { image: jpeg });
  assert.equal(result.http, 409);
  assert.equal(removed.length, 1);
  assert.ok(!db.calls.some(c => c.text === 'commit'));
  assert.equal(outboxKinds(db).length, 0);
});

test('submitting again after success returns the same confirmation, not an error or a second record', async () => {
  const saved = { id: 'ev1', employee_id: 7, campus_id: 2, event_type: 'IN', work_date: '2026-03-02', server_ts: new Date('2026-03-02T03:55:00Z'), punctuality: 'LATE', late_minutes: 15 };
  const { db, deps, token, uploads } = build({ token: verifiedToken({ used_at: NOW }), eventByToken: saved });
  const result = await submitSelfie(deps, token, { image: jpeg });
  assert.equal(result.http, 200);
  assert.equal(result.body.duplicate, true);
  assert.equal(result.body.time, '09:25 AM');
  assert.equal(uploads.length, 0);
  assert.equal(db.where(/insert into attendance_events/).length, 0);
});

test('a failed alert queue rolls back the attendance and removes the selfie', async () => {
  const { db, deps, token, removed } = build({ token: verifiedToken() });
  const original = db.query.bind(db);
  db.query = (async (text: string, params?: unknown[]) => {
    if (/insert into notification_outbox/.test(text)) throw new Error('queue unavailable');
    return original(text, params);
  }) as typeof db.query;
  await assert.rejects(submitSelfie(deps, token, { image: jpeg }), /queue unavailable/);
  assert.equal(removed.length, 1);
  assert.ok(!db.calls.some(c => c.text === 'commit'));
});
