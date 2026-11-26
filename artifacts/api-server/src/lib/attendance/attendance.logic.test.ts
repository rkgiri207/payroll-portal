import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { parseCommand } from './commands';
import { distanceMeters, evaluateLocation, type CampusGeo } from './geo';
import { evaluatePunctuality, pickShift, type ShiftRow } from './shift';
import { istParts, timeToMinutes } from './time';
import { generateToken, hashToken, isTokenShape } from './token';
import { maskPhone, toWhatsAppNumber, verifyMetaSignature } from './webhookSecurity';

// ── Time (IST) ────────────────────────────────────────────────────────────────
test('IST parts: 09:10:59 IST and 09:11:00 IST', () => {
  const onTime = istParts(new Date('2026-03-02T03:40:59Z'));
  assert.equal(onTime.workDate, '2026-03-02');
  assert.equal(onTime.weekday, 1); // Monday
  assert.equal(onTime.minuteOfDay, 9 * 60 + 10);
  assert.equal(istParts(new Date('2026-03-02T03:41:00Z')).minuteOfDay, 9 * 60 + 11);
});

test('IST date rolls over before UTC does', () => {
  const parts = istParts(new Date('2026-03-01T19:00:00Z')); // 00:30 IST on 2 March
  assert.equal(parts.workDate, '2026-03-02');
  assert.equal(parts.weekday, 1);
  assert.equal(parts.minuteOfDay, 30);
});

test('timeToMinutes accepts HH:MM and HH:MM:SS and rejects bad values', () => {
  assert.equal(timeToMinutes('09:00'), 540);
  assert.equal(timeToMinutes('09:00:00'), 540);
  assert.throws(() => timeToMinutes('25:00'));
  assert.throws(() => timeToMinutes('nine'));
});

// ── Shifts and late calculation ───────────────────────────────────────────────
const weekdays = [1, 2, 3, 4, 5];
const baseShift: ShiftRow = {
  id: 1, loginTime: '09:00:00', logoutTime: '16:00:00', graceMinutes: 10,
  weekdays, effectiveFrom: '2026-01-01',
};

test('09:10 is on time and 09:11 is late (10 minute grace)', () => {
  assert.deepEqual(evaluatePunctuality(baseShift, 9 * 60 + 10), { punctuality: 'ON_TIME', lateMinutes: null });
  assert.deepEqual(evaluatePunctuality(baseShift, 9 * 60 + 11), { punctuality: 'LATE', lateMinutes: 1 });
  assert.equal(evaluatePunctuality(baseShift, 9 * 60 + 45).lateMinutes, 35);
});

test('no shift means NO_SHIFT, never late', () => {
  assert.deepEqual(evaluatePunctuality(null, 12 * 60), { punctuality: 'NO_SHIFT', lateMinutes: null });
});

test('the grace period comes from the shift, not a fixed 9:00', () => {
  const early: ShiftRow = { ...baseShift, loginTime: '08:30', graceMinutes: 5 };
  assert.equal(evaluatePunctuality(early, 8 * 60 + 35).punctuality, 'ON_TIME');
  assert.equal(evaluatePunctuality(early, 8 * 60 + 36).punctuality, 'LATE');
});

test('pickShift uses the latest effective shift for that weekday, not future ones', () => {
  const later: ShiftRow = { ...baseShift, id: 2, loginTime: '08:30', effectiveFrom: '2026-06-01' };
  const saturday: ShiftRow = { ...baseShift, id: 3, loginTime: '09:30', weekdays: [6] };
  const shifts = [baseShift, later, saturday];
  assert.equal(pickShift(shifts, '2026-03-02', 1)?.id, 1);      // before the new shift starts
  assert.equal(pickShift(shifts, '2026-06-01', 1)?.id, 2);      // from its effective date
  assert.equal(pickShift(shifts, '2026-03-07', 6)?.id, 3);      // Saturday shift
  assert.equal(pickShift(shifts, '2026-03-08', 0), null);       // Sunday: no shift
  assert.equal(pickShift(shifts, '2025-12-31', 3), null);       // before any shift started
});

test('pickShift breaks an effective-date tie with the highest id', () => {
  const a: ShiftRow = { ...baseShift, id: 5 };
  const b: ShiftRow = { ...baseShift, id: 9, loginTime: '09:15' };
  assert.equal(pickShift([a, b], '2026-03-02', 1)?.id, 9);
});

// ── Distance and location ─────────────────────────────────────────────────────
const campus: CampusGeo = { latitude: 17.0, longitude: 78.0, radiusM: 25, requiredAccuracyM: 10 };

test('haversine: one degree of latitude is about 111 km, same point is 0', () => {
  assert.ok(Math.abs(distanceMeters({ lat: 0, lng: 0 }, { lat: 1, lng: 0 }) - 111_195) < 200);
  assert.equal(distanceMeters({ lat: 17, lng: 78 }, { lat: 17, lng: 78 }), 0);
});

test('inside the radius with good accuracy passes', () => {
  const result = evaluateLocation(campus, { lat: 17.0001, lng: 78.0, accuracyM: 5 }); // ~11 m
  assert.equal(result.result, 'PASSED');
  assert.equal(result.boundary, false);
});

test('outside the radius fails', () => {
  assert.equal(evaluateLocation(campus, { lat: 17.0003, lng: 78.0, accuracyM: 5 }).result, 'OUTSIDE_RADIUS'); // ~33 m
});

test('poor accuracy is never silently accepted, even right at the campus', () => {
  const result = evaluateLocation(campus, { lat: 17.0, lng: 78.0, accuracyM: 35 });
  assert.equal(result.result, 'POOR_ACCURACY');
});

test('a point near the edge whose accuracy circle crosses the boundary is flagged', () => {
  const result = evaluateLocation(campus, { lat: 17.00018, lng: 78.0, accuracyM: 10 }); // ~20 m + 10 m
  assert.equal(result.result, 'PASSED');
  assert.equal(result.boundary, true);
});

test('missing, malformed or out-of-range location is NO_LOCATION', () => {
  for (const bad of [
    { lat: null, lng: 78, accuracyM: 5 },
    { lat: 'x', lng: 78, accuracyM: 5 },
    { lat: 91, lng: 78, accuracyM: 5 },
    { lat: 17, lng: 181, accuracyM: 5 },
    { lat: 17, lng: 78, accuracyM: -1 },
    { lat: NaN, lng: 78, accuracyM: 5 },
    { lat: 17, lng: 78, accuracyM: undefined },
  ]) {
    assert.equal(evaluateLocation(campus, bad).result, 'NO_LOCATION');
  }
});

test('a campus without coordinates cannot accept attendance', () => {
  const unset: CampusGeo = { ...campus, latitude: null, longitude: null };
  assert.equal(evaluateLocation(unset, { lat: 17, lng: 78, accuracyM: 5 }).result, 'CAMPUS_NOT_CONFIGURED');
});

// ── Tokens ────────────────────────────────────────────────────────────────────
test('tokens are unique, URL-safe, correctly shaped and hashed deterministically', () => {
  const a = generateToken();
  const b = generateToken();
  assert.notEqual(a, b);
  assert.ok(isTokenShape(a));
  assert.equal(hashToken(a), hashToken(a));
  assert.notEqual(hashToken(a), hashToken(b));
  assert.equal(hashToken(a).length, 64);
  assert.notEqual(hashToken(a), a);
  assert.equal(isTokenShape('short'), false);
  assert.equal(isTokenShape(undefined), false);
});

// ── Commands ──────────────────────────────────────────────────────────────────
test('commands are exact, case-insensitive and trimmed', () => {
  assert.deepEqual(parseCommand('in'), { command: 'IN', choice: null });
  assert.deepEqual(parseCommand('  OUT  '), { command: 'OUT', choice: null });
  assert.deepEqual(parseCommand('Help'), { command: 'HELP', choice: null });
  assert.deepEqual(parseCommand('IN 2'), { command: 'IN', choice: 2 });
  assert.deepEqual(parseCommand('out   1'), { command: 'OUT', choice: 1 });
  assert.equal(parseCommand('leave')?.command, 'LEAVE');
  assert.equal(parseCommand('permission')?.command, 'PERMISSION');
  assert.equal(parseCommand('balance')?.command, 'BALANCE');
});

test('ordinary conversation never counts as a command', () => {
  for (const text of ['hello', 'in the morning', 'INN', 'I am in', 'IN 0', 'IN 12', 'HELP me', '', '   ', 'OUT!']) {
    assert.equal(parseCommand(text), null, text);
  }
  assert.equal(parseCommand(undefined), null);
  assert.equal(parseCommand(42), null);
  assert.equal(parseCommand('IN'.repeat(30)), null);
});

// ── Webhook signature and phone helpers ───────────────────────────────────────
test('Meta signature: valid, tampered, missing and malformed', () => {
  const secret = 'test-app-secret';
  const body = Buffer.from('{"entry":[]}');
  const good = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  assert.equal(verifyMetaSignature(body, good, secret), true);
  assert.equal(verifyMetaSignature(Buffer.from('{"entry":[1]}'), good, secret), false);
  assert.equal(verifyMetaSignature(body, good, 'other-secret'), false);
  assert.equal(verifyMetaSignature(body, undefined, secret), false);
  assert.equal(verifyMetaSignature(body, 'sha256=nothex', secret), false);
  assert.equal(verifyMetaSignature(body, good.replace('sha256=', ''), secret), false);
  assert.equal(verifyMetaSignature(body, good, ''), false);
});

test('phone numbers normalise to WhatsApp format and are masked for logs', () => {
  assert.equal(toWhatsAppNumber('98491 36605'), '919849136605');
  assert.equal(toWhatsAppNumber('+91 98491 36605'), '919849136605');
  assert.equal(toWhatsAppNumber('12345'), null);
  assert.equal(toWhatsAppNumber(''), null);
  assert.equal(maskPhone('919849136605'), '********6605');
  assert.equal(maskPhone('12'), '****');
});
