import assert from 'node:assert/strict';
import test from 'node:test';
import {
  attendanceLink, dashboardLink, EXCEPTION_REASONS, portalBaseUrl, queueEmployeeText, queueEventAlerts,
  queueExceptionAlert, queueLinkMessage, shouldAlertDirector, type EventAlertInput,
} from './alerts';
import {
  campusChoiceText, confirmText, formatIstDate, formatIstTime, helpText, lockedText,
} from './messages';
import type { OutboxMessage } from './outboxStore';
import { processOutbox } from './outboxWorker';
import { SETTING_DEFAULTS, type AttendanceSettings } from './settings';
import { buildParams, DIRECTOR_TEMPLATES, placeholderCount, renderTemplate, sanitizeParam, type DirectorTemplateKey } from './templates';
import { FakeDb } from './testSupport';
import { loadWhatsAppConfig, sendMessage, SendError, type WhatsAppConfig } from './whatsappSender';

// ── Templates ─────────────────────────────────────────────────────────────────
test('every Director template has a matching number of examples and valid Meta structure', () => {
  for (const [key, def] of Object.entries(DIRECTOR_TEMPLATES)) {
    assert.equal(placeholderCount(def.body), def.examples.length, `${key}: examples must match placeholders`);
    assert.ok(!def.body.startsWith('{{'), `${key}: must not start with a variable`);
    assert.ok(!/\{\{\d+\}\}\.?\s*$/.test(def.body), `${key}: must not end with a variable`);
    assert.match(def.defaultName, /^[a-z0-9_]+$/);
    const numbers = [...def.body.matchAll(/\{\{(\d+)\}\}/g)].map(m => Number(m[1]));
    assert.deepEqual(numbers, numbers.map((_, i) => i + 1), `${key}: variables must run 1..n in order`);
  }
  assert.equal(Object.keys(DIRECTOR_TEMPLATES).length, 6);
});

test('template parameters are sanitised and counted', () => {
  assert.equal(sanitizeParam('  Asha\nRao   \t '), 'Asha Rao');
  assert.equal(sanitizeParam(''), '-');
  assert.equal(sanitizeParam(null), '-');
  assert.equal(sanitizeParam('x'.repeat(2000)).length, 1000);
  assert.throws(() => buildParams('checkin', ['only one']), /needs 7 parameters/);
  const params = buildParams('checkout', ['A', 'T1', 'Main', '02 Mar 2026', '04:00 PM', 'https://x']);
  assert.equal(renderTemplate('checkout', params),
    'Attendance alert: A (ID T1) checked OUT at Main on 02 Mar 2026 at 04:00 PM. Details: https://x. This is an automated alert.');
});

// ── Employee texts ────────────────────────────────────────────────────────────
test('the locked-link message uses the exact requested wording', () => {
  assert.equal(lockedText(), 'Your attendance marking was not successful due to location mismatch.');
});

test('times and dates are formatted in IST', () => {
  const at = new Date('2026-03-02T03:35:00Z'); // 09:05 IST
  assert.equal(formatIstTime(at), '09:05 AM');
  assert.equal(formatIstDate(at), '02 Mar 2026');
  assert.equal(formatIstTime(new Date('2026-03-02T10:30:00Z')), '04:00 PM');
});

test('confirmation shows status for IN only, and no coordinates or selfie wording', () => {
  const at = new Date('2026-03-02T03:35:00Z');
  const inText = confirmText({ type: 'IN', campusName: 'Main', at, punctuality: 'LATE', lateMinutes: 5 });
  assert.match(inText, /check-in is recorded at 09:05 AM on 02 Mar 2026 at Main\. Status: Late by 5 min\./);
  const outText = confirmText({ type: 'OUT', campusName: 'Main', at, punctuality: 'NOT_APPLICABLE', lateMinutes: null });
  assert.ok(!/Status/.test(outText));
  assert.ok(!/selfie|latitude|longitude/i.test(inText + outText + helpText()));
});

test('campus choice lists numbered campuses and an example command', () => {
  const text = campusChoiceText('IN', [{ campusName: 'Main' }, { campusName: 'North' }]);
  assert.match(text, /1\. Main\n2\. North/);
  assert.match(text, /IN 1/);
});

// ── WhatsApp sender ───────────────────────────────────────────────────────────
const liveConfig: WhatsAppConfig = { mode: 'live', accessToken: 'SECRET-TOKEN', phoneNumberId: '12345', graphVersion: 'v21.0' };
const stubConfig: WhatsAppConfig = { ...liveConfig, mode: 'stub' };

const textMessage: OutboxMessage = {
  id: 'm1', recipientType: 'EMPLOYEE', recipientE164: '919849136605', kind: 'HELP', deliveryMode: 'TEXT',
  templateName: null, templateLanguage: null, payload: { body: 'hello' }, attempts: 1, maxAttempts: 5,
};
const templateMessage: OutboxMessage = {
  ...textMessage, id: 'm2', recipientType: 'DIRECTOR', kind: 'DIRECTOR_CHECKIN', deliveryMode: 'TEMPLATE',
  templateName: 'attendance_checkin', templateLanguage: 'en', payload: { params: ['A', 'B'] },
};

function mockFetch(status: number, body: unknown): { fn: typeof fetch; calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return { fn, calls };
}

test('configuration defaults to stub mode unless explicitly set to live', () => {
  assert.equal(loadWhatsAppConfig({}).mode, 'stub');
  assert.equal(loadWhatsAppConfig({ ATTENDANCE_WA_MODE: 'LIVE' }).mode, 'live');
  assert.equal(loadWhatsAppConfig({ ATTENDANCE_WA_MODE: 'production' }).mode, 'stub');
});

test('stub mode sends nothing and logs only a masked number', async () => {
  const mock = mockFetch(200, {});
  const logs: string[] = [];
  const result = await sendMessage(textMessage, stubConfig, { fetchFn: mock.fn, log: l => logs.push(l) });
  assert.deepEqual(result, { metaMessageId: null, stubbed: true });
  assert.equal(mock.calls.length, 0);
  assert.ok(logs.join().includes('********6605'));
  assert.ok(!logs.join().includes('919849136605'));
  assert.ok(!logs.join().includes('hello'));
});

test('live text message goes to the Graph API with a bearer token', async () => {
  const mock = mockFetch(200, { messages: [{ id: 'wamid.ABC' }] });
  const result = await sendMessage(textMessage, liveConfig, { fetchFn: mock.fn });
  assert.deepEqual(result, { metaMessageId: 'wamid.ABC', stubbed: false });
  assert.equal(mock.calls[0].url, 'https://graph.facebook.com/v21.0/12345/messages');
  assert.equal((mock.calls[0].init.headers as Record<string, string>).Authorization, 'Bearer SECRET-TOKEN');
  const sent = JSON.parse(String(mock.calls[0].init.body));
  assert.equal(sent.type, 'text');
  assert.equal(sent.to, '919849136605');
  assert.equal(sent.text.body, 'hello');
});

test('live template message carries the name, language and body parameters', async () => {
  const mock = mockFetch(200, { messages: [{ id: 'wamid.T' }] });
  await sendMessage(templateMessage, liveConfig, { fetchFn: mock.fn });
  const sent = JSON.parse(String(mock.calls[0].init.body));
  assert.equal(sent.type, 'template');
  assert.equal(sent.template.name, 'attendance_checkin');
  assert.equal(sent.template.language.code, 'en');
  assert.deepEqual(sent.template.components[0].parameters, [{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }]);
});

test('live mode without full configuration fails without retrying', async () => {
  const mock = mockFetch(200, {});
  await assert.rejects(
    sendMessage(textMessage, { ...liveConfig, accessToken: null }, { fetchFn: mock.fn }),
    (e: unknown) => e instanceof SendError && e.code === 'NOT_CONFIGURED' && !e.retryable,
  );
  assert.equal(mock.calls.length, 0);
});

test('errors are classified as retryable or definitive, and never leak the token', async () => {
  const cases: [number, unknown, boolean][] = [
    [400, { error: { code: 100, message: 'Invalid parameter' } }, false],
    [401, { error: { code: 190, message: 'Invalid OAuth token' } }, false],
    [429, { error: { code: 4, message: 'Too many calls' } }, true],
    [500, { error: { code: 2, message: 'Service error' } }, true],
    [400, { error: { code: 131016, message: 'Service unavailable' } }, true],
    [400, { error: { code: 131047, message: 'Re-engagement message' } }, false],
  ];
  for (const [status, body, retryable] of cases) {
    await assert.rejects(
      sendMessage(textMessage, liveConfig, { fetchFn: mockFetch(status, body).fn }),
      (e: unknown) => {
        assert.ok(e instanceof SendError);
        assert.equal(e.retryable, retryable, `${status} ${JSON.stringify(body)}`);
        assert.ok(!e.message.includes('SECRET-TOKEN'));
        return true;
      },
    );
  }
  const network = (async () => { throw new Error('socket hang up SECRET-TOKEN'); }) as typeof fetch;
  await assert.rejects(
    sendMessage(textMessage, liveConfig, { fetchFn: network }),
    (e: unknown) => e instanceof SendError && e.retryable && !e.message.includes('SECRET-TOKEN'),
  );
});

test('bad recipients and payloads are rejected before anything is sent', async () => {
  const mock = mockFetch(200, { messages: [{ id: 'x' }] });
  await assert.rejects(sendMessage({ ...textMessage, recipientE164: '+91 98491' }, liveConfig, { fetchFn: mock.fn }), /not valid/);
  await assert.rejects(sendMessage({ ...textMessage, payload: {} }, liveConfig, { fetchFn: mock.fn }), /no text body/);
  await assert.rejects(sendMessage({ ...templateMessage, payload: { params: [1] } }, liveConfig, { fetchFn: mock.fn }), /parameters/);
  assert.equal(mock.calls.length, 0);
});

test('a response without a message ID is not retried (it may already be sent)', async () => {
  await assert.rejects(
    sendMessage(textMessage, liveConfig, { fetchFn: mockFetch(200, { messages: [] }).fn }),
    (e: unknown) => e instanceof SendError && e.code === 'MISSING_MESSAGE_ID' && !e.retryable,
  );
});

// ── Alert rules ───────────────────────────────────────────────────────────────
const directorNumber = '919000000001';
const settings = (over: Partial<AttendanceSettings> = {}): AttendanceSettings => ({
  ...SETTING_DEFAULTS, directorWhatsapp: directorNumber, ...over,
});

function enqueued(db: FakeDb): { recipient: string; kind: string; key: string; payload: string }[] {
  return db.calls
    .filter(c => /insert into notification_outbox/.test(c.text))
    .map(c => ({ recipient: String(c.params[1]), kind: String(c.params[5]), key: String(c.params[10]), payload: String(c.params[9]) }));
}
const outboxDb = () => new FakeDb().on(/insert into notification_outbox/, { rows: [{ id: 'm' }] });

const base = (over: Partial<EventAlertInput> = {}): EventAlertInput => ({
  settings: settings(), baseUrl: 'https://portal.example', eventId: 'ev1', eventType: 'IN',
  serverTs: new Date('2026-03-02T03:35:00Z'), punctuality: 'ON_TIME', lateMinutes: null,
  employee: { id: 7, code: 'T001', name: 'Asha Rao', whatsapp: '919849136605' }, campusName: 'Main', ...over,
});

test('alert mode table', () => {
  for (const kind of ['NORMAL_IN', 'NORMAL_OUT', 'LATE', 'EXCEPTION', 'MISSING_OUT'] as const) {
    assert.equal(shouldAlertDirector('individual', kind), true);
  }
  for (const mode of ['mute_normal', 'digest'] as const) {
    assert.equal(shouldAlertDirector(mode, 'NORMAL_IN'), false);
    assert.equal(shouldAlertDirector(mode, 'NORMAL_OUT'), false);
    assert.equal(shouldAlertDirector(mode, 'LATE'), true);
    assert.equal(shouldAlertDirector(mode, 'EXCEPTION'), true);
    assert.equal(shouldAlertDirector(mode, 'MISSING_OUT'), true);
  }
});

test('an on-time IN confirms to the employee and alerts the Director', async () => {
  const db = outboxDb();
  await queueEventAlerts(db, base());
  const rows = enqueued(db);
  assert.deepEqual(rows.map(r => [r.kind, r.recipient, r.key]), [
    ['CHECKIN_CONFIRM', '919849136605', 'confirm:ev1'],
    ['DIRECTOR_CHECKIN', directorNumber, 'director:ev1'],
  ]);
});

test('a late IN sends ONE Director message (the late alert), not two', async () => {
  const db = outboxDb();
  await queueEventAlerts(db, base({ punctuality: 'LATE', lateMinutes: 15 }));
  assert.deepEqual(enqueued(db).map(r => r.kind), ['CHECKIN_CONFIRM', 'DIRECTOR_LATE']);
  assert.ok(enqueued(db)[1].payload.includes('15'));
});

test('an OUT alerts the Director with the check-out template', async () => {
  const db = outboxDb();
  await queueEventAlerts(db, base({ eventType: 'OUT', punctuality: 'NOT_APPLICABLE' }));
  assert.deepEqual(enqueued(db).map(r => r.kind), ['CHECKOUT_CONFIRM', 'DIRECTOR_CHECKOUT']);
});

test('mute_normal and digest hide normal IN/OUT from the Director but keep late ones', async () => {
  for (const alertMode of ['mute_normal', 'digest'] as const) {
    const normal = outboxDb();
    await queueEventAlerts(normal, base({ settings: settings({ alertMode }) }));
    assert.deepEqual(enqueued(normal).map(r => r.kind), ['CHECKIN_CONFIRM'], alertMode);

    const out = outboxDb();
    await queueEventAlerts(out, base({ settings: settings({ alertMode }), eventType: 'OUT', punctuality: 'NOT_APPLICABLE' }));
    assert.deepEqual(enqueued(out).map(r => r.kind), ['CHECKOUT_CONFIRM'], alertMode);

    const late = outboxDb();
    await queueEventAlerts(late, base({ settings: settings({ alertMode }), punctuality: 'LATE', lateMinutes: 3 }));
    assert.deepEqual(enqueued(late).map(r => r.kind), ['CHECKIN_CONFIRM', 'DIRECTOR_LATE'], alertMode);
  }
});

test('without a Director number only the employee confirmation is queued', async () => {
  const db = outboxDb();
  const result = await queueEventAlerts(db, base({ settings: settings({ directorWhatsapp: null }) }));
  assert.deepEqual(enqueued(db).map(r => r.kind), ['CHECKIN_CONFIRM']);
  assert.deepEqual(result, { employee: true, director: false });
});

test('queued payloads never contain selfies or coordinates', async () => {
  const db = outboxDb();
  await queueEventAlerts(db, base());
  for (const row of enqueued(db)) assert.ok(!/selfie|latitude|longitude|lat"|lng"/i.test(row.payload));
});

test('exceptions always alert the Director; missing OUT uses its own template', async () => {
  const missing = outboxDb();
  await queueExceptionAlert(missing, {
    settings: settings({ alertMode: 'mute_normal' }), baseUrl: 'https://portal.example', exceptionId: 'x1',
    kind: 'MISSING_OUT', workDate: '2026-03-02', at: new Date('2026-03-02T11:00:00Z'),
    employee: { id: 7, code: 'T001', name: 'Asha Rao' }, campusName: 'Main',
  });
  assert.deepEqual(enqueued(missing).map(r => [r.kind, r.key]), [['DIRECTOR_MISSING_OUT', 'director-exception:x1']]);

  const gps = outboxDb();
  await queueExceptionAlert(gps, {
    settings: settings(), baseUrl: 'https://portal.example', exceptionId: 'x2', kind: 'GPS_OUTSIDE_RADIUS',
    workDate: '2026-03-02', at: new Date(), employee: { id: 7, code: 'T001', name: 'Asha Rao' }, campusName: null,
  });
  assert.equal(enqueued(gps)[0].kind, 'DIRECTOR_EXCEPTION');
  assert.ok(enqueued(gps)[0].payload.includes(EXCEPTION_REASONS.GPS_OUTSIDE_RADIUS));
  assert.ok(enqueued(gps)[0].payload.includes('Unknown campus'));
});

test('link and reply messages are queued as plain text with idempotency keys', async () => {
  const db = outboxDb();
  await queueLinkMessage(db, {
    employee: { id: 7, whatsapp: '919849136605' }, tokenId: 'tok1', type: 'IN', campusName: 'Main',
    url: attendanceLink('https://portal.example', 'TOKEN'), ttlMinutes: 5,
  });
  await queueEmployeeText(db, {
    employee: { id: 7, whatsapp: '919849136605' }, kind: 'TOKEN_LOCKED', body: lockedText(), idempotencyKey: 'locked:tok1',
  });
  const rows = enqueued(db);
  assert.deepEqual(rows.map(r => [r.kind, r.key]), [['LINK', 'link:tok1'], ['TOKEN_LOCKED', 'locked:tok1']]);
  assert.ok(rows[0].payload.includes('https://portal.example/a/TOKEN'));
});

test('portal links use the setting first, then APP_BASE_URL, without a trailing slash', () => {
  assert.equal(portalBaseUrl(settings({ linkBaseUrl: 'https://a.example/' }), { APP_BASE_URL: 'https://b.example' }), 'https://a.example');
  assert.equal(portalBaseUrl(settings(), { APP_BASE_URL: 'https://b.example/' }), 'https://b.example');
  assert.equal(dashboardLink('https://a.example'), 'https://a.example/attendance');
});

// ── Outbox worker ─────────────────────────────────────────────────────────────
const claimRow = (id: string, kind: string) => ({
  id, recipient_type: 'EMPLOYEE', recipient_e164: '919849136605', kind, delivery_mode: 'TEXT',
  template_name: null, template_language: null, payload: { body: 'x' }, attempts: 1, max_attempts: 5,
});

test('the worker marks success, stub, retry and permanent failure correctly', async () => {
  const db = new FakeDb().on(/with due as/, {
    rows: [claimRow('ok', 'HELP'), claimRow('link', 'LINK'), claimRow('stub', 'HELP'), claimRow('retry', 'HELP'), claimRow('fail', 'HELP')],
  });
  const sender = async (m: OutboxMessage) => {
    if (m.id === 'stub') return { metaMessageId: null, stubbed: true };
    if (m.id === 'retry') throw new SendError('rate limited', '4', true);
    if (m.id === 'fail') throw new SendError('bad number', '100', false);
    return { metaMessageId: `wamid.${m.id}`, stubbed: false };
  };
  const summary = await processOutbox(db, liveConfig, { sender });
  assert.deepEqual(summary, { claimed: 5, sent: 2, stubbed: 1, retried: 1, failed: 1 });

  const sentUpdates = db.calls.filter(c => /set status = \$2, meta_message_id/.test(c.text));
  const byId = Object.fromEntries(sentUpdates.map(c => [String(c.params[0]), c.params]));
  assert.equal(byId.ok[1], 'SENT');
  assert.equal(byId.ok[3], false);            // payload kept
  assert.equal(byId.link[3], true);           // secret link cleared after sending
  assert.equal(byId.stub[1], 'STUBBED');

  const failures = db.calls.filter(c => /set status = \$2, last_error/.test(c.text));
  const failById = Object.fromEntries(failures.map(c => [String(c.params[0]), c.params]));
  assert.equal(failById.retry[1], 'QUEUED');
  assert.equal(failById.fail[1], 'FAILED');
});

test('an unexpected sender error is retried, not lost', async () => {
  const db = new FakeDb().on(/with due as/, { rows: [claimRow('x', 'HELP')] });
  const summary = await processOutbox(db, liveConfig, { sender: async () => { throw new Error('kaboom'); } });
  assert.equal(summary.retried, 1);
  const failure = db.calls.find(c => /set status = \$2, last_error/.test(c.text));
  assert.equal(failure?.params[1], 'QUEUED');
  assert.equal(failure?.params[2], 'Unexpected sending error');
});

test('with nothing due the worker does nothing', async () => {
  const db = new FakeDb().on(/with due as/, { rows: [] });
  assert.deepEqual(await processOutbox(db, stubConfig), { claimed: 0, sent: 0, stubbed: 0, retried: 0, failed: 0 });
});

// type-use to keep DirectorTemplateKey exported API exercised
const _keys: DirectorTemplateKey[] = ['checkin', 'checkout', 'late', 'exception', 'missingOut'];
void _keys;
