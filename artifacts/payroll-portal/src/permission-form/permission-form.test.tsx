import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { cancelRequest, loadForm, previewDraft, sendDraft, type Draft, type PermissionInfo } from './api';
import { canPreview, closedCopy, lengthText, limitsLine } from './copy';
import { FormView, ScreenView, type FormProps, type PreviewState } from './PermissionFormPage';

const info = (over: Partial<PermissionInfo> = {}): PermissionInfo => ({
  name: 'Asha Rao', today: '2026-09-01', expiresAt: Date.now() + 25 * 60_000, year: { label: '2026-27' },
  limits: { maxMinutes: null, maxPerMonth: null, usedThisMonth: 0 }, requests: [], ...over,
});
const draft = (over: Partial<Draft> = {}): Draft => ({ date: '', startTime: '', endTime: '', reason: '', ...over });
const noop = () => {};
const props = (over: Partial<FormProps> = {}): FormProps => ({
  info: info(), draft: draft(), preview: { kind: 'idle' }, sending: false, problem: null, confirming: null, cancelling: false,
  onChange: noop, onSend: noop, onAskCancel: noop, onCancel: noop, ...over,
});
const view = (over: Partial<FormProps> = {}) => renderToStaticMarkup(<FormView {...props(over)} />);
const sendButton = (html: string) => html.match(/<button[^>]*>(?:(?!<\/button>).)*Send to the Director<\/button>/)?.[0] ?? '';
const complete = draft({ date: '2026-09-08', startTime: '10:00', endTime: '11:00', reason: 'Doctor appointment' });
const ok = (): PreviewState => ({ kind: 'ok', minutes: 60 });

test('wording: lengths, limits, closed links', () => {
  assert.equal(lengthText(1), '1 minute');
  assert.equal(lengthText(45), '45 minutes');
  assert.equal(lengthText(60), '1 hour');
  assert.equal(lengthText(90), '1 hour 30 minutes');
  assert.equal(lengthText(121), '2 hours 1 minute');
  assert.equal(limitsLine({ maxMinutes: null, maxPerMonth: null, usedThisMonth: 3 }), '');
  assert.equal(limitsLine({ maxMinutes: 120, maxPerMonth: 3, usedThisMonth: 1 }), '1 of 3 permissions used this month; each can be up to 2 hours');
  assert.equal(limitsLine({ maxMinutes: 30, maxPerMonth: null, usedThisMonth: 0 }), 'each can be up to 30 minutes');
  for (const s of ['NOT_FOUND', 'EXPIRED', 'USED', 'UNAVAILABLE'] as const) assert.ok(closedCopy(s).title);
  assert.match(closedCopy('EXPIRED').body, /send PERMISSION on WhatsApp/i);
  assert.match(closedCopy('USED').body, /send PERMISSION on WhatsApp/i);
  assert.ok(!canPreview(draft()) && !canPreview(draft({ date: '2026-09-08', startTime: '10:00' })) && canPreview(complete));
});

test('the form greets the employee and shows only the limits that are set', () => {
  const html = view();
  assert.match(html, /Hello, Asha/);
  assert.match(html, /short absence during a working day/);
  assert.match(html, /min="2026-09-01"/);
  assert.match(html, /type="time"/);
  assert.ok(!/permissions used this month/.test(html), 'no limits line when no limits are set');
  const limited = view({ info: info({ limits: { maxMinutes: 120, maxPerMonth: 2, usedThisMonth: 1 } }) });
  assert.match(limited, /1 of 2 permissions used this month; each can be up to 2 hours\./);
});

test('Send stays off until the form is complete and checked', () => {
  const off = / disabled=""/;
  assert.match(sendButton(view()), off);
  assert.match(sendButton(view({ draft: complete })), off, 'not yet checked');
  assert.match(sendButton(view({ draft: complete, preview: { kind: 'checking' } })), off);
  assert.match(sendButton(view({ draft: { ...complete, reason: ' ' }, preview: ok() })), off, 'a reason is needed');
  assert.match(sendButton(view({ draft: complete, preview: { kind: 'refused', message: 'x' } })), off);
  const sending = view({ draft: complete, preview: ok(), sending: true }).match(/<button[^>]*>(?:(?!<\/button>).)*Sending…<\/button>/)?.[0] ?? '';
  assert.match(sending, off, 'no double sending');
  assert.ok(!off.test(sendButton(view({ draft: complete, preview: ok() }))), 'ready to send');
});

test('the check result: length and a reassurance that no leave is used, or the plain reason it was refused', () => {
  const good = view({ draft: complete, preview: ok() });
  assert.match(good, /1 hour/);
  assert.match(good, /No leave is used for a permission/);
  assert.match(view({ draft: complete, preview: { kind: 'refused', message: 'Permission must be within your working hours.' } }), /Permission must be within your working hours\./);
  assert.match(view({ draft: complete, preview: { kind: 'checking' } }), /Checking/);
  assert.match(view({ draft: complete, preview: { kind: 'error' } }), /Could not reach the server/);
});

test('your requests: status words, cancel only for pending, with a confirm step', () => {
  const requests: PermissionInfo['requests'] = [
    { id: 'a', status: 'PENDING', date: '08 Sep 2026', from: '10:00 AM', to: '11:00 AM', note: null, canCancel: true },
    { id: 'b', status: 'REJECTED', date: '09 Sep 2026', from: '9:00 AM', to: '9:30 AM', note: 'Staff meeting then', canCancel: false },
    { id: 'c', status: 'APPROVED', date: '10 Sep 2026', from: '2:00 PM', to: '3:00 PM', note: null, canCancel: false },
  ];
  const html = view({ info: info({ requests }) });
  assert.match(html, /Waiting for the Director/);
  assert.match(html, /Not approved · Staff meeting then/);
  assert.match(html, /08 Sep 2026<\/strong> · 10:00 AM to 11:00 AM/);
  assert.equal((html.match(/>Cancel<\/button>/g) ?? []).length, 1);
  const confirming = view({ info: info({ requests }), confirming: 'a' });
  assert.match(confirming, /Yes, cancel/);
  assert.ok(!/>Cancel<\/button>/.test(confirming));
  assert.ok(!/Your requests/.test(view()));
});

const screen = (s: Parameters<typeof ScreenView>[0]['screen']) => renderToStaticMarkup(<ScreenView screen={s} formProps={null} onRetry={noop} />);

test('the other screens', () => {
  assert.match(screen({ name: 'loading' }), /Checking your link/);
  assert.match(screen({ name: 'closed', message: closedCopy('USED') }), /already used/);
  assert.match(screen({ name: 'error', message: { title: 'Could not reach the server', body: 'Check.' } }), /Try again/);
  const sent = screen({ name: 'sent', date: '08 Sep 2026', from: '10:00 AM', to: '11:00 AM' });
  assert.match(sent, /Request sent/);
  assert.match(sent, /10:00 AM to 11:00 AM/);
  assert.match(sent, /You will get a WhatsApp message/);
});

// ── Talking to the server ─────────────────────────────────────────────────────
const TOKEN = 'c'.repeat(43);
const realFetch = globalThis.fetch;
function stubFetch(status: number, body: unknown, seen: { url?: string; init?: RequestInit } = {}) {
  globalThis.fetch = (async (url: string, init?: RequestInit) => { seen.url = url; seen.init = init; return new Response(JSON.stringify(body), { status }); }) as typeof fetch;
  return seen;
}

test('requests go to the permission endpoints with no cookies and no referrer', async () => {
  const seen = stubFetch(200, { ok: true, minutes: 60 });
  assert.deepEqual(await previewDraft(TOKEN, complete), { kind: 'ok', minutes: 60 });
  assert.equal(seen.url, `/api/permission-form/${TOKEN}/preview`);
  assert.equal(seen.init?.credentials, 'omit');
  assert.equal(seen.init?.referrerPolicy, 'no-referrer');
  assert.deepEqual(JSON.parse(String(seen.init?.body)), { date: '2026-09-08', startTime: '10:00', endTime: '11:00', reason: 'Doctor appointment' });
  globalThis.fetch = realFetch;
});

test('outcomes: refused, closed, sent, network trouble', async () => {
  stubFetch(200, { ok: false, state: 'REFUSED', code: 'MONTH_LIMIT', message: 'You have already used 2 permissions this month.' });
  assert.deepEqual(await previewDraft(TOKEN, complete), { kind: 'refused', message: 'You have already used 2 permissions this month.' });
  assert.deepEqual(await sendDraft(TOKEN, complete), { kind: 'refused', message: 'You have already used 2 permissions this month.' });
  stubFetch(410, { ok: false, state: 'EXPIRED' });
  assert.deepEqual(await loadForm(TOKEN), { kind: 'closed', state: 'EXPIRED' });
  assert.deepEqual(await cancelRequest(TOKEN, 'x'), { kind: 'closed', state: 'EXPIRED' });
  stubFetch(200, { ok: true, request: { id: 'r', date: '08 Sep 2026', from: '10:00 AM', to: '11:00 AM' } });
  assert.deepEqual(await sendDraft(TOKEN, complete), { kind: 'sent', date: '08 Sep 2026', from: '10:00 AM', to: '11:00 AM' });
  globalThis.fetch = (async () => { throw new Error('offline'); }) as typeof fetch;
  assert.deepEqual(await sendDraft(TOKEN, complete), { kind: 'error' });
  globalThis.fetch = realFetch;
});

test('loading turns the server clock into a countdown on this device', async () => {
  const serverNow = Date.now() - 3_600_000;
  stubFetch(200, {
    ok: true, name: 'Asha Rao', today: '2026-09-01', serverTime: new Date(serverNow).toISOString(), expiresAt: new Date(serverNow + 30 * 60_000).toISOString(),
    year: { label: '2026-27' }, limits: { maxMinutes: 120, maxPerMonth: 3, usedThisMonth: 1 }, requests: [],
  });
  const out = await loadForm(TOKEN);
  assert.equal(out.kind, 'open');
  if (out.kind === 'open') {
    assert.deepEqual(out.info.limits, { maxMinutes: 120, maxPerMonth: 3, usedThisMonth: 1 });
    assert.ok(Math.abs(Math.ceil((out.info.expiresAt - Date.now()) / 60_000) - 30) <= 1);
  }
  globalThis.fetch = realFetch;
});
