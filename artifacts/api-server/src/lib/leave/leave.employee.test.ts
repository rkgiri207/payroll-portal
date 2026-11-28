import assert from 'node:assert/strict';
import test from 'node:test';
import { FakeDb } from '../attendance/testSupport';
import { hashToken, isTokenShape } from '../attendance/token';
import { balanceText, cancelForm, getFormInfo, leaveFormText, previewForm, submitForm, type Notifier } from './employeeLeave';
import { createFormToken, lookupFormToken, markFormTokenUsed } from './formTokens';

const NOW = new Date('2026-09-01T05:00:00Z');
const TOKEN = 'b'.repeat(43);
const row = (over: Record<string, unknown> = {}) => ({
  id: 'tok-1', employee_id: 7, purpose: 'LEAVE', expires_at: new Date('2026-09-01T05:30:00Z'), used_at: null, ...over,
});
const silent: Notifier = { requestSubmitted: async () => {}, replyToEmployee: async () => {} };

test('a new link is random, only its hash is stored, and a duplicate WhatsApp message makes none', async () => {
  const db = new FakeDb().on(/insert into form_tokens/, { rows: [{ id: 'tok-1', expires_at: new Date('2026-09-01T05:30:00Z') }] });
  const made = await createFormToken(db, { employeeId: 7, purpose: 'LEAVE', ttlMinutes: 30, sourceMessageId: 'wamid.1', now: NOW });
  assert.ok(made && isTokenShape(made.token));
  const call = db.calls[0];
  assert.equal(call.params[0], hashToken(made.token), 'the database gets the hash');
  assert.ok(!call.params.includes(made.token), 'the token itself is never sent to the database');
  assert.deepEqual(call.params.slice(1), [7, 'LEAVE', NOW.toISOString(), '30', 'wamid.1']);
  const second = await createFormToken(new FakeDb().on(/insert into form_tokens/, { rows: [] }), { employeeId: 7, purpose: 'LEAVE', ttlMinutes: 30, sourceMessageId: 'wamid.1', now: NOW });
  assert.equal(second, null);
  const another = await createFormToken(new FakeDb().on(/insert into form_tokens/, { rows: [{ id: 'x', expires_at: NOW }] }), { employeeId: 7, purpose: 'LEAVE', ttlMinutes: 30, sourceMessageId: 'wamid.2', now: NOW });
  assert.notEqual(another?.token, made.token);
});

test('a link is open, used, expired, or not found', async () => {
  const state = async (over: Record<string, unknown> | null, token: unknown = TOKEN, purpose: 'LEAVE' | 'PERMISSION' = 'LEAVE') =>
    (await lookupFormToken(new FakeDb().on(/from form_tokens/, { rows: over ? [row(over)] : [] }), token, purpose, NOW)).state;
  assert.equal(await state({}), 'OPEN');
  assert.equal(await state({ used_at: new Date() }), 'USED');
  assert.equal(await state({ expires_at: new Date('2026-09-01T04:59:59Z') }), 'EXPIRED');
  assert.equal(await state({ expires_at: new Date('2026-09-01T05:00:00Z') }), 'EXPIRED', 'expiry is exclusive');
  assert.equal(await state(null), 'NOT_FOUND');
  assert.equal(await state({ purpose: 'PERMISSION' }), 'NOT_FOUND', 'a permission link does not open the leave form');
  assert.equal(await state({}, 'short'), 'NOT_FOUND');
  assert.equal(await state({}, null), 'NOT_FOUND');
  assert.equal(await state({ used_at: new Date(), expires_at: new Date('2026-09-01T04:00:00Z') }), 'EXPIRED', 'expired wins over used');
  const db = new FakeDb().on(/from form_tokens/, { rows: [] });
  await lookupFormToken(db, 'short', 'LEAVE', NOW);
  assert.equal(db.calls.length, 0, 'a malformed token never reaches the database');
});

test('a link can be marked used only once', async () => {
  assert.equal(await markFormTokenUsed(new FakeDb().on(/update form_tokens/, { rows: [{ id: 'tok-1' }] }), 'tok-1'), true);
  assert.equal(await markFormTokenUsed(new FakeDb().on(/update form_tokens/, { rows: [] }), 'tok-1'), false);
  const db = new FakeDb().on(/update form_tokens/, { rows: [{ id: 'tok-1' }] });
  await markFormTokenUsed(db, 'tok-1');
  assert.match(db.calls[0].text, /used_at is null/);
});

test('closed links answer without doing anything else', async () => {
  for (const [over, http, state] of [
    [{ used_at: new Date() }, 410, 'USED'], [{ expires_at: new Date('2026-09-01T04:00:00Z') }, 410, 'EXPIRED'], [null, 404, 'NOT_FOUND'],
  ] as [Record<string, unknown> | null, number, string][]) {
    const db = new FakeDb().on(/from form_tokens/, { rows: over ? [row(over)] : [] });
    const deps = { pool: db.asPool(), now: () => NOW };
    for (const reply of [await getFormInfo(deps, TOKEN), await previewForm(deps, TOKEN, {}), await submitForm({ ...deps, notify: silent }, TOKEN, {})]) {
      assert.equal(reply.http, http);
      assert.equal(reply.body.state, state);
    }
    assert.equal(db.where(/insert into|update /).length, 0, 'nothing is written for a closed link');
    assert.equal(db.where(/from leave_requests|from leave_types/).length, 0, 'and no leave data is read');
  }
});

test('cancelling still works on a used link (the employee just sent a request), but not on an expired one', async () => {
  const used = new FakeDb().on(/from form_tokens/, { rows: [row({ used_at: new Date() })] }).on(/for update/, { rows: [] });
  const r = await cancelForm({ pool: used.asPool(), now: () => NOW }, TOKEN, { requestId: '8a3f1c52-7d1e-4b0a-9a55-0c2f6b8d1e77' });
  assert.equal(r.http, 404, 'reached the cancel logic (request not found), not blocked by the used link');
  const expired = new FakeDb().on(/from form_tokens/, { rows: [row({ expires_at: new Date('2026-09-01T04:00:00Z') })] });
  assert.equal((await cancelForm({ pool: expired.asPool(), now: () => NOW }, TOKEN, { requestId: '8a3f1c52-7d1e-4b0a-9a55-0c2f6b8d1e77' })).http, 410);
});

test('bad input is refused plainly before any leave data is touched', async () => {
  const db = new FakeDb().on(/from form_tokens/, { rows: [row()] });
  const deps = { pool: db.asPool(), now: () => NOW };
  for (const body of [undefined, {}, { leaveTypeId: 'x', startDate: '2026-09-07' }, { leaveTypeId: 1 }, { leaveTypeId: 1, startDate: '2026-09-07', dayMode: 'QUARTER' }]) {
    const p = await previewForm(deps, TOKEN, body as Record<string, unknown>);
    assert.equal(p.http, 400, JSON.stringify(body));
    assert.equal(p.body.code, 'INVALID_INPUT');
    const s = await submitForm({ ...deps, notify: silent }, TOKEN, body as Record<string, unknown>);
    assert.equal(s.http, 400);
  }
  assert.equal((await cancelForm(deps, TOKEN, { requestId: 'drop table' })).http, 400);
  assert.equal(db.where(/from leave_requests|insert into leave/).length, 0);
});

test('the WhatsApp message with the link says how long it works and not to share it', () => {
  const text = leaveFormText('https://portal.test/l/abc', 30);
  assert.match(text, /^Open this link to apply for leave:\nhttps:\/\/portal\.test\/l\/abc/);
  assert.match(text, /works for 30 minutes/);
  assert.match(text, /Do not share it with anyone\.$/);
});

test('the BALANCE reply: per-year balances, or a clear message when nothing is set up', async () => {
  const none = new FakeDb().on(/from academic_years/, { rows: [] });
  assert.equal(await balanceText(none, 7, '2026-09-01'), 'No academic year is set up for today. Please contact the school administration.');

  const year = { id: 3, label: '2026-27', start_date: '2026-06-12', end_date: '2027-04-23' };
  const only = new FakeDb().on(/from academic_years/, { rows: [year] }).on(/from leave_types t/, { rows: [
    { id: 4, name: 'Unpaid Leave', is_paid: false, tracks_balance: false, available: 0, allow_half_day: null, min_notice_days: null, max_consecutive_days: null },
  ] });
  assert.match(await balanceText(only, 7, '2026-09-01'), /No leave balance is set up for 2026-27 yet/);

  const db = new FakeDb().on(/from academic_years/, { rows: [year] }).on(/from leave_types t/, { rows: [
    { id: 1, name: 'Casual Leave', is_paid: true, tracks_balance: true, available: 1, allow_half_day: true, min_notice_days: 0, max_consecutive_days: null },
    { id: 2, name: 'Sick Leave', is_paid: true, tracks_balance: true, available: 4.5, allow_half_day: false, min_notice_days: 0, max_consecutive_days: null },
    { id: 4, name: 'Unpaid Leave', is_paid: false, tracks_balance: false, available: 0, allow_half_day: null, min_notice_days: null, max_consecutive_days: null },
  ] });
  const text = await balanceText(db, 7, '2026-09-01');
  assert.equal(text, 'Your leave balance for 2026-27 (available now, after any requests waiting for approval):\nCasual Leave: 1 day\nSick Leave: 4.5 days\n\nTo apply for leave, send LEAVE.');
  assert.deepEqual(db.where(/from leave_types t/)[0].params, [7, 3], 'only this employee, only this academic year');
});
