import assert from 'node:assert/strict';
import test from 'node:test';
import { extractInbound } from '../attendance/inbound';
import type { OutboxMessage } from '../attendance/outboxStore';
import { placeholderCount } from '../attendance/templates';
import { sendMessage, SendError, type WhatsAppConfig } from '../attendance/whatsappSender';
import { approvePayload, buildLeaveParams, LEAVE_TEMPLATES, parseLeavePayload, rejectPayload } from './leaveTemplates';
import { dayRangeText, splitText } from './leaveNotifications';

const ID = '8a3f1c52-7d1e-4b0a-9a55-0c2f6b8d1e77';

test('button payloads round-trip and anything else is refused', () => {
  assert.deepEqual(parseLeavePayload(approvePayload(ID)), { action: 'APPROVE', requestId: ID });
  assert.deepEqual(parseLeavePayload(rejectPayload(ID)), { action: 'REJECT', requestId: ID });
  for (const bad of [null, '', 'LV:A:', 'LV:X:' + ID, 'LV:A:not-a-uuid', 'lv:a:' + ID, `LV:A:${ID} extra`, `PR:A:${ID}`, `LV:A:${ID.toUpperCase()}`]) {
    assert.equal(parseLeavePayload(bad), null, String(bad));
  }
});

test('Meta button taps are read from both message shapes, and plain messages carry no payload', () => {
  const r = extractInbound({ object: 'whatsapp_business_account', entry: [{ changes: [{ value: { metadata: { display_phone_number: '15550000000' }, messages: [
    { id: 'a', from: '919888800000', type: 'button', button: { payload: approvePayload(ID), text: 'Approve' } },
    { id: 'b', from: '919888800000', type: 'interactive', interactive: { button_reply: { id: rejectPayload(ID), title: 'Reject' } } },
    { id: 'c', from: '919888800000', type: 'text', text: { body: 'hello' } },
    { id: 'd', from: '919888800000', type: 'button', button: { text: 'no payload' } },
    { id: 'e', from: '919888800000', type: 'button', button: { payload: 'x'.repeat(1000) } },
  ] } }] }] });
  assert.equal(r.messages[0].buttonPayload, approvePayload(ID));
  assert.equal(r.messages[1].buttonPayload, rejectPayload(ID));
  assert.equal(r.messages[2].buttonPayload, undefined);
  assert.equal(r.messages[3].buttonPayload, undefined);
  assert.equal(r.messages[4].buttonPayload?.length, 256, 'an oversized payload is cut, never passed on whole');
});

test('the leave templates follow Meta\'s rules and their parameters line up', () => {
  for (const [key, t] of Object.entries(LEAVE_TEMPLATES)) {
    assert.ok(!/^\{\{/.test(t.body) && !/\}\}\.?$/.test(t.body), `${key} must not start or end with a variable`);
    assert.equal(t.examples.length, placeholderCount(t.body), `${key} needs one example per variable`);
    assert.match(t.body, /This is an automated (alert|message)\.$/);
  }
  assert.deepEqual(LEAVE_TEMPLATES.leaveRequest.buttons, ['Approve', 'Reject']);
  assert.throws(() => buildLeaveParams('leaveRequest', ['too', 'few']));
  assert.deepEqual(buildLeaveParams('leaveDecision', ['Casual Leave', '07 Sep 2026', 'approved', '']), ['Casual Leave', '07 Sep 2026', 'approved', '-']);
  assert.equal(buildLeaveParams('leaveDecision', ['a\nb\tc', 'd', 'e', 'f'])[0], 'a b c', 'newlines and tabs would make Meta refuse the message');
});

const live: WhatsAppConfig = { mode: 'live', accessToken: 'token', phoneNumberId: '123', graphVersion: 'v21.0' };
const message = (payload: Record<string, unknown>): OutboxMessage => ({
  id: 'o1', recipientType: 'DIRECTOR', recipientE164: '919888800000', kind: 'DIRECTOR_LEAVE_REQUEST', deliveryMode: 'TEMPLATE',
  templateName: 'leave_request', templateLanguage: 'en', payload, attempts: 0, maxAttempts: 5,
});
const capture = () => {
  const seen: { body?: any } = {};
  const fetchFn = (async (_url: string, init: { body: string }) => {
    seen.body = JSON.parse(init.body);
    return new Response(JSON.stringify({ messages: [{ id: 'wamid.1' }] }), { status: 200 });
  }) as unknown as typeof fetch;
  return { seen, fetchFn };
};

test('a template with buttons is sent with a body and one quick-reply button per payload', async () => {
  const { seen, fetchFn } = capture();
  await sendMessage(message({ params: ['A', 'B'], buttons: [approvePayload(ID), rejectPayload(ID)] }), live, { fetchFn });
  const c = seen.body.template.components;
  assert.deepEqual(c[0], { type: 'body', parameters: [{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }] });
  assert.deepEqual(c[1], { type: 'button', sub_type: 'quick_reply', index: '0', parameters: [{ type: 'payload', payload: approvePayload(ID) }] });
  assert.equal(c[2].index, '1');
  assert.equal(c.length, 3);
});

test('templates without buttons are sent exactly as before', async () => {
  const { seen, fetchFn } = capture();
  await sendMessage(message({ params: ['A'] }), live, { fetchFn });
  assert.deepEqual(seen.body.template.components, [{ type: 'body', parameters: [{ type: 'text', text: 'A' }] }]);
});

test('malformed button lists are refused before anything is sent', async () => {
  for (const buttons of ['approve', [1], [''], ['x'.repeat(257)], ['a', 'b', 'c', 'd']]) {
    let called = false;
    const fetchFn = (async () => { called = true; return new Response('{}'); }) as unknown as typeof fetch;
    await assert.rejects(sendMessage(message({ params: ['A'], buttons }), live, { fetchFn }), (e: unknown) => e instanceof SendError && e.code === 'INVALID_PAYLOAD');
    assert.equal(called, false);
  }
});

test('the dates and cost shown to the Director read clearly', () => {
  assert.equal(dayRangeText({ startDate: '2026-09-07', endDate: '2026-09-08', dayMode: 'FULL' }), '07 Sep 2026 to 08 Sep 2026');
  assert.equal(dayRangeText({ startDate: '2026-09-07', endDate: '2026-09-07', dayMode: 'FULL' }), '07 Sep 2026');
  assert.equal(dayRangeText({ startDate: '2026-09-07', endDate: '2026-09-07', dayMode: 'FIRST_HALF' }), '07 Sep 2026 (first half)');
  assert.equal(dayRangeText({ startDate: '2026-09-07', endDate: '2026-09-07', dayMode: 'SECOND_HALF' }), '07 Sep 2026 (second half)');
  assert.equal(splitText({ totalDays: 2, paidDays: 1.5, lopDays: 0.5 }), '2 days: 1.5 paid, 0.5 without pay');
  assert.equal(splitText({ totalDays: 1, paidDays: 1, lopDays: 0 }), '1 day: 1 paid, 0 without pay');
});
