import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { cancelRequest, closedStateOf, loadForm, previewDraft, sendDraft, type Draft, type FormInfo } from './api';
import { canPreview, closedCopy, costLine, isSingleDay, minutesLeft, typeLabel } from './copy';
import { FormView, ScreenView, type FormProps, type PreviewState } from './LeaveFormPage';

const info = (over: Partial<FormInfo> = {}): FormInfo => ({
  name: 'Asha Rao', today: '2026-09-01', expiresAt: Date.now() + 25 * 60_000, year: { label: '2026-27', startDate: '2026-06-12', endDate: '2027-04-23' },
  leaveTypes: [
    { id: 1, name: 'Casual Leave', isPaid: true, tracksBalance: true, available: 3, allowHalfDay: true, minNoticeDays: 0, maxConsecutiveDays: null },
    { id: 2, name: 'Sick Leave', isPaid: true, tracksBalance: true, available: 1, allowHalfDay: false, minNoticeDays: 0, maxConsecutiveDays: null },
    { id: 4, name: 'Unpaid Leave', isPaid: false, tracksBalance: false, available: null, allowHalfDay: true, minNoticeDays: 0, maxConsecutiveDays: null },
  ],
  requests: [], ...over,
});
const draft = (over: Partial<Draft> = {}): Draft => ({ leaveTypeId: '', startDate: '', endDate: '', dayMode: 'FULL', reason: '', ...over });
const noop = () => {};
const props = (over: Partial<FormProps> = {}): FormProps => ({
  info: info(), draft: draft(), preview: { kind: 'idle' }, sending: false, problem: null, confirming: null, cancelling: false,
  onChange: noop, onSend: noop, onAskCancel: noop, onCancel: noop, ...over,
});
const view = (over: Partial<FormProps> = {}) => renderToStaticMarkup(<FormView {...props(over)} />);
const sendButton = (html: string) => html.match(/<button[^>]*>(?:(?!<\/button>).)*Send to the Director<\/button>/)?.[0] ?? '';
const complete = draft({ leaveTypeId: '1', startDate: '2026-09-07', endDate: '2026-09-08', reason: 'Family function' });
const ok = (over = {}): PreviewState => ({ kind: 'ok', totalDays: 2, paidDays: 2, lopDays: 0, ...over });

test('wording: balances, costs and closed links', () => {
  const [casual, , unpaid] = info().leaveTypes;
  assert.equal(typeLabel(casual), 'Casual Leave (3 days left)');
  assert.equal(typeLabel({ ...casual, available: 1 }), 'Casual Leave (1 day left)');
  assert.equal(typeLabel(unpaid), 'Unpaid Leave (no balance)');
  assert.equal(costLine({ kind: 'ok', totalDays: 2, paidDays: 2, lopDays: 0 }), '2 days, all paid');
  assert.equal(costLine({ kind: 'ok', totalDays: 3, paidDays: 1, lopDays: 2 }), '3 days: 1 paid, 2 without pay');
  assert.equal(costLine({ kind: 'ok', totalDays: 1, paidDays: 1, lopDays: 0 }), '1 day, all paid');
  for (const state of ['NOT_FOUND', 'EXPIRED', 'USED', 'UNAVAILABLE'] as const) assert.ok(closedCopy(state).title.length > 0);
  assert.match(closedCopy('EXPIRED').body, /send LEAVE on WhatsApp/i);
  assert.match(closedCopy('USED').body, /send LEAVE on WhatsApp/i);
});

test('helpers: when to ask the server, single-day rule, minutes left', () => {
  assert.equal(canPreview(draft()), false);
  assert.equal(canPreview(draft({ leaveTypeId: '1' })), false);
  assert.equal(canPreview(draft({ leaveTypeId: '1', startDate: '2026-09-07' })), true);
  assert.ok(isSingleDay(draft({ startDate: '2026-09-07' })) && isSingleDay(draft({ startDate: '2026-09-07', endDate: '2026-09-07' })));
  assert.ok(!isSingleDay(draft({ startDate: '2026-09-07', endDate: '2026-09-08' })));
  assert.equal(minutesLeft(1_000_000 + 90_000, 1_000_000), 2);
  assert.equal(minutesLeft(1_000_000 - 5, 1_000_000), 0);
});

test('the form greets the employee, lists leave types with balances and shows the academic year', () => {
  const html = view();
  assert.match(html, /Hello, Asha/);
  assert.match(html, /Academic year 2026-27/);
  assert.match(html, /Casual Leave \(3 days left\)/);
  assert.match(html, /Unpaid Leave \(no balance\)/);
  assert.match(html, /This link works for 2[45] more minutes/);
  assert.match(html, /min="2026-09-01"/, 'past dates cannot be picked');
});

test('Send stays off until the form is complete and the days have been checked', () => {
  assert.match(sendButton(view()), / disabled=""/);
  assert.match(sendButton(view({ draft: complete })), / disabled=""/, 'complete but not yet checked');
  assert.match(sendButton(view({ draft: complete, preview: { kind: 'checking' } })), / disabled=""/);
  assert.match(sendButton(view({ draft: { ...complete, reason: '  ' }, preview: ok() })), / disabled=""/, 'a reason is needed');
  assert.match(sendButton(view({ draft: complete, preview: { kind: 'refused', message: 'x' } })), / disabled=""/);
  const sending = view({ draft: complete, preview: ok(), sending: true }).match(/<button[^>]*>(?:(?!<\/button>).)*Sending…<\/button>/)?.[0] ?? '';
  assert.match(sending, / disabled=""/, 'no double sending');
  assert.ok(!/ disabled=""/.test(sendButton(view({ draft: complete, preview: ok() }))), 'ready to send');
});

test('the cost line and the without-pay note appear only when relevant', () => {
  const paid = view({ draft: complete, preview: ok() });
  assert.match(paid, /2 days, all paid/);
  assert.ok(!/decided by the Director/.test(paid));
  const lop = view({ draft: complete, preview: ok({ totalDays: 3, paidDays: 1, lopDays: 2 }) });
  assert.match(lop, /3 days: 1 paid, 2 without pay/);
  assert.match(lop, /Days without pay are decided by the Director, like every request\./);
  assert.match(view({ draft: complete, preview: { kind: 'refused', message: 'That date is a holiday.' } }), /That date is a holiday\./);
  assert.match(view({ draft: complete, preview: { kind: 'checking' } }), /Checking the days/);
});

test('half-day choice: only for a single date and only when the leave type allows it', () => {
  assert.ok(!/id="lf-mode"/.test(view({ draft: complete })), 'a range has no half-day');
  assert.match(view({ draft: draft({ leaveTypeId: '1', startDate: '2026-09-07' }) }), /id="lf-mode"/);
  assert.match(view({ draft: draft({ leaveTypeId: '1', startDate: '2026-09-07', endDate: '2026-09-07' }) }), /id="lf-mode"/);
  assert.ok(!/id="lf-mode"/.test(view({ draft: draft({ leaveTypeId: '2', startDate: '2026-09-07' }) })), 'sick leave does not allow half-days');
});

test('your requests: status words, cancel only for pending, and a confirm step', () => {
  const requests: FormInfo['requests'] = [
    { id: 'a', status: 'PENDING', leaveType: 'Casual Leave', dates: '07 Sep 2026', totalDays: 1, paidDays: 1, lopDays: 0, note: null, canCancel: true },
    { id: 'b', status: 'REJECTED', leaveType: 'Sick Leave', dates: '10 Sep 2026', totalDays: 1, paidDays: 0, lopDays: 1, note: 'Exams that week', canCancel: false },
    { id: 'c', status: 'APPROVED', leaveType: 'Casual Leave', dates: '14 Sep 2026', totalDays: 1, paidDays: 1, lopDays: 0, note: null, canCancel: false },
  ];
  const html = view({ info: info({ requests }) });
  assert.match(html, /Waiting for the Director/);
  assert.match(html, /Not approved · 1 without pay · Exams that week/);
  assert.match(html, /Approved/);
  assert.equal((html.match(/>Cancel<\/button>/g) ?? []).length, 1, 'only the pending request can be cancelled');
  const confirming = view({ info: info({ requests }), confirming: 'a' });
  assert.match(confirming, /Yes, cancel/);
  assert.match(confirming, /Keep it/);
  assert.ok(!/>Cancel<\/button>/.test(confirming));
  assert.ok(!/Your requests/.test(view()), 'no list when there are none');
});

const screen = (s: Parameters<typeof ScreenView>[0]['screen']) => renderToStaticMarkup(<ScreenView screen={s} formProps={null} onRetry={noop} />);

test('the other screens', () => {
  assert.match(screen({ name: 'loading' }), /Checking your link/);
  assert.match(screen({ name: 'closed', message: closedCopy('EXPIRED') }), /This link has expired/);
  assert.match(screen({ name: 'error', message: { title: 'Could not reach the server', body: 'Check.' } }), /Try again/);
  const sent = screen({ name: 'sent', dates: '07 Sep 2026 to 08 Sep 2026', totalDays: 2, paidDays: 1, lopDays: 1 });
  assert.match(sent, /Request sent/);
  assert.match(sent, /2 days: 1 paid, 1 without pay/);
  assert.match(sent, /You will get a WhatsApp message/);
  const full = screen({ name: 'full', message: 'Sorry, leave applications for this date have reached the maximum permitted limit of two employees for your campus.\n\nPlease select another date.' });
  assert.match(full, /This date is full/);
  assert.match(full, /maximum permitted limit of two employees/);
  assert.match(full, /send LEAVE on WhatsApp/i);
});

// ── Talking to the server ─────────────────────────────────────────────────────
const TOKEN = 'a'.repeat(43);
function stubFetch(status: number, body: unknown, seen: { url?: string; init?: RequestInit } = {}) {
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    seen.url = url; seen.init = init;
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return seen;
}
const realFetch = globalThis.fetch;

test('requests carry no cookies and no referrer, and the token only travels in the path', async () => {
  const seen = stubFetch(200, { ok: true, totalDays: 1, paidDays: 1, lopDays: 0 });
  await previewDraft(TOKEN, { leaveTypeId: '1', startDate: '2026-09-07', endDate: '', dayMode: 'FULL', reason: 'secret reason' });
  assert.equal(seen.url, `/api/leave-form/${TOKEN}/preview`);
  assert.equal(seen.init?.credentials, 'omit');
  assert.equal(seen.init?.referrerPolicy, 'no-referrer');
  assert.equal(seen.init?.cache, 'no-store');
  const sent = JSON.parse(String(seen.init?.body));
  assert.equal(sent.endDate, '2026-09-07', 'an empty last day means one day');
  assert.equal(sent.leaveTypeId, 1);
  globalThis.fetch = realFetch;
});

test('closed links are recognised from every endpoint', async () => {
  assert.equal(closedStateOf({ status: 410, body: { ok: false, state: 'EXPIRED' } }), 'EXPIRED');
  assert.equal(closedStateOf({ status: 410, body: { ok: false, state: 'USED' } }), 'USED');
  assert.equal(closedStateOf({ status: 404, body: { ok: false, state: 'NOT_FOUND' } }), 'NOT_FOUND');
  assert.equal(closedStateOf({ status: 404, body: { error: 'Not found' } }), 'UNAVAILABLE', 'a plain 404 means the module is off');
  assert.equal(closedStateOf({ status: 200, body: { ok: true } }), null);
  stubFetch(410, { ok: false, state: 'EXPIRED' });
  assert.deepEqual(await loadForm(TOKEN), { kind: 'closed', state: 'EXPIRED' });
  assert.deepEqual(await previewDraft(TOKEN, draft({ leaveTypeId: '1', startDate: '2026-09-07' })), { kind: 'closed', state: 'EXPIRED' });
  assert.deepEqual(await cancelRequest(TOKEN, 'x'), { kind: 'closed', state: 'EXPIRED' });
  globalThis.fetch = realFetch;
});

test('outcomes of sending: sent, full date, refused, network trouble', async () => {
  stubFetch(200, { ok: true, request: { id: 'r', dates: '07 Sep 2026', totalDays: 1, paidDays: 1, lopDays: 0 } });
  assert.deepEqual(await sendDraft(TOKEN, complete), { kind: 'sent', dates: '07 Sep 2026', totalDays: 1, paidDays: 1, lopDays: 0 });
  stubFetch(200, { ok: false, state: 'CAP_REACHED', message: 'Sorry, full.' });
  assert.deepEqual(await sendDraft(TOKEN, complete), { kind: 'full', message: 'Sorry, full.' });
  stubFetch(200, { ok: false, state: 'REFUSED', code: 'PAST_DATE', message: 'Past date.' });
  assert.deepEqual(await sendDraft(TOKEN, complete), { kind: 'refused', message: 'Past date.' });
  globalThis.fetch = (async () => { throw new Error('offline'); }) as typeof fetch;
  assert.deepEqual(await sendDraft(TOKEN, complete), { kind: 'error' });
  assert.deepEqual(await loadForm(TOKEN), { kind: 'error' });
  globalThis.fetch = realFetch;
});

test('loading turns the server clock into a countdown on this device', async () => {
  const serverNow = Date.now() - 3_600_000;                      // the server clock is an hour behind this phone
  stubFetch(200, {
    ok: true, name: 'Asha Rao', today: '2026-09-01', serverTime: new Date(serverNow).toISOString(), expiresAt: new Date(serverNow + 30 * 60_000).toISOString(),
    year: { label: '2026-27', startDate: '2026-06-12', endDate: '2027-04-23' }, leaveTypes: [], requests: [],
  });
  const out = await loadForm(TOKEN);
  assert.equal(out.kind, 'open');
  if (out.kind === 'open') assert.ok(Math.abs(minutesLeft(out.info.expiresAt) - 30) <= 1, 'still about 30 minutes, whatever the phone clock says');
  globalThis.fetch = realFetch;
});
