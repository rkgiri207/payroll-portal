import assert from 'node:assert/strict';
import test from 'node:test';
import { canEditSetting, resolveRole } from './adminAccess';
import {
  createAssignment, createCampus, createShift, deleteFutureShift, removeAssignment, saveRegistration, updateCampus,
  type CampusRow,
} from './adminStore';
import {
  isValidDate, toId, validateAssignment, validateCampus, validateExceptionReview, validateRegistration,
  validateReview, validateShift,
} from './adminValidation';
import { SETTING_DEFAULTS } from './settings';
import { buildChecklist, readEnvFlags } from './setupChecklist';
import { FakeDb } from './testSupport';
import { addDays } from './time';

const defaults = { geofenceRadiusM: 25, graceMinutes: 10 };

// ── Campus input ──────────────────────────────────────────────────────────────
test('a campus needs a code and name; the radius default comes from settings', () => {
  const result = validateCampus({ code: ' main-1 ', name: ' Main Campus ' }, defaults);
  assert.deepEqual(result, { ok: true, value: {
    code: 'MAIN-1', name: 'Main Campus', address: null, latitude: null, longitude: null,
    geofenceRadiusM: 25, requiredAccuracyM: null, isActive: true,
  } });
  const custom = validateCampus({ code: 'N', name: 'North', geofenceRadiusM: '40', requiredAccuracyM: 8, latitude: '17.385', longitude: 78.4867, isActive: false }, defaults);
  assert.ok(custom.ok);
  assert.deepEqual([custom.value.geofenceRadiusM, custom.value.requiredAccuracyM, custom.value.latitude, custom.value.longitude, custom.value.isActive], [40, 8, 17.385, 78.4867, false]);
});

test('campus input errors are specific and friendly', () => {
  const errors: [unknown, string][] = [
    [null, 'Send the campus details'],
    [{ code: '', name: 'X' }, 'Campus code is required'],
    [{ code: 'A B', name: 'X' }, 'Campus code may use letters'],
    [{ code: 'A', name: '' }, 'Campus name is required'],
    [{ code: 'A', name: 'X', latitude: 17 }, 'both latitude and longitude'],
    [{ code: 'A', name: 'X', latitude: 91, longitude: 78 }, 'Latitude must be'],
    [{ code: 'A', name: 'X', latitude: 17, longitude: 181 }, 'Longitude must be'],
    [{ code: 'A', name: 'X', latitude: 'abc', longitude: 78 }, 'Latitude must be'],
    [{ code: 'A', name: 'X', geofenceRadiusM: 2 }, 'from 5 to 500'],
    [{ code: 'A', name: 'X', geofenceRadiusM: 12.5 }, 'whole number'],
    [{ code: 'A', name: 'X', requiredAccuracyM: 1 }, 'from 3 to 100'],
    [{ code: 'A', name: 'X', isActive: 'yes' }, 'Active must be true or false'],
    [{ code: 'A'.repeat(21), name: 'X' }, 'at most 20'],
  ];
  for (const [body, fragment] of errors) {
    const result = validateCampus(body, defaults);
    assert.ok(!result.ok, JSON.stringify(body));
    assert.ok(result.error.includes(fragment), `${JSON.stringify(body)} -> ${result.error}`);
  }
});

// ── Shift input ───────────────────────────────────────────────────────────────
test('a shift takes times, weekdays and a start date; grace defaults from settings', () => {
  const result = validateShift({ loginTime: '09:00', logoutTime: '16:00', weekdays: [5, 1, 2, 2, 3, 4], effectiveFrom: '2026-03-02' }, defaults);
  assert.deepEqual(result, { ok: true, value: {
    loginTime: '09:00', logoutTime: '16:00', graceMinutes: 10, weekdays: [1, 2, 3, 4, 5], effectiveFrom: '2026-03-02',
  } });
  const grace = validateShift({ loginTime: '08:30', logoutTime: '15:00', graceMinutes: 0, weekdays: [6], effectiveFrom: '2026-03-02' }, defaults);
  assert.ok(grace.ok && grace.value.graceMinutes === 0);
});

test('shift input errors', () => {
  const ok = { loginTime: '09:00', logoutTime: '16:00', weekdays: [1], effectiveFrom: '2026-03-02' };
  const errors: [Record<string, unknown>, string][] = [
    [{ ...ok, loginTime: '9:00' }, 'Login time must look like'],
    [{ ...ok, loginTime: '25:00' }, 'Login time must look like'],
    [{ ...ok, logoutTime: '16:60' }, 'Logout time must look like'],
    [{ ...ok, logoutTime: '09:00' }, 'after login time'],
    [{ ...ok, logoutTime: '08:00' }, 'after login time'],
    [{ ...ok, graceMinutes: -1 }, '0 to 120'],
    [{ ...ok, graceMinutes: 200 }, '0 to 120'],
    [{ ...ok, weekdays: [] }, 'at least one working day'],
    [{ ...ok, weekdays: [7] }, 'between Sunday and Saturday'],
    [{ ...ok, weekdays: 'mon' }, 'at least one working day'],
    [{ ...ok, effectiveFrom: '2026-02-30' }, 'Effective-from date'],
    [{ ...ok, effectiveFrom: '02/03/2026' }, 'Effective-from date'],
  ];
  for (const [body, fragment] of errors) {
    const result = validateShift(body, defaults);
    assert.ok(!result.ok, JSON.stringify(body));
    assert.ok(result.error.includes(fragment), `${JSON.stringify(body)} -> ${result.error}`);
  }
  assert.ok(!validateShift(null, defaults).ok);
});

test('date and id helpers', () => {
  assert.equal(isValidDate('2026-02-28'), true);
  assert.equal(isValidDate('2026-02-29'), false);   // not a leap year
  assert.equal(isValidDate('2028-02-29'), true);
  assert.equal(isValidDate('2026-13-01'), false);
  assert.equal(isValidDate(20260301), false);
  assert.equal(toId('7'), 7);
  assert.equal(toId(7), 7);
  for (const bad of ['0', '-1', '1.5', 'abc', '', null, undefined, '99999999999']) assert.equal(toId(bad), null, String(bad));
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
});

// ── Registration and assignments input ────────────────────────────────────────
test('a WhatsApp number is normalised to the WhatsApp format, or cleared', () => {
  assert.deepEqual(validateRegistration({ whatsapp: '98491 36605', attendanceApplicable: true }),
    { ok: true, value: { whatsapp: '919849136605', attendanceApplicable: true, reportsDuringVacations: null } });
  assert.deepEqual(validateRegistration({ whatsapp: '+91-9849136605', attendanceApplicable: false }),
    { ok: true, value: { whatsapp: '919849136605', attendanceApplicable: false, reportsDuringVacations: null } });
  for (const blank of ['', '   ', null, undefined]) {
    assert.deepEqual(validateRegistration({ whatsapp: blank, attendanceApplicable: true }),
      { ok: true, value: { whatsapp: null, attendanceApplicable: true, reportsDuringVacations: null } });
  }
  // The vacation switch: true or false is kept; leaving it out leaves the saved value alone.
  assert.deepEqual(validateRegistration({ whatsapp: '', attendanceApplicable: true, reportsDuringVacations: true }), { ok: true, value: { whatsapp: null, attendanceApplicable: true, reportsDuringVacations: true } });
  assert.deepEqual(validateRegistration({ whatsapp: '', attendanceApplicable: true, reportsDuringVacations: false }), { ok: true, value: { whatsapp: null, attendanceApplicable: true, reportsDuringVacations: false } });
  assert.ok(!validateRegistration({ whatsapp: '', attendanceApplicable: true, reportsDuringVacations: 'yes' }).ok);
  for (const body of [{ whatsapp: '12345', attendanceApplicable: true }, { whatsapp: 'abc', attendanceApplicable: true },
    { whatsapp: 98491, attendanceApplicable: true }, { whatsapp: '9849136605' }, null]) {
    assert.ok(!validateRegistration(body).ok, JSON.stringify(body));
  }
});

test('assignments: primary is open-ended; temporary needs an end date and has a mode', () => {
  assert.deepEqual(validateAssignment({ campusId: 3, kind: 'PRIMARY', startDate: '2026-03-02' }),
    { ok: true, value: { campusId: 3, kind: 'PRIMARY', mode: 'REPLACE', startDate: '2026-03-02', endDate: null, note: null } });
  const temp = validateAssignment({ campusId: 3, kind: 'TEMPORARY', mode: 'ADDITIONAL', startDate: '2026-03-02', endDate: '2026-03-06', note: ' exam duty ' });
  assert.deepEqual(temp, { ok: true, value: { campusId: 3, kind: 'TEMPORARY', mode: 'ADDITIONAL', startDate: '2026-03-02', endDate: '2026-03-06', note: 'exam duty' } });
  assert.ok(validateAssignment({ campusId: 3, kind: 'TEMPORARY', startDate: '2026-03-02', endDate: '2026-03-06' }).ok); // mode defaults to replace

  const errors: [unknown, string][] = [
    [{ kind: 'PRIMARY', startDate: '2026-03-02' }, 'Choose a campus'],
    [{ campusId: 3, kind: 'OTHER', startDate: '2026-03-02' }, 'primary or temporary'],
    [{ campusId: 3, kind: 'PRIMARY', startDate: 'soon' }, 'Start date'],
    [{ campusId: 3, kind: 'TEMPORARY', startDate: '2026-03-02' }, 'needs an end date'],
    [{ campusId: 3, kind: 'TEMPORARY', startDate: '2026-03-05', endDate: '2026-03-02' }, 'cannot be before'],
    [{ campusId: 3, kind: 'TEMPORARY', mode: 'BOTH', startDate: '2026-03-02', endDate: '2026-03-06' }, 'replace or additional'],
    [{ campusId: 3, kind: 'TEMPORARY', startDate: '2026-03-02', endDate: '2026-03-06', note: 'x'.repeat(201) }, 'at most 200'],
  ];
  for (const [body, fragment] of errors) {
    const result = validateAssignment(body);
    assert.ok(!result.ok && result.error.includes(fragment), `${JSON.stringify(body)}`);
  }
});

test('reviews: rejecting needs a reason; approving does not', () => {
  assert.deepEqual(validateReview({ status: 'APPROVED' }), { ok: true, value: { status: 'APPROVED', note: null } });
  assert.deepEqual(validateReview({ status: 'REJECTED', note: ' not clear ' }), { ok: true, value: { status: 'REJECTED', note: 'not clear' } });
  assert.ok(!validateReview({ status: 'REJECTED' }).ok);
  assert.ok(!validateReview({ status: 'MAYBE' }).ok);
  assert.deepEqual(validateExceptionReview({ status: 'RESOLVED' }), { ok: true, value: { status: 'RESOLVED', note: null } });
  assert.ok(!validateExceptionReview({ status: 'OPEN' }).ok);
});

// ── Roles ─────────────────────────────────────────────────────────────────────
test('roles: an explicit role wins; an active ADMIN login is the Director; others get nothing', async () => {
  const role = async (row: unknown) => resolveRole(new FakeDb().on(/from users u/, { rows: row ? [row] : [] }), 1);
  assert.equal(await role({ attendance_role: 'ADMIN', user_role: 'ADMIN', is_active: true }), 'ADMIN');
  assert.equal(await role({ attendance_role: 'DIRECTOR', user_role: 'ADMIN', is_active: true }), 'DIRECTOR');
  assert.equal(await role({ attendance_role: null, user_role: 'ADMIN', is_active: true }), 'DIRECTOR');
  assert.equal(await role({ attendance_role: null, user_role: 'ADMIN', is_active: false }), null);
  assert.equal(await role({ attendance_role: 'DIRECTOR', user_role: 'ADMIN', is_active: false }), null);
  assert.equal(await role({ attendance_role: null, user_role: 'STAFF', is_active: true }), null);
  assert.equal(await role(null), null);
});

test('only the Director can change alert settings', () => {
  for (const key of ['director_whatsapp_e164', 'alert_mode', 'digest_interval_minutes']) {
    assert.equal(canEditSetting('DIRECTOR', key), true);
    assert.equal(canEditSetting('ADMIN', key), false);
  }
  assert.equal(canEditSetting('ADMIN', 'default_geofence_radius_m'), true);
});

// ── Store rules ───────────────────────────────────────────────────────────────
const uniqueViolation = () => Object.assign(new Error('duplicate key'), { code: '23505' });
const campusRaw = { id: 5, code: 'M', name: 'Main', address: null, latitude: 17, longitude: 78, geofence_radius_m: 25, required_accuracy_m: null, is_active: true };
const campusInput = { code: 'M', name: 'Main', address: null, latitude: 17, longitude: 78, geofenceRadiusM: 25, requiredAccuracyM: null, isActive: true };

test('campus create: duplicate code gives a friendly error', async () => {
  const dup = new FakeDb().on(/insert into campuses/, () => { throw uniqueViolation(); });
  assert.deepEqual(await createCampus(dup, campusInput), { ok: false, error: 'That campus code is already in use' });
  const good = new FakeDb().on(/insert into campuses/, { rows: [{ id: 5 }] }).on(/from campuses c where c.id/, { rows: [campusRaw] });
  const created = await createCampus(good, campusInput);
  assert.ok(created.ok && created.value.id === 5 && created.value.name === 'Main');
});

test('campus update returns the before and after for the audit log, and rejects unknown or duplicate', async () => {
  const missing = new FakeDb().on(/from campuses c where c.id/, { rows: [] });
  assert.deepEqual(await updateCampus(missing, 5, campusInput), { ok: false, error: 'Campus not found' });
  const db = new FakeDb().on(/from campuses c where c.id/, { rows: [campusRaw] }).on(/update campuses/, { rowCount: 1 });
  const result = await updateCampus(db, 5, { ...campusInput, name: 'Main 2' });
  assert.ok(result.ok);
  const dup = new FakeDb().on(/from campuses c where c.id/, { rows: [campusRaw] }).on(/update campuses/, () => { throw uniqueViolation(); });
  assert.equal((await updateCampus(dup, 5, campusInput) as { error: string }).error, 'That campus code is already in use');
});

test('shifts: a duplicate is refused, and only a shift that has not started can be deleted', async () => {
  const input = { loginTime: '09:00', logoutTime: '16:00', graceMinutes: 10, weekdays: [1, 2], effectiveFrom: '2026-04-01' };
  const dup = new FakeDb().on(/insert into campus_shifts/, () => { throw uniqueViolation(); });
  assert.equal((await createShift(dup, 2, input, 1) as { error: string }).error, 'A shift with the same days and start date already exists');
  const fk = new FakeDb().on(/insert into campus_shifts/, () => { throw Object.assign(new Error('fk'), { code: '23503' }); });
  assert.equal((await createShift(fk, 99, input, 1) as { error: string }).error, 'Campus not found');

  const started = new FakeDb().on(/from campus_shifts where id/, { rows: [{ id: 1, campus_id: 2, effective_from: '2026-03-02' }] });
  const refused = await deleteFutureShift(started, 1, '2026-03-02');
  assert.ok(!refused.ok && /already started/.test(refused.error));
  assert.equal(started.where(/delete from campus_shifts/).length, 0);

  const future = new FakeDb()
    .on(/from campus_shifts where id/, { rows: [{ id: 1, campus_id: 2, effective_from: '2026-04-01' }] })
    .on(/from campus_shifts where campus_id/, { rows: [{ id: 1, campus_id: 2, login_time: '09:00:00', logout_time: '16:00:00', grace_minutes: 10, weekdays: [1], effective_from: '2026-04-01' }] });
  assert.ok((await deleteFutureShift(future, 1, '2026-03-02')).ok);
  assert.equal(future.where(/delete from campus_shifts/).length, 1);
  assert.deepEqual(await deleteFutureShift(new FakeDb().on(/from campus_shifts where id/, { rows: [] }), 9, '2026-03-02'), { ok: false, error: 'Shift not found' });
});

test('registration: a number already used by someone else is refused', async () => {
  const input = { whatsapp: '919849136605', attendanceApplicable: true, reportsDuringVacations: null };
  const dup = new FakeDb()
    .on(/from attendance_employees where employee_id/, { rows: [] })
    .on(/insert into attendance_employees/, () => { throw uniqueViolation(); });
  assert.equal((await saveRegistration(dup, 7, input, 1) as { error: string }).error, 'That WhatsApp number is already registered to another employee');

  const db = new FakeDb()
    .on(/from attendance_employees where employee_id/, { rows: [{ employee_id: 7, whatsapp_e164: '919849136605', attendance_applicable: true, reports_during_vacations: false }] })
    .on(/insert into attendance_employees/, { rowCount: 1 });
  const saved = await saveRegistration(db, 7, input, 1);
  assert.ok(saved.ok && saved.value.after.whatsapp === '919849136605');
  const insert = db.where(/insert into attendance_employees/)[0];
  assert.equal(insert.params[4], null, 'no vacation choice sent: the saved value is kept');
  assert.match(insert.text, /reports_during_vacations = coalesce\(\$5::boolean, attendance_employees\.reports_during_vacations\)/);
  const withFlag = new FakeDb().on(/from attendance_employees where employee_id/, { rows: [{ employee_id: 7, whatsapp_e164: null, attendance_applicable: true, reports_during_vacations: true }] }).on(/insert into attendance_employees/, { rowCount: 1 });
  const flagged = await saveRegistration(withFlag, 7, { ...input, reportsDuringVacations: true }, 1);
  assert.ok(flagged.ok && flagged.value.after.reportsDuringVacations === true);
  assert.equal(withFlag.where(/insert into attendance_employees/)[0].params[4], true);
});

const assignmentView = (over: Record<string, unknown>) => ({
  id: 9, employee_id: 7, campus_id: 2, campus_name: 'Main', kind: 'PRIMARY', mode: 'REPLACE',
  start_date: '2026-03-02', end_date: null, note: null, ...over,
});

function assignmentDb(open: unknown[], campusActive = true) {
  return new FakeDb()
    .on(/select 1 from employees/, { rows: [{ '?column?': 1 }] })
    .on(/select is_active from campuses/, { rows: campusActive ? [{ is_active: true }] : [{ is_active: false }] })
    .on(/where employee_id = \$1 and kind = 'PRIMARY' and end_date is null/, { rows: open })
    .on(/insert into employee_campus_assignments/, { rows: [{ id: 9 }] })
    .on(/from employee_campus_assignments a join campuses c/, { rows: [assignmentView({})] })
    .on(/update employee_campus_assignments/, { rowCount: 1 });
}

test('a new primary campus closes the old one the day before, in one transaction', async () => {
  const db = assignmentDb([{ id: 4, start_date: '2025-06-01', campus_id: 8 }]);
  const result = await createAssignment(db.asPool(), 7, { campusId: 2, kind: 'PRIMARY', mode: 'REPLACE', startDate: '2026-03-02', endDate: null, note: null }, 1);
  assert.ok(result.ok);
  const close = db.where(/update employee_campus_assignments/)[0];
  assert.deepEqual(close.params, [4, '2026-03-01']);
  assert.equal(db.calls[0].text, 'begin');
  assert.equal(db.calls[db.calls.length - 1].text, 'commit');
});

test('primary campus changes are refused when they make no sense', async () => {
  const sameCampus = assignmentDb([{ id: 4, start_date: '2025-06-01', campus_id: 2 }]);
  const same = await createAssignment(sameCampus.asPool(), 7, { campusId: 2, kind: 'PRIMARY', mode: 'REPLACE', startDate: '2026-03-02', endDate: null, note: null }, 1);
  assert.deepEqual(same, { ok: false, error: 'That is already the primary campus' });

  const earlier = assignmentDb([{ id: 4, start_date: '2026-03-05', campus_id: 8 }]);
  const tooEarly = await createAssignment(earlier.asPool(), 7, { campusId: 2, kind: 'PRIMARY', mode: 'REPLACE', startDate: '2026-03-02', endDate: null, note: null }, 1);
  assert.ok(!tooEarly.ok && /Choose a later start date/.test(tooEarly.error));
  assert.equal(earlier.where(/insert into employee_campus_assignments/).length, 0);

  const inactive = assignmentDb([], false);
  assert.deepEqual(await createAssignment(inactive.asPool(), 7, { campusId: 2, kind: 'TEMPORARY', mode: 'REPLACE', startDate: '2026-03-02', endDate: '2026-03-03', note: null }, 1),
    { ok: false, error: 'That campus is not active' });
});

test('a temporary assignment does not touch the primary', async () => {
  const db = assignmentDb([{ id: 4, start_date: '2025-06-01', campus_id: 8 }]);
  const result = await createAssignment(db.asPool(), 7, { campusId: 2, kind: 'TEMPORARY', mode: 'ADDITIONAL', startDate: '2026-03-02', endDate: '2026-03-06', note: null }, 1);
  assert.ok(result.ok);
  assert.equal(db.where(/update employee_campus_assignments/).length, 0);
});

test('removing an assignment: not started is deleted, in progress is ended yesterday, finished is refused', async () => {
  const today = '2026-03-10';
  const pick = (row: Record<string, unknown>) => new FakeDb()
    .on(/select employee_id from employee_campus_assignments/, { rows: [{ employee_id: 7 }] })
    .on(/from employee_campus_assignments a join campuses c/, { rows: [assignmentView(row)] })
    .on(/delete from employee_campus_assignments/, { rowCount: 1 })
    .on(/update employee_campus_assignments/, { rowCount: 1 });

  const future = pick({ start_date: '2026-03-15', end_date: '2026-03-20', kind: 'TEMPORARY' });
  const deleted = await removeAssignment(future, 9, today);
  assert.ok(deleted.ok && deleted.value.action === 'DELETED');

  const running = pick({ start_date: '2026-03-01', end_date: null });
  const ended = await removeAssignment(running, 9, today);
  assert.ok(ended.ok && ended.value.action === 'ENDED');
  assert.deepEqual(running.where(/update employee_campus_assignments/)[0].params, [9, '2026-03-09']);

  const startsToday = pick({ start_date: today, end_date: null });
  assert.ok((await removeAssignment(startsToday, 9, today) as { value: { action: string } }).value.action === 'DELETED');

  const over = pick({ start_date: '2026-02-01', end_date: '2026-02-10', kind: 'TEMPORARY' });
  assert.deepEqual(await removeAssignment(over, 9, today), { ok: false, error: 'That assignment has already ended' });
  assert.deepEqual(await removeAssignment(new FakeDb().on(/select employee_id/, { rows: [] }), 9, today), { ok: false, error: 'Assignment not found' });
});

// ── Setup checklist ───────────────────────────────────────────────────────────
const counts = { campuses: 2, campusesWithLocation: 2, campusesWithShift: 2, activeEmployees: 50, registeredNumbers: 50, withPrimaryCampus: 50 };
const readyEnv = {
  ATTENDANCE_ENABLED: 'true', ATTENDANCE_WA_MODE: 'live', ATTENDANCE_WA_ACCESS_TOKEN: 'SECRET-TOKEN-VALUE', ATTENDANCE_WA_PHONE_NUMBER_ID: '1',
  ATTENDANCE_WA_GRAPH_VERSION: 'v21.0', ATTENDANCE_WA_APP_SECRET: 's', ATTENDANCE_WA_VERIFY_TOKEN: 'v', ATTENDANCE_SWEEP_SECRET: 'w',
  APP_BASE_URL: 'https://portal.test',
};
const withDirector = { ...SETTING_DEFAULTS, directorWhatsapp: '919000000001' };

test('the checklist is complete only when everything is in place', () => {
  const settings = withDirector;
  const full = buildChecklist(counts, settings, readEnvFlags(readyEnv, settings));
  assert.ok(full.every(item => item.done), JSON.stringify(full.filter(i => !i.done)));
  assert.equal(full.length, 10);
});

test('the checklist says exactly what is missing, and never reveals secret values', () => {
  const empty = { campuses: 0, campusesWithLocation: 0, campusesWithShift: 0, activeEmployees: 0, registeredNumbers: 0, withPrimaryCampus: 0 };
  const flags = readEnvFlags({}, SETTING_DEFAULTS);
  const items = buildChecklist(empty, SETTING_DEFAULTS, flags);
  assert.ok(items.every(i => !i.done));
  assert.match(items.find(i => i.key === 'whatsapp')!.detail, /Test mode: messages are recorded but NOT sent/);
  assert.match(items.find(i => i.key === 'enabled')!.detail, /ATTENDANCE_ENABLED=true/);
  assert.equal(items.find(i => i.key === 'director')!.tab, 'settings');

  const partial = buildChecklist({ ...counts, campusesWithLocation: 1, registeredNumbers: 30 }, withDirector, readEnvFlags(readyEnv, withDirector));
  assert.equal(partial.find(i => i.key === 'location')!.done, false);
  assert.match(partial.find(i => i.key === 'location')!.detail, /1 of 2/);
  assert.match(partial.find(i => i.key === 'numbers')!.detail, /30 of 50/);

  // Neither the checklist nor the flags ever carry a secret value or the Director's number.
  const everything = JSON.stringify([buildChecklist(counts, withDirector, readEnvFlags(readyEnv, withDirector)), readEnvFlags(readyEnv, withDirector)]);
  assert.ok(!everything.includes('SECRET-TOKEN-VALUE'));
  assert.ok(!everything.includes('919000000001'));
  const live = readEnvFlags({ ...readyEnv, ATTENDANCE_WA_ACCESS_TOKEN: '' }, withDirector);
  assert.match(buildChecklist(counts, withDirector, live).find(i => i.key === 'whatsapp')!.detail, /missing/);
});
