import assert from 'node:assert/strict';
import test from 'node:test';
import { FakeDb } from '../attendance/testSupport';
import { monthlyWorkingDays, type HolidayRow } from './calendar';
import {
  confirmYear, createAcademicYear, createHoliday, deleteHoliday, importTemplate, updateAcademicYear, updateHoliday,
} from './calendarStore';
import { AP_2026_27, findTemplate } from './calendarTemplates';
import { validateAcademicYear, validateHoliday, validateImportDates } from './calendarValidation';

const asRows = (t = AP_2026_27): HolidayRow[] =>
  t.holidays.map(h => ({ kind: h.kind, status: 'DRAFT', startDate: h.startDate, endDate: h.endDate, campusId: null }));

test('the built-in AP 2026-27 template reproduces every printed monthly figure', () => {
  const months = monthlyWorkingDays(AP_2026_27.startDate, AP_2026_27.endDate, asRows());
  assert.deepEqual(Object.fromEntries(months.map(m => [m.month, m.workingDays])), AP_2026_27.printedWorkingDays);
  assert.equal(months.reduce((a, m) => a + m.workingDays, 0), 229);
});

test('the template has 45 rows inside its academic year and no duplicates', () => {
  assert.equal(AP_2026_27.holidays.length, 45);
  const kinds = new Map<string, number>();
  for (const h of AP_2026_27.holidays) {
    kinds.set(h.kind, (kinds.get(h.kind) ?? 0) + 1);
    assert.ok(h.startDate >= AP_2026_27.startDate && h.endDate <= AP_2026_27.endDate, h.name);
  }
  assert.deepEqual(Object.fromEntries(kinds), { HOLIDAY: 18, VACATION: 2, WEEKLY_OFF: 10, OPTIONAL: 15 });
  assert.equal(new Set(AP_2026_27.holidays.map(h => `${h.name}|${h.startDate}`)).size, 45);
  assert.equal(findTemplate('ap-2026-27'), AP_2026_27);
  assert.equal(findTemplate('nope'), null);
});

test('academic year validation', () => {
  assert.deepEqual(validateAcademicYear({ label: ' 2027-28 ', startDate: '2027-06-12', endDate: '2028-04-23' }),
    { ok: true, value: { label: '2027-28', startDate: '2027-06-12', endDate: '2028-04-23', accrualFrom: null } });
  // The month leave starts being credited from: optional, and it must sit inside the year.
  assert.deepEqual(validateAcademicYear({ label: '2026-27', startDate: '2026-06-12', endDate: '2027-04-23', accrualFrom: '2026-12-01' }),
    { ok: true, value: { label: '2026-27', startDate: '2026-06-12', endDate: '2027-04-23', accrualFrom: '2026-12-01' } });
  assert.deepEqual(validateAcademicYear({ label: '2026-27', startDate: '2026-06-12', endDate: '2027-04-23', accrualFrom: '' }),
    { ok: true, value: { label: '2026-27', startDate: '2026-06-12', endDate: '2027-04-23', accrualFrom: null } });
  for (const accrualFrom of ['2026-05-01', '2027-05-01', '2026-02-30', 'December']) {
    const r = validateAcademicYear({ label: 'x', startDate: '2026-06-12', endDate: '2027-04-23', accrualFrom });
    assert.ok(!r.ok && /accrue-from/.test(r.error), accrualFrom);
  }
  const errors: [unknown, string][] = [
    [null, 'Send the academic year'], [{ label: '', startDate: '2027-06-12', endDate: '2028-04-23' }, 'Year name is required'],
    [{ label: 'x', startDate: '2027-02-30', endDate: '2028-04-23' }, 'Start date'],
    [{ label: 'x', startDate: '2027-06-12', endDate: 'soon' }, 'End date'],
    [{ label: 'x', startDate: '2027-06-12', endDate: '2027-06-12' }, 'after the start'],
  ];
  for (const [body, fragment] of errors) {
    const r = validateAcademicYear(body);
    assert.ok(!r.ok && r.error.includes(fragment), `${JSON.stringify(body)}`);
  }
});

test('holiday validation: single day default, kinds, campus', () => {
  const r = validateHoliday({ name: ' Diwali ', kind: 'HOLIDAY', startDate: '2026-11-08' });
  assert.deepEqual(r, { ok: true, value: { name: 'Diwali', kind: 'HOLIDAY', startDate: '2026-11-08', endDate: '2026-11-08', campusId: null } });
  const campus = validateHoliday({ name: 'X', kind: 'VACATION', startDate: '2026-11-08', endDate: '2026-11-10', campusId: '3' });
  assert.ok(campus.ok && campus.value.campusId === 3);
  for (const body of [
    { name: '', kind: 'HOLIDAY', startDate: '2026-11-08' }, { name: 'X', kind: 'PARTY', startDate: '2026-11-08' },
    { name: 'X', kind: 'HOLIDAY', startDate: '2026-11-08', endDate: '2026-11-07' },
    { name: 'X', kind: 'HOLIDAY', startDate: '2026-11-08', campusId: 'abc' }, { name: 'X', kind: 'HOLIDAY', startDate: 'bad' },
  ]) assert.ok(!validateHoliday(body).ok, JSON.stringify(body));
});

const pgError = (code: string, message = 'db error') => Object.assign(new Error(message), { code });
const failing = (code: string, message?: string) => new FakeDb().on(/insert|update/, { rows: [] }).asPool()
  && ({ query: async () => { throw pgError(code, message); } });

test('creating an overlapping year or a duplicate gives a friendly message', async () => {
  const input = { label: '2026-27', startDate: '2026-06-12', endDate: '2027-04-23' };
  const overlap = await createAcademicYear(failing('23P01'), input, 1);
  assert.ok(!overlap.ok && overlap.status === 409 && overlap.error.includes('overlap'));
  const dup = await createAcademicYear(failing('23505'), input, 1);
  assert.ok(!dup.ok && dup.error.includes('already exists'));
  await assert.rejects(createAcademicYear(failing('XX000'), input, 1));
});

test('a holiday outside its year or a duplicate gives a friendly message', async () => {
  const input = { name: 'X', kind: 'HOLIDAY' as const, startDate: '2026-05-01', endDate: '2026-05-01', campusId: null };
  const outside = await createHoliday(failing('P0001', 'holiday X is outside academic year 2026-27'), 1, input, 1);
  assert.ok(!outside.ok && outside.error.includes('inside the academic year'));
  const dup = await createHoliday(failing('23505'), 1, input, 1);
  assert.ok(!dup.ok && dup.error.includes('already in the calendar'));
});

test('import creates the year when missing, adds rows as drafts, and is repeatable', async () => {
  const db = new FakeDb()
    .on(/select id, to_char/, { rows: [] })
    .on(/insert into academic_years/, { rows: [{ id: 7 }] })
    .on(/insert into holidays/, { rowCount: 45 });
  const first = await importTemplate(db, AP_2026_27, 1);
  assert.deepEqual(first, { ok: true, value: { yearId: 7, yearCreated: true, holidaysAdded: 45, yearStartDate: '2026-06-12', yearEndDate: '2027-04-23', skipped: [] } });
  const insert = db.where(/insert into holidays/)[0];
  assert.ok(!/CONFIRMED/.test(insert.text), 'imported rows must stay DRAFT (the column default)');
  assert.ok(/on conflict do nothing/.test(insert.text));
  assert.equal((insert.params[1] as string[]).length, 45);

  const again = new FakeDb()
    .on(/select id, to_char/, { rows: [{ id: 7, start_date: '2026-06-12', end_date: '2027-04-23' }] })
    .on(/insert into holidays/, { rowCount: 0 });
  assert.deepEqual(await importTemplate(again, AP_2026_27, 1), { ok: true, value: { yearId: 7, yearCreated: false, holidaysAdded: 0, yearStartDate: '2026-06-12', yearEndDate: '2027-04-23', skipped: [] } });
  assert.equal(again.where(/insert into academic_years/).length, 0);
});

test('confirm only touches draft rows of the chosen year and records who confirmed', async () => {
  const db = new FakeDb().on(/update holidays/, { rowCount: 45 });
  assert.equal(await confirmYear(db, 7, 3), 45);
  const call = db.calls[0];
  assert.match(call.text, /status = 'DRAFT'/);
  assert.deepEqual(call.params, [7, 3]);
});

test('update and delete report a missing holiday', async () => {
  const input = { name: 'X', kind: 'HOLIDAY' as const, startDate: '2026-11-08', endDate: '2026-11-08', campusId: null };
  const missing = await updateHoliday(new FakeDb(), 99, input);
  assert.ok(!missing.ok && missing.status === 404);
  assert.equal(await deleteHoliday(new FakeDb(), 99), null);
});

test('import into a new year with the organisation\'s own dates skips and reports official dates outside it', async () => {
  const db = new FakeDb()
    .on(/select id, to_char/, { rows: [] })
    .on(/insert into academic_years/, { rows: [{ id: 9 }] })
    .on(/insert into holidays/, { rowCount: 40 });
  const result = await importTemplate(db, AP_2026_27, 1, { startDate: '2026-06-15', endDate: '2027-04-10' });
  assert.ok(result.ok);
  assert.equal(result.value.yearStartDate, '2026-06-15');
  assert.deepEqual(db.where(/insert into academic_years/)[0].params.slice(1, 3), ['2026-06-15', '2027-04-10']);
  const skippedNames = result.value.skipped.map(h => `${h.name} ${h.startDate}`);
  // before the first day: Second Saturday 13 Jun and optional 9th Moharram 25 Jun is inside; after the last day: 14 Apr onwards
  assert.ok(skippedNames.includes('Second Saturday 2026-06-13'));
  assert.ok(skippedNames.includes('Dr. B.R. Ambedkar Jayanthi 2027-04-14'));
  assert.ok(!skippedNames.includes('Moharram 2026-06-26'));
  const sent = db.where(/insert into holidays/)[0].params[1] as string[];
  assert.equal(sent.length + result.value.skipped.length, 45);
});

test('an existing year keeps its own dates when the calendar is imported again', async () => {
  const db = new FakeDb()
    .on(/select id, to_char/, { rows: [{ id: 7, start_date: '2026-06-20', end_date: '2027-04-30' }] })
    .on(/insert into holidays/, { rowCount: 0 });
  const result = await importTemplate(db, AP_2026_27, 1, { startDate: '2000-01-01', endDate: '2000-12-31' });
  assert.ok(result.ok && !result.value.yearCreated && result.value.yearStartDate === '2026-06-20');
  assert.equal(db.where(/insert into academic_years/).length, 0);
});

test('import dates: empty means official, otherwise both are required and ordered', () => {
  assert.deepEqual(validateImportDates({}), { ok: true, value: null });
  assert.deepEqual(validateImportDates(undefined), { ok: true, value: null });
  assert.deepEqual(validateImportDates({ startDate: '2026-06-15', endDate: '2027-04-10' }), { ok: true, value: { startDate: '2026-06-15', endDate: '2027-04-10' } });
  for (const body of [{ startDate: '2026-06-15' }, { startDate: 'x', endDate: '2027-04-10' }, { startDate: '2027-04-10', endDate: '2026-06-15' }]) {
    assert.ok(!validateImportDates(body).ok, JSON.stringify(body));
  }
});

test('editing a year: not found, refused when records would fall outside, friendly overlap', async () => {
  const input = { label: '2026-27', startDate: '2026-06-15', endDate: '2027-04-10' };
  const missing = await updateAcademicYear(new FakeDb(), 99, input);
  assert.ok(!missing.ok && missing.status === 404);

  const year = { id: 7, label: '2026-27', start_date: '2026-06-12', end_date: '2027-04-23', draft_count: 0, confirmed_count: 0 };
  const guarded = {
    query: async (text: string) => {
      if (/update academic_years/.test(text)) {
        throw Object.assign(new Error('these dates cannot be used for academic year 2026-27: 0 holiday(s), 2 leave request(s), 0 ledger entr(ies) and 0 permission(s) would fall outside them'), { code: 'LY003' });
      }
      return { rows: [year], rowCount: 1 };
    },
  };
  const refused = await updateAcademicYear(guarded as never, 7, input);
  assert.ok(!refused.ok && refused.status === 409 && /2 leave request/.test(refused.error) && /^These dates/.test(refused.error));

  const overlapping = { query: async (text: string) => { if (/update academic_years/.test(text)) throw Object.assign(new Error('x'), { code: '23P01' }); return { rows: [year], rowCount: 1 }; } };
  const overlap = await updateAcademicYear(overlapping as never, 7, input);
  assert.ok(!overlap.ok && /overlap/.test(overlap.error));
});
