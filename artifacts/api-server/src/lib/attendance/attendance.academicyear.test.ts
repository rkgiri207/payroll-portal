import assert from 'node:assert/strict';
import test from 'node:test';
import { findAcademicYearForDate, isOutsideAcademicYear } from '../leave/academicYear';
import { handleInboundMessage, type ServiceDeps } from './attendanceService';
import { asPoolLike } from './db';
import { recordAttendanceEvent } from './eventStore';
import type { InboundMessage } from './inbound';
import { SETTING_DEFAULTS, parseSettings, validateSettingValue } from './settings';
import { FakeDb } from './testSupport';
import type { WhatsAppConfig } from './whatsappSender';

const wa: WhatsAppConfig = { mode: 'stub', accessToken: null, phoneNumberId: null, graphVersion: null };
const NOW = new Date('2026-03-02T03:35:00Z'); // 09:05 IST on 2 March 2026

interface Setup { allowOutside?: boolean; year: { id: number | null; label?: string | null; any: boolean } }

function build(setup: Setup) {
  const db = new FakeDb()
    .on(/from attendance_employees ae/, { rows: [{ id: 7, employee_code: 'T001', employee_name: 'Asha Rao' }] })
    .on(/insert into whatsapp_webhook_events/, { rows: [{ event_key: 'k' }] })
    .on(/from attendance_settings/, { rows: setup.allowOutside === undefined ? [] : [{ key: 'allow_attendance_outside_academic_year', value: setup.allowOutside }] })
    .on(/from academic_years/, { rows: [{ year_id: setup.year.id, label: setup.year.label ?? null, any_year: setup.year.any }] })
    .on(/from employee_campus_assignments a/, { rows: [{ campus_id: 2, code: 'M', name: 'Main', kind: 'PRIMARY', mode: 'REPLACE' }] })
    .on(/insert into attendance_tokens/, { rows: [{ id: 'tok1', expires_at: new Date('2026-03-02T03:40:00Z') }] })
    .on(/insert into notification_outbox/, { rows: [{ id: 'msg' }] })
    .on(/with due as/, { rows: [] });
  const deps: ServiceDeps = { pool: asPoolLike(db.asPool()), wa, env: { APP_BASE_URL: 'https://portal.test' }, now: () => NOW };
  return { db, deps };
}

const inMessage: InboundMessage = { id: 'wamid.in1', from: '919000000002', type: 'text', text: 'IN', isGroup: false };
const bodies = (db: FakeDb) => db.where(/insert into notification_outbox/).map(c => String((JSON.parse(String(c.params[9])) as { body?: string }).body ?? ''));

test('outside every academic year with the switch off: refused politely, no link created', async () => {
  const { db, deps } = build({ year: { id: null, any: true } });
  await handleInboundMessage(deps, inMessage);
  assert.equal(db.where(/insert into attendance_tokens/).length, 0);
  assert.match(bodies(db)[0], /outside the academic year/);
});

test('outside every academic year with the switch on: the link is created as normal', async () => {
  const { db, deps } = build({ allowOutside: true, year: { id: null, any: true } });
  await handleInboundMessage(deps, inMessage);
  assert.equal(db.where(/insert into attendance_tokens/).length, 1);
  assert.ok(!bodies(db).some(b => /outside the academic year/.test(b)));
});

test('inside an academic year the switch is irrelevant', async () => {
  const { db, deps } = build({ year: { id: 3, label: '2026-27', any: true } });
  await handleInboundMessage(deps, inMessage);
  assert.equal(db.where(/insert into attendance_tokens/).length, 1);
});

test('before any academic year is set up, attendance is never blocked', async () => {
  const { db, deps } = build({ year: { id: null, any: false } });
  await handleInboundMessage(deps, inMessage);
  assert.equal(db.where(/insert into attendance_tokens/).length, 1);
});

test('the lookup reads the organisation\'s own years (parameterised, no fixed dates)', async () => {
  const db = new FakeDb().on(/from academic_years/, { rows: [{ year_id: 3, label: '2026-27', any_year: true }] });
  const found = await findAcademicYearForDate(db, '2026-12-01');
  assert.deepEqual(found, { yearId: 3, label: '2026-27', anyYearConfigured: true });
  assert.deepEqual(db.calls[0].params, ['2026-12-01']);
  assert.ok(!/\d{4}-\d{2}-\d{2}/.test(db.calls[0].text), 'the SQL must not contain a fixed date');
  assert.equal(isOutsideAcademicYear(found), false);
  assert.equal(isOutsideAcademicYear({ yearId: null, label: null, anyYearConfigured: true }), true);
  assert.equal(isOutsideAcademicYear({ yearId: null, label: null, anyYearConfigured: false }), false);
});

test('the setting defaults to off, accepts only on/off, and bad stored values fall back to off', () => {
  assert.equal(SETTING_DEFAULTS.allowOutsideAcademicYear, false);
  assert.equal(validateSettingValue('allow_attendance_outside_academic_year', true), null);
  assert.equal(validateSettingValue('allow_attendance_outside_academic_year', false), null);
  assert.match(validateSettingValue('allow_attendance_outside_academic_year', 'yes') ?? '', /on or off/);
  assert.equal(parseSettings([{ key: 'allow_attendance_outside_academic_year', value: true }]).allowOutsideAcademicYear, true);
  assert.equal(parseSettings([{ key: 'allow_attendance_outside_academic_year', value: 'yes' }]).allowOutsideAcademicYear, false);
  assert.equal(parseSettings([]).allowOutsideAcademicYear, false);
});

test('an attendance record carries the outside-academic-year flag', async () => {
  const base = {
    employeeId: 7, campusId: 2, eventType: 'IN' as const, workDate: '2026-05-20', punctuality: 'ON_TIME' as const, lateMinutes: null,
    shift: null, gps: { lat: 1, lng: 2, accuracyM: 5, distanceM: 3 }, selfiePath: 'p', tokenId: 't', serverTs: NOW,
  };
  for (const flag of [undefined, false, true]) {
    const db = new FakeDb();
    await recordAttendanceEvent(db.asPool(), { ...base, ...(flag === undefined ? {} : { outsideAcademicYear: flag }) });
    const insert = db.where(/insert into attendance_events/)[0];
    assert.match(insert.text, /outside_academic_year/);
    assert.equal(insert.params[16], flag ?? false);
  }
});
