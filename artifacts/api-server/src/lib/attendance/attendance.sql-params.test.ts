/**
 * Every query's numbered placeholders ($1, $2, ...) must match the parameters supplied. A real
 * PostgreSQL rejects a mismatch at run time, and the earlier tests could not see it because
 * their fake database did not check. The fake now checks (see testSupport.ts); this file makes
 * sure each read and list function is actually executed through it.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  countPendingReview, getCampusRow, getCampusSummaries, getEmployeeProfile, getRegistration, getSelfiePath,
  getSetupCounts, getTodayFeed, listAlertProblems, listAssignments, listCampuses, listEmployees,
  listPendingReview, listShiftViews, listUnmarked, reviewEvent,
} from './adminStore';
import { findEmployeeByWhatsApp, getCampus, getEmployeeContact, getShifts, listAllowedCampuses } from './campusData';
import { findEventByToken, findValidEvent } from './eventStore';
import { listExceptions, openException, reviewException } from './exceptionStore';
import { applyDeliveryStatus } from './outboxStore';
import { countActivitySince, findInsWithoutOut, getDaySummary } from './rosterStore';
import { loadRawSettings, loadSettings, updateSetting } from './settings';
import { assertPlaceholdersMatch, FakeDb } from './testSupport';

test('the placeholder check itself catches the mistake that broke the employee list', () => {
  assert.doesNotThrow(() => assertPlaceholdersMatch('select $1, $2', ['a', 'b']));
  assert.doesNotThrow(() => assertPlaceholdersMatch('select 1', []));
  assert.doesNotThrow(() => assertPlaceholdersMatch('select $1, $1', ['a']));            // reuse is fine
  assert.throws(() => assertPlaceholdersMatch('select $2, $3', ['a', 'b', 'c']), /mismatch/); // $1 never used
  assert.throws(() => assertPlaceholdersMatch('select $1', ['a', 'b']), /mismatch/);           // too many parameters
  assert.throws(() => assertPlaceholdersMatch('select $1, $2', ['a']), /mismatch/);            // too few
});

const DATE = '2026-03-02';
const UUID = '11111111-1111-1111-1111-111111111111';

/** Run a function; only a placeholder mismatch counts as a failure (other errors come from the empty fake data). */
async function mustNotMismatch(name: string, fn: (db: FakeDb) => Promise<unknown>, db = new FakeDb()): Promise<void> {
  try {
    await fn(db);
  } catch (error) {
    if (error instanceof Error && /SQL placeholder mismatch/.test(error.message)) {
      assert.fail(`${name}: ${error.message}`);
    }
  }
  assert.ok(db.calls.length > 0, `${name} ran no query`);
}

test('admin read queries use matching placeholders', async () => {
  await mustNotMismatch('listCampuses', db => listCampuses(db, DATE));
  await mustNotMismatch('getCampusRow', db => getCampusRow(db, 1));
  await mustNotMismatch('listShiftViews', db => listShiftViews(db, 1));
  await mustNotMismatch('listEmployees (no filter)', db => listEmployees(db, { today: DATE, search: null, status: null, limit: 50, offset: 0 }));
  await mustNotMismatch('listEmployees (search + status)', db => listEmployees(db, { today: DATE, search: 'asha_%', status: 'ACTIVE', limit: 50, offset: 50 }));
  await mustNotMismatch('getRegistration', db => getRegistration(db, 7));
  await mustNotMismatch('listAssignments', db => listAssignments(db, 7));
  await mustNotMismatch('getCampusSummaries', db => getCampusSummaries(db, DATE, 1));
  await mustNotMismatch('listUnmarked', db => listUnmarked(db, DATE, 1));
  await mustNotMismatch('getTodayFeed', db => getTodayFeed(db, DATE));
  await mustNotMismatch('listPendingReview', db => listPendingReview(db, DATE));
  await mustNotMismatch('countPendingReview', db => countPendingReview(db, DATE));
  await mustNotMismatch('listAlertProblems', db => listAlertProblems(db));
  await mustNotMismatch('getSelfiePath', db => getSelfiePath(db, UUID));
  await mustNotMismatch('getSetupCounts', db => getSetupCounts(db, DATE));
});

test('the employee list asks the database for the total with its own, correctly numbered parameters', async () => {
  const db = new FakeDb();
  await listEmployees(db, { today: DATE, search: 'asha', status: 'ACTIVE', limit: 50, offset: 0 });
  const [list, count] = db.calls;
  assert.deepEqual(list.params, [DATE, '%asha%', 'ACTIVE', 50, 0]);
  assert.deepEqual(count.params, ['%asha%', 'ACTIVE']);                 // no stray today parameter
  assert.match(count.text, /\$1::text is null/);
  assert.match(count.text, /\$2::text is null/);
});

test('queries that need a row first still use matching placeholders on every step', async () => {
  const withReview = new FakeDb().on(/select review_status from attendance_events/, { rows: [{ review_status: 'PENDING' }] });
  await mustNotMismatch('reviewEvent', db => reviewEvent(db, UUID, 1, 'APPROVED', null), withReview);
  assert.equal(withReview.calls.length, 2);                              // the select AND the update both ran

  const withEmployee = new FakeDb().on(/from employees where id/, { rows: [{
    id: 7, employee_code: 'T001', employee_name: 'Asha', designation: null, branch: null, status: 'ACTIVE',
  }] });
  await mustNotMismatch('getEmployeeProfile', db => getEmployeeProfile(db, 7, DATE), withEmployee);
  assert.ok(withEmployee.calls.length >= 4);                             // info, recent events, registration, assignments

  const withSetting = new FakeDb().on(/select value from attendance_settings/, { rows: [{ value: 10 }] });
  await mustNotMismatch('updateSetting', db => updateSetting(db, 'default_grace_minutes', 15, 1), withSetting);
  assert.equal(withSetting.calls.length, 2);
});

test('lookup, roster, exception, settings and outbox queries use matching placeholders', async () => {
  await mustNotMismatch('findEmployeeByWhatsApp', db => findEmployeeByWhatsApp(db, '919849136605'));
  await mustNotMismatch('listAllowedCampuses', db => listAllowedCampuses(db, 7, DATE));
  await mustNotMismatch('getCampus', db => getCampus(db, 1));
  await mustNotMismatch('getShifts', db => getShifts(db, 1));
  await mustNotMismatch('getEmployeeContact', db => getEmployeeContact(db, 7));
  await mustNotMismatch('findValidEvent', db => findValidEvent(db, 7, DATE, 'IN'));
  await mustNotMismatch('findEventByToken', db => findEventByToken(db, UUID));
  await mustNotMismatch('getDaySummary', db => getDaySummary(db, DATE, 1));
  await mustNotMismatch('countActivitySince', db => countActivitySince(db, new Date()));
  await mustNotMismatch('findInsWithoutOut', db => findInsWithoutOut(db, DATE, DATE));
  await mustNotMismatch('listExceptions (any status)', db => listExceptions(db));
  await mustNotMismatch('listExceptions (open)', db => listExceptions(db, { status: 'OPEN', limit: 20 }));
  await mustNotMismatch('openException', db => openException(db, { employeeId: 7, campusId: 1, workDate: DATE, kind: 'MISSING_OUT' }));
  await mustNotMismatch('reviewException', db => reviewException(db, UUID, 1, 'RESOLVED', 'ok'));
  await mustNotMismatch('loadSettings', db => loadSettings(db));
  await mustNotMismatch('loadRawSettings', db => loadRawSettings(db));
  await mustNotMismatch('applyDeliveryStatus', db => applyDeliveryStatus(db, 'wamid.X', 'DELIVERED', null));
});
