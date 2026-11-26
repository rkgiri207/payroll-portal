import assert from 'node:assert/strict';
import test from 'node:test';
import { handleInboundMessage, type ServiceDeps } from './attendanceService';
import { asPoolLike } from './db';
import { extractInbound, type InboundMessage } from './inbound';
import { decodeSelfie } from './selfieStorage';
import { FakeDb } from './testSupport';
import type { WhatsAppConfig } from './whatsappSender';

// ── Parsing Meta's payload ────────────────────────────────────────────────────
const metaPayload = (value: Record<string, unknown>) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: '1', changes: [{ field: 'messages', value: { metadata: { display_phone_number: '919849136605' }, ...value } }] }],
});

test('extractInbound reads text messages and delivery statuses', () => {
  const result = extractInbound(metaPayload({
    messages: [{ id: 'wamid.1', from: '919000000002', type: 'text', text: { body: ' IN ' } }],
    statuses: [
      { id: 'wamid.out1', status: 'delivered' },
      { id: 'wamid.out2', status: 'failed', errors: [{ code: 131047, title: 'Re-engagement message' }] },
      { id: 'wamid.out3', status: 'deleted' },
    ],
  }));
  assert.deepEqual(result.messages, [{ id: 'wamid.1', from: '919000000002', type: 'text', text: ' IN ', isGroup: false }]);
  assert.deepEqual(result.statuses, [
    { id: 'wamid.out1', status: 'DELIVERED', error: null },
    { id: 'wamid.out2', status: 'FAILED', error: '131047: Re-engagement message' },
  ]);
});

test('extractInbound skips our own number, groups and malformed entries', () => {
  const result = extractInbound(metaPayload({
    messages: [
      { id: 'own', from: '+91 98491 36605', type: 'text', text: { body: 'IN' } },
      { id: 'grp', from: '919000000002', type: 'text', text: { body: 'IN' }, group_id: 'g1' },
      { from: '919000000002', type: 'text' },
      { id: 'image', from: '919000000003', type: 'image' },
      'garbage',
    ],
  }));
  assert.deepEqual(result.messages.map(m => [m.id, m.isGroup, m.type]), [['grp', true, 'text'], ['image', false, 'image']]);
});

test('extractInbound never throws on junk', () => {
  for (const junk of [null, undefined, 42, 'x', [], {}, { object: 'page' }, { object: 'whatsapp_business_account', entry: 'x' },
    { object: 'whatsapp_business_account', entry: [null, { changes: 'x' }, { changes: [{ value: null }] }] }]) {
    assert.deepEqual(extractInbound(junk), { messages: [], statuses: [] });
  }
});

// ── Selfie image checks ───────────────────────────────────────────────────────
const jpeg = (size: number) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(size, 7)]);

test('decodeSelfie accepts a real-looking JPEG or WebP and rejects everything else', () => {
  const ok = decodeSelfie(jpeg(3000).toString('base64'));
  assert.equal(ok?.kind.contentType, 'image/jpeg');
  assert.equal(decodeSelfie(`data:image/jpeg;base64,${jpeg(3000).toString('base64')}`)?.kind.extension, 'jpg');

  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP'), Buffer.alloc(3000, 1)]);
  assert.equal(decodeSelfie(webp.toString('base64'))?.kind.contentType, 'image/webp');

  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(3000, 1)]);
  assert.equal(decodeSelfie(png.toString('base64')), null);                       // wrong type
  assert.equal(decodeSelfie(jpeg(100).toString('base64')), null);                  // too small
  assert.equal(decodeSelfie(jpeg(1_000_000).toString('base64')), null);            // too large
  assert.equal(decodeSelfie('not base64 !!!' + 'A'.repeat(200)), null);            // not base64
  assert.equal(decodeSelfie(undefined), null);
  assert.equal(decodeSelfie(12345), null);
});

// ── Inbound message handling ──────────────────────────────────────────────────
const wa: WhatsAppConfig = { mode: 'stub', accessToken: null, phoneNumberId: null, graphVersion: null };
const NOW = new Date('2026-03-02T03:35:00Z'); // 09:05 IST, Monday
const employeeRow = { id: 7, employee_code: 'T001', employee_name: 'Asha Rao' };

interface Setup {
  registered?: boolean;
  fresh?: boolean;
  settingsRows?: unknown[];
  validEvent?: (type: string) => unknown | null;
  campuses?: unknown[];
  campusById?: unknown | null;
}

function build(setup: Setup = {}) {
  const db = new FakeDb()
    .on(/from attendance_employees ae/, { rows: setup.registered === false ? [] : [employeeRow] })
    .on(/insert into whatsapp_webhook_events/, setup.fresh === false ? { rows: [] } : { rows: [{ event_key: 'k' }] })
    .on(/from attendance_settings/, { rows: setup.settingsRows ?? [] })
    .on(/from attendance_events\s+where employee_id/, params => {
      const event = setup.validEvent?.(String(params[2])) ?? null;
      return { rows: event ? [event] : [] };
    })
    .on(/from employee_campus_assignments a/, { rows: setup.campuses ?? [{ campus_id: 2, code: 'M', name: 'Main', kind: 'PRIMARY', mode: 'REPLACE' }] })
    .on(/from campuses where id/, { rows: setup.campusById === undefined ? [] : [setup.campusById] })
    .on(/insert into attendance_tokens/, { rows: [{ id: 'tok1', expires_at: new Date('2026-03-02T03:40:00Z') }] })
    .on(/insert into notification_outbox/, { rows: [{ id: 'msg' }] })
    .on(/with due as/, { rows: [] });
  const deps: ServiceDeps = { pool: asPoolLike(db.asPool()), wa, env: { APP_BASE_URL: 'https://portal.test' }, now: () => NOW };
  return { db, deps };
}

const text = (body: string | null, over: Partial<InboundMessage> = {}): InboundMessage =>
  ({ id: 'wamid.in1', from: '919000000002', type: 'text', text: body, isGroup: false, ...over });

const outbox = (db: FakeDb) =>
  db.where(/insert into notification_outbox/).map(c => ({ kind: String(c.params[5]), key: String(c.params[10]), payload: JSON.parse(String(c.params[9])) as { body?: string } }));

test('an unregistered number gets no reply and starts nothing', async () => {
  const { db, deps } = build({ registered: false });
  assert.equal(await handleInboundMessage(deps, text('IN')), 'IGNORED_UNREGISTERED');
  assert.equal(outbox(db).length, 0);
  assert.equal(db.where(/insert into attendance_tokens/).length, 0);
  // The stranger's command is not even recorded.
  assert.equal(db.where(/insert into whatsapp_webhook_events/)[0].params[3], null);
});

test('ordinary chat from a registered employee is ignored', async () => {
  for (const body of ['hello', 'I am in today', 'good morning', '👍']) {
    const { db, deps } = build();
    assert.equal(await handleInboundMessage(deps, text(body)), 'IGNORED_NOT_COMMAND', body);
    assert.equal(outbox(db).length, 0);
    assert.equal(db.where(/insert into attendance_tokens/).length, 0);
  }
});

test('group messages and non-text messages never start attendance', async () => {
  const group = build();
  assert.equal(await handleInboundMessage(group.deps, text('IN', { isGroup: true })), 'IGNORED_GROUP');
  assert.equal(group.db.where(/from attendance_employees/).length, 0);
  assert.equal(outbox(group.db).length, 0);

  const image = build();
  assert.equal(await handleInboundMessage(image.deps, text(null, { type: 'image' })), 'IGNORED_NOT_TEXT');
  assert.equal(outbox(image.db).length, 0);
});

test('a duplicate delivery of the same message is processed once', async () => {
  const { db, deps } = build({ fresh: false });
  assert.equal(await handleInboundMessage(deps, text('IN')), 'DUPLICATE');
  assert.equal(outbox(db).length, 0);
  assert.equal(db.where(/insert into attendance_tokens/).length, 0);
});

test('HELP lists the commands; LEAVE, PERMISSION and BALANCE say coming soon', async () => {
  const help = build();
  await handleInboundMessage(help.deps, text('help'));
  assert.equal(outbox(help.db)[0].kind, 'HELP');
  assert.match(outbox(help.db)[0].payload.body ?? '', /IN - mark your check-in/);

  for (const command of ['leave', 'PERMISSION', 'Balance']) {
    const soon = build();
    await handleInboundMessage(soon.deps, text(command));
    assert.equal(outbox(soon.db)[0].kind, 'COMING_SOON', command);
    assert.equal(soon.db.where(/insert into attendance_tokens/).length, 0);
  }
});

test('IN with one campus creates a one-time link and queues it', async () => {
  const { db, deps } = build();
  assert.equal(await handleInboundMessage(deps, text('IN')), 'REPLIED');
  const token = db.where(/insert into attendance_tokens/)[0];
  assert.deepEqual(token.params.slice(1, 5), [7, 2, 'IN', '2026-03-02']);
  assert.equal(token.params[5], 5);                       // five-minute link
  assert.equal(token.params[6], 'wamid.in1');             // tied to the WhatsApp message
  const link = outbox(db).find(m => m.kind === 'LINK');
  assert.ok(link);
  assert.match(link.payload.body ?? '', /https:\/\/portal\.test\/a\/[A-Za-z0-9_-]{43}/);
  assert.equal(link.key, 'link:tok1');
  // Only the hash is stored, never the raw token.
  const raw = /\/a\/([A-Za-z0-9_-]{43})/.exec(link.payload.body ?? '')?.[1];
  assert.ok(raw && !token.params.includes(raw));
});

test('IN when already checked in today replies with the recorded time and makes no link', async () => {
  const { db, deps } = build({
    validEvent: type => (type === 'IN'
      ? { id: 'e1', employee_id: 7, campus_id: 2, event_type: 'IN', work_date: '2026-03-02', server_ts: new Date('2026-03-02T03:30:00Z'), punctuality: 'ON_TIME', late_minutes: null }
      : null),
  });
  await handleInboundMessage(deps, text('IN'));
  assert.equal(db.where(/insert into attendance_tokens/).length, 0);
  assert.match(outbox(db)[0].payload.body ?? '', /already marked your check-in today at 09:00 AM/);
});

test('IN with no campus assignment tells the employee to contact the school', async () => {
  const { db, deps } = build({ campuses: [] });
  await handleInboundMessage(deps, text('IN'));
  assert.equal(db.where(/insert into attendance_tokens/).length, 0);
  assert.match(outbox(db)[0].payload.body ?? '', /not assigned to a campus/);
});

test('IN with two campuses asks which one, and "IN 2" picks the second', async () => {
  const two = [
    { campus_id: 2, code: 'M', name: 'Main', kind: 'PRIMARY', mode: 'REPLACE' },
    { campus_id: 5, code: 'N', name: 'North', kind: 'TEMPORARY', mode: 'ADDITIONAL' },
  ];
  const ask = build({ campuses: two });
  await handleInboundMessage(ask.deps, text('IN'));
  assert.equal(outbox(ask.db)[0].kind, 'CAMPUS_CHOICE');
  assert.equal(ask.db.where(/insert into attendance_tokens/).length, 0);

  const choose = build({ campuses: two });
  await handleInboundMessage(choose.deps, text('IN 2'));
  assert.equal(choose.db.where(/insert into attendance_tokens/)[0].params[2], 5);

  const bad = build({ campuses: two });
  await handleInboundMessage(bad.deps, text('IN 9'));
  assert.equal(outbox(bad.db)[0].kind, 'CAMPUS_CHOICE');
  assert.equal(bad.db.where(/insert into attendance_tokens/).length, 0);
});

test('OUT needs an IN first, and then uses the campus where the IN was recorded', async () => {
  const without = build();
  await handleInboundMessage(without.deps, text('OUT'));
  assert.equal(without.db.where(/insert into attendance_tokens/).length, 0);
  assert.match(outbox(without.db)[0].payload.body ?? '', /No check-in is recorded/);

  const withIn = build({
    validEvent: type => (type === 'IN'
      ? { id: 'e1', employee_id: 7, campus_id: 3, event_type: 'IN', work_date: '2026-03-02', server_ts: new Date('2026-03-02T03:30:00Z'), punctuality: 'ON_TIME', late_minutes: null }
      : null),
    campusById: { id: 3, code: 'S', name: 'South', latitude: 17, longitude: 78, geofence_radius_m: 25, required_accuracy_m: null, is_active: true },
  });
  await handleInboundMessage(withIn.deps, text('OUT'));
  const token = withIn.db.where(/insert into attendance_tokens/)[0];
  assert.deepEqual(token.params.slice(1, 5), [7, 3, 'OUT', '2026-03-02']);
});

test('a failure while handling is recorded and does not crash the webhook', async () => {
  const { db, deps } = build();
  db.calls.length = 0;
  const broken = new FakeDb()
    .on(/from attendance_employees ae/, { rows: [employeeRow] })
    .on(/insert into whatsapp_webhook_events/, { rows: [{ event_key: 'k' }] })
    .on(/from attendance_settings/, () => { throw new Error('database down'); });
  const result = await handleInboundMessage({ ...deps, pool: asPoolLike(broken.asPool()) }, text('IN'));
  assert.equal(result, 'ERROR');
  assert.ok(broken.where(/update whatsapp_webhook_events/).some(c => c.params[1] === 'ERROR'));
});
