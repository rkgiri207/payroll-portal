import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveAllowedCampuses, type CampusOption } from './campusData';
import { withTransaction, AbortTransaction } from './db';
import { FakeDb } from './testSupport';
import { recordAttendanceEvent, type NewAttendanceEvent } from './eventStore';
import { writeAudit } from './auditStore';
import { backoffSeconds, enqueueMessage, markSendFailure } from './outboxStore';
import { parseSettings, SETTING_DEFAULTS, validateSettingValue } from './settings';
import { consumeToken, createToken, registerFailedAttempt, tokenState, type TokenRecord } from './tokenStore';
import { hashToken } from './token';
import { claimWebhookEvent } from './webhookStore';


// ── Transactions ──────────────────────────────────────────────────────────────
test('withTransaction commits on success and releases the connection', async () => {
  const db = new FakeDb();
  const result = await withTransaction(db.asPool(), async q => { await q.query('select 1'); return 'done'; });
  assert.equal(result, 'done');
  assert.deepEqual(db.calls.map(c => c.text), ['begin', 'select 1', 'commit']);
  assert.equal(db.released, 1);
});

test('withTransaction rolls back and rethrows on error', async () => {
  const db = new FakeDb();
  await assert.rejects(
    withTransaction(db.asPool(), async () => { throw new Error('boom'); }),
    /boom/,
  );
  assert.deepEqual(db.calls.map(c => c.text), ['begin', 'rollback']);
  assert.equal(db.released, 1);
});

test('AbortTransaction rolls back but returns its result', async () => {
  const db = new FakeDb();
  const result = await withTransaction(db.asPool(), async () => { throw new AbortTransaction('stopped'); });
  assert.equal(result, 'stopped');
  assert.deepEqual(db.calls.map(c => c.text), ['begin', 'rollback']);
});

// ── Tokens ────────────────────────────────────────────────────────────────────
test('createToken stores only the hash, never the raw token', async () => {
  const db = new FakeDb().on(/insert into attendance_tokens/, { rows: [{ id: 'tok-1', expires_at: new Date() }] });
  const created = await createToken(db, {
    employeeId: 7, campusId: 2, eventType: 'IN', workDate: '2026-03-02', ttlMinutes: 5, sourceMessageId: 'wamid.X',
  });
  assert.ok(created);
  const insert = db.calls[0];
  assert.equal(insert.params[0], hashToken(created.token));
  assert.ok(!insert.params.includes(created.token), 'raw token must not be sent to the database');
  // The older unused links for the same employee/type/day are expired.
  assert.match(db.calls[1].text, /update attendance_tokens set expires_at = now\(\)/);
  assert.equal(db.calls[1].params[3], 'tok-1');
});

test('createToken returns null for a duplicate message and expires nothing', async () => {
  const db = new FakeDb().on(/insert into attendance_tokens/, { rows: [] });
  const created = await createToken(db, {
    employeeId: 7, campusId: 2, eventType: 'IN', workDate: '2026-03-02', ttlMinutes: 5, sourceMessageId: 'wamid.X',
  });
  assert.equal(created, null);
  assert.equal(db.calls.length, 1);
});

test('tokenState: not found, used, locked, expired, ok (in that priority)', () => {
  const now = new Date('2026-03-02T04:00:00Z');
  const base: TokenRecord = {
    id: 't', employeeId: 1, campusId: 1, eventType: 'IN', workDate: '2026-03-02',
    expiresAt: new Date('2026-03-02T04:05:00Z'), locationVerifiedAt: null, usedAt: null,
    failedAttempts: 0, lockedAt: null,
  };
  assert.equal(tokenState(null, now), 'NOT_FOUND');
  assert.equal(tokenState(base, now), 'OK');
  assert.equal(tokenState({ ...base, expiresAt: new Date('2026-03-02T03:59:59Z') }, now), 'EXPIRED');
  assert.equal(tokenState({ ...base, expiresAt: now }, now), 'EXPIRED');
  assert.equal(tokenState({ ...base, lockedAt: now }, now), 'LOCKED');
  assert.equal(tokenState({ ...base, usedAt: now, lockedAt: now }, now), 'USED');
});

test('registerFailedAttempt reports the count and lock, or null when closed', async () => {
  const open = new FakeDb().on(/update attendance_tokens/, { rows: [{ failed_attempts: 3, locked_at: new Date() }] });
  assert.deepEqual(await registerFailedAttempt(open, 't', 3), { failedAttempts: 3, locked: true });
  const counting = new FakeDb().on(/update attendance_tokens/, { rows: [{ failed_attempts: 1, locked_at: null }] });
  assert.deepEqual(await registerFailedAttempt(counting, 't', 3), { failedAttempts: 1, locked: false });
  const closed = new FakeDb().on(/update attendance_tokens/, { rows: [] });
  assert.equal(await registerFailedAttempt(closed, 't', 3), null);
});

test('consumeToken succeeds only when exactly one row was updated', async () => {
  assert.equal(await consumeToken(new FakeDb().on(/update/, { rowCount: 1 }), 't'), true);
  assert.equal(await consumeToken(new FakeDb().on(/update/, { rowCount: 0 }), 't'), false);
});

// ── Recording attendance ──────────────────────────────────────────────────────
const event: NewAttendanceEvent = {
  employeeId: 7, campusId: 2, eventType: 'IN', workDate: '2026-03-02', punctuality: 'ON_TIME', lateMinutes: null,
  shift: { loginTime: '09:00:00', logoutTime: '16:00:00', graceMinutes: 10 },
  gps: { lat: 17, lng: 78, accuracyM: 5, distanceM: 11 }, selfiePath: 'a/b.jpg', tokenId: 'tok-1',
  serverTs: new Date('2026-03-02T03:30:00Z'),
};

test('recordAttendanceEvent saves the event, uses the token and runs afterInsert in one transaction', async () => {
  const db = new FakeDb()
    .on(/insert into attendance_events/, { rows: [{ id: 'ev-1', server_ts: new Date('2026-03-02T03:30:00Z') }] })
    .on(/update attendance_tokens set used_at/, { rowCount: 1 });
  let alertsQueued = 0;
  const result = await recordAttendanceEvent(db.asPool(), event, async () => { alertsQueued += 1; });
  assert.equal(result.status, 'RECORDED');
  assert.equal(alertsQueued, 1);
  assert.equal(db.calls[0].text, 'begin');
  assert.equal(db.calls[db.calls.length - 1].text, 'commit');
  assert.ok(db.calls.some(c => /insert into attendance_events/.test(c.text)));
  assert.ok(db.calls.some(c => /set used_at/.test(c.text)));
});

test('a duplicate event creates nothing and does not touch the token', async () => {
  const db = new FakeDb().on(/insert into attendance_events/, { rows: [] });
  const result = await recordAttendanceEvent(db.asPool(), event, async () => { throw new Error('must not run'); });
  assert.deepEqual(result, { status: 'DUPLICATE' });
  assert.ok(!db.calls.some(c => /set used_at/.test(c.text)));
  assert.equal(db.calls[db.calls.length - 1].text, 'rollback');
});

test('if the token cannot be used, the event is rolled back', async () => {
  const db = new FakeDb()
    .on(/insert into attendance_events/, { rows: [{ id: 'ev-1', server_ts: new Date() }] })
    .on(/update attendance_tokens set used_at/, { rowCount: 0 });
  const result = await recordAttendanceEvent(db.asPool(), event, async () => { throw new Error('must not run'); });
  assert.deepEqual(result, { status: 'TOKEN_UNAVAILABLE' });
  assert.equal(db.calls[db.calls.length - 1].text, 'rollback');
  assert.ok(!db.calls.some(c => c.text === 'commit'));
});

test('if afterInsert fails, nothing is committed', async () => {
  const db = new FakeDb()
    .on(/insert into attendance_events/, { rows: [{ id: 'ev-1', server_ts: new Date() }] })
    .on(/update attendance_tokens set used_at/, { rowCount: 1 });
  await assert.rejects(
    recordAttendanceEvent(db.asPool(), event, async () => { throw new Error('queue failed'); }),
    /queue failed/,
  );
  assert.ok(!db.calls.some(c => c.text === 'commit'));
  assert.equal(db.calls[db.calls.length - 1].text, 'rollback');
});

// ── Outbox ────────────────────────────────────────────────────────────────────
const message = {
  recipientType: 'DIRECTOR' as const, recipientE164: '910000000000', kind: 'DIRECTOR_CHECKIN' as const,
  deliveryMode: 'TEMPLATE' as const, templateName: 'attendance_checkin', templateLanguage: 'en',
  payload: { params: ['A'] }, idempotencyKey: 'in:ev-1',
};

test('enqueueMessage returns an id and writes a QUEUED log row', async () => {
  const db = new FakeDb().on(/insert into notification_outbox/, { rows: [{ id: 'm-1' }] });
  assert.equal(await enqueueMessage(db, message), 'm-1');
  assert.equal(db.calls[0].params[9], JSON.stringify({ params: ['A'] }));
  assert.match(db.calls[1].text, /insert into notification_delivery_log/);
});

test('enqueueMessage ignores a repeated idempotency key', async () => {
  const db = new FakeDb().on(/insert into notification_outbox/, { rows: [] });
  assert.equal(await enqueueMessage(db, message), null);
  assert.equal(db.calls.length, 1);
});

test('retry back-off doubles from 60 s and caps at one hour', () => {
  assert.deepEqual([1, 2, 3, 4].map(backoffSeconds), [60, 120, 240, 480]);
  assert.equal(backoffSeconds(10), 3600);
  assert.equal(backoffSeconds(0), 60);
});

test('a failed send retries until max_attempts, then is FAILED', async () => {
  const retry = new FakeDb();
  assert.equal(await markSendFailure(retry, { id: 'm', attempts: 2, maxAttempts: 5 }, 'timeout'), 'RETRY');
  assert.equal(retry.calls[0].params[1], 'QUEUED');
  const final = new FakeDb();
  assert.equal(await markSendFailure(final, { id: 'm', attempts: 5, maxAttempts: 5 }, 'x'.repeat(900)), 'FAILED');
  assert.equal(final.calls[0].params[1], 'FAILED');
  assert.equal((final.calls[0].params[2] as string).length, 500);
});

// ── Webhook events and audit ──────────────────────────────────────────────────
test('claimWebhookEvent is true once and false for a repeat', async () => {
  const input = { eventKey: 'msg:w1', kind: 'MESSAGE' as const, fromMasked: '****3605', command: 'IN' as const, employeeId: 7 };
  assert.equal(await claimWebhookEvent(new FakeDb().on(/insert/, { rows: [{ event_key: 'msg:w1' }] }), input), true);
  assert.equal(await claimWebhookEvent(new FakeDb().on(/insert/, { rows: [] }), input), false);
});

test('writeAudit stores values as JSON and never needs a full phone number', async () => {
  const db = new FakeDb();
  await writeAudit(db, {
    actorType: 'USER', actorUserId: 1, action: 'SETTING_CHANGED', entityType: 'setting', entityId: 'alert_mode',
    oldValue: 'individual', newValue: 'digest', reason: 'quieter',
  });
  assert.equal(db.calls[0].params[6], '"individual"');
  assert.equal(db.calls[0].params[7], '"digest"');
});

// ── Campus choice rules ───────────────────────────────────────────────────────
const opt = (campusId: number, kind: CampusOption['kind'], mode: CampusOption['mode'] = 'REPLACE'): CampusOption =>
  ({ campusId, campusCode: `C${campusId}`, campusName: `Campus ${campusId}`, kind, mode });

test('campus choice: primary only', () => {
  assert.deepEqual(resolveAllowedCampuses([opt(1, 'PRIMARY')]).map(c => c.campusId), [1]);
});

test('campus choice: temporary REPLACE replaces the primary campus', () => {
  const result = resolveAllowedCampuses([opt(1, 'PRIMARY'), opt(2, 'TEMPORARY', 'REPLACE')]);
  assert.deepEqual(result.map(c => c.campusId), [2]);
});

test('campus choice: temporary ADDITIONAL is offered alongside the primary', () => {
  const result = resolveAllowedCampuses([opt(1, 'PRIMARY'), opt(2, 'TEMPORARY', 'ADDITIONAL')]);
  assert.deepEqual(result.map(c => c.campusId), [1, 2]);
});

test('campus choice: no assignment means no campus, and duplicates are removed', () => {
  assert.deepEqual(resolveAllowedCampuses([]), []);
  const result = resolveAllowedCampuses([opt(1, 'PRIMARY'), opt(1, 'TEMPORARY', 'ADDITIONAL')]);
  assert.deepEqual(result.map(c => c.campusId), [1]);
});

// ── Settings ──────────────────────────────────────────────────────────────────
test('settings are read from rows, with defaults for anything missing or invalid', () => {
  const settings = parseSettings([
    { key: 'default_grace_minutes', value: 15 },
    { key: 'token_ttl_minutes', value: 'abc' },          // invalid -> default
    { key: 'alert_mode', value: 'digest' },
    { key: 'director_whatsapp_e164', value: '919849136605' },
  ]);
  assert.equal(settings.defaultGraceMinutes, 15);
  assert.equal(settings.tokenTtlMinutes, SETTING_DEFAULTS.tokenTtlMinutes);
  assert.equal(settings.alertMode, 'digest');
  assert.equal(settings.directorWhatsapp, '919849136605');
  assert.equal(settings.maxFailedAttempts, 3);           // missing -> default
});

test('setting values are validated before being saved', () => {
  assert.equal(validateSettingValue('default_grace_minutes', 10), null);
  assert.ok(validateSettingValue('default_grace_minutes', -1));
  assert.ok(validateSettingValue('default_grace_minutes', 1.5));
  assert.ok(validateSettingValue('token_ttl_minutes', 0));
  assert.equal(validateSettingValue('director_whatsapp_e164', null), null);
  assert.ok(validateSettingValue('director_whatsapp_e164', '+919849136605'));
  assert.ok(validateSettingValue('alert_mode', 'loud'));
  assert.equal(validateSettingValue('attendance_link_base_url', ''), null);
  assert.equal(validateSettingValue('attendance_link_base_url', 'https://payroll-portal-migration-test.netlify.app'), null);
  assert.ok(validateSettingValue('attendance_link_base_url', 'http://insecure.example'));
  assert.ok(validateSettingValue('template_checkin', 'Bad Name!'));
  assert.ok(validateSettingValue('not_a_setting', 1));
});
