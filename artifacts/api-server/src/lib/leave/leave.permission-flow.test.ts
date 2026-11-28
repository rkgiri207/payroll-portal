import assert from 'node:assert/strict';
import test from 'node:test';
import { FakeDb } from '../attendance/testSupport';
import { placeholderCount } from '../attendance/templates';
import { SETTING_DEFAULTS } from '../attendance/settings';
import {
  cancelPermissionForm, getPermissionFormInfo, permissionFormText, previewPermissionForm, submitPermissionForm, type PermissionNotifier,
} from './employeePermission';
import {
  approvePermissionPayload, buildLeaveParams, LEAVE_TEMPLATES, parseDecisionPayload, parseLeavePayload, rejectPermissionPayload,
} from './leaveTemplates';
import { notifyDirectorOfPermission, notifyEmployeeOfPermissionDecision, permissionWhen } from './permissionNotifications';
import { approvePermission, cancelPermission, rejectPermission } from './permissionService';
import type { PermissionListItem } from './permissionStore';

const ID = '8a3f1c52-7d1e-4b0a-9a55-0c2f6b8d1e77';
const NOW = new Date('2026-09-01T05:00:00Z');
const TOKEN = 'd'.repeat(43);

const item = (over: Partial<PermissionListItem> = {}): PermissionListItem => ({
  id: ID, status: 'PENDING', employeeId: 7, campusId: 1, date: '2026-09-08', startTime: '10:00', endTime: '11:30', reason: 'Doctor appointment',
  submittedVia: 'WHATSAPP_LINK', decidedVia: null, decisionNote: null, cancelledBy: null, cancelReason: null,
  employeeCode: 'T001', employeeName: 'Asha Rao', campusName: 'Main Campus', submittedAt: '2026-09-01 09:00:00+00', decidedAt: null, ...over,
});
const settings = { ...SETTING_DEFAULTS, directorWhatsapp: '919888800000' };

test('Approve and Reject buttons carry the kind: leave (LV) or permission (PR)', () => {
  assert.deepEqual(parseDecisionPayload(approvePermissionPayload(ID)), { kind: 'PERMISSION', action: 'APPROVE', requestId: ID });
  assert.deepEqual(parseDecisionPayload(rejectPermissionPayload(ID)), { kind: 'PERMISSION', action: 'REJECT', requestId: ID });
  assert.deepEqual(parseDecisionPayload(`LV:A:${ID}`), { kind: 'LEAVE', action: 'APPROVE', requestId: ID });
  for (const bad of [null, '', `XX:A:${ID}`, `PR:Z:${ID}`, 'PR:A:nope', `pr:a:${ID}`, `PR:A:${ID} `]) assert.equal(parseDecisionPayload(bad), null, String(bad));
  assert.equal(parseLeavePayload(approvePermissionPayload(ID)), null, 'the leave-only parser ignores permission buttons');
});

test('the permission templates follow Meta\'s rules', () => {
  for (const key of ['permissionRequest', 'permissionDecision'] as const) {
    const t = LEAVE_TEMPLATES[key];
    assert.ok(!/^\{\{/.test(t.body) && !/\}\}\.?$/.test(t.body), `${key}: no variable at the start or end`);
    assert.equal(t.examples.length, placeholderCount(t.body), `${key}: one example per variable`);
    assert.match(t.body, /This is an automated (alert|message)\.$/);
  }
  assert.equal(placeholderCount(LEAVE_TEMPLATES.permissionRequest.body), 8);
  assert.equal(placeholderCount(LEAVE_TEMPLATES.permissionDecision.body), 5);
  assert.deepEqual(LEAVE_TEMPLATES.permissionRequest.buttons, ['Approve', 'Reject']);
  assert.throws(() => buildLeaveParams('permissionRequest', ['too few']));
});

test('the Director is asked with the right values and buttons, once', async () => {
  const db = new FakeDb().on(/insert into notification_outbox/, { rows: [{ id: 'm1' }] });
  await notifyDirectorOfPermission(db, settings, item());
  const call = db.where(/insert into notification_outbox/)[0];
  const payload = JSON.parse(String(call.params[9])) as { params: string[]; buttons: string[] };
  assert.deepEqual(payload.params, ['Asha Rao', 'T001', 'Main Campus', '08 Sep 2026', '10:00 AM', '11:30 AM', '90 minutes', 'Doctor appointment']);
  assert.deepEqual(payload.buttons, [`PR:A:${ID}`, `PR:R:${ID}`]);
  assert.equal(call.params[0], 'DIRECTOR');
  assert.equal(call.params[1], '919888800000');
  assert.equal(call.params[5], 'DIRECTOR_PERMISSION_REQUEST');
  assert.equal(call.params[7], 'permission_request', 'the template name comes from the settings');
  assert.equal(call.params[10], `permission-request:${ID}`, 'the same request can be queued only once');
  assert.equal(await notifyDirectorOfPermission(new FakeDb(), { ...settings, directorWhatsapp: null }, item()), null, 'nothing is queued without a Director number');
  assert.equal((await notifyDirectorOfPermission(new FakeDb().on(/insert into notification_outbox/, { rows: [{ id: 'm1' }] }),
    { ...settings, leaveTemplates: { ...settings.leaveTemplates, permissionRequest: 'my_permission_v2' } }, item())), 'm1');
});

test('the employee is told the outcome, with the reason when it was refused', async () => {
  const send = async (over: Partial<PermissionListItem>) => {
    const db = new FakeDb().on(/from attendance_employees/, { rows: [{ whatsapp_e164: '919000000001' }] }).on(/insert into notification_outbox/, { rows: [{ id: 'm' }] });
    await notifyEmployeeOfPermissionDecision(db, settings, item(over));
    const c = db.where(/insert into notification_outbox/)[0];
    return { params: (JSON.parse(String(c.params[9])) as { params: string[] }).params, key: String(c.params[10]), kind: c.params[5], to: c.params[1] };
  };
  const approved = await send({ status: 'APPROVED' });
  assert.deepEqual(approved.params, ['08 Sep 2026', '10:00 AM', '11:30 AM', 'approved', 'No further action is needed.']);
  assert.deepEqual([approved.kind, approved.to, approved.key], ['PERMISSION_DECISION', '919000000001', `permission-decision:${ID}:APPROVED`]);
  assert.deepEqual((await send({ status: 'REJECTED', decisionNote: 'Staff meeting then' })).params.slice(3), ['not approved', 'Reason: Staff meeting then.']);
  assert.deepEqual((await send({ status: 'REJECTED' })).params.slice(3), ['not approved', 'Please contact the school administration.']);
  assert.deepEqual((await send({ status: 'CANCELLED', cancelReason: 'Meeting moved' })).params.slice(3), ['cancelled', 'Reason: Meeting moved.']);
  assert.deepEqual((await send({ status: 'CANCELLED' })).params.slice(3), ['cancelled', 'No further action is needed.']);

  assert.equal(await notifyEmployeeOfPermissionDecision(new FakeDb().on(/from attendance_employees/, { rows: [{ whatsapp_e164: '919000000001' }] }), settings, item()), null, 'nothing to say while it is pending');
  assert.equal(await notifyEmployeeOfPermissionDecision(new FakeDb().on(/from attendance_employees/, { rows: [] }), settings, item({ status: 'APPROVED' })), null, 'and nothing if the employee has no WhatsApp number');
  assert.equal(permissionWhen(item()), '10:00 AM to 11:30 AM on 08 Sep 2026');
});

test('closed links answer without writing anything or reading permission data', async () => {
  const row = (over: Record<string, unknown> = {}) => ({ id: 'tok-1', employee_id: 7, purpose: 'PERMISSION', expires_at: new Date('2026-09-01T05:30:00Z'), used_at: null, ...over });
  const silent: PermissionNotifier = { permissionSubmitted: async () => {}, replyToEmployee: async () => {} };
  for (const [over, http, state] of [
    [{ used_at: new Date() }, 410, 'USED'], [{ expires_at: new Date('2026-09-01T04:00:00Z') }, 410, 'EXPIRED'], [{ purpose: 'LEAVE' }, 404, 'NOT_FOUND'], [null, 404, 'NOT_FOUND'],
  ] as [Record<string, unknown> | null, number, string][]) {
    const db = new FakeDb().on(/from form_tokens/, { rows: over ? [row(over)] : [] });
    const deps = { pool: db.asPool(), now: () => NOW };
    for (const reply of [await getPermissionFormInfo(deps, TOKEN), await previewPermissionForm(deps, TOKEN, {}), await submitPermissionForm({ ...deps, notify: silent }, TOKEN, {})]) {
      assert.equal(reply.http, http);
      assert.equal(reply.body.state, state);
    }
    assert.equal(db.where(/insert into|update /).length, 0);
    assert.equal(db.where(/from permission_requests/).length, 0);
  }
});

test('bad input is refused plainly before any permission data is touched', async () => {
  const db = new FakeDb().on(/from form_tokens/, { rows: [{ id: 'tok-1', employee_id: 7, purpose: 'PERMISSION', expires_at: new Date('2026-09-01T05:30:00Z'), used_at: null }] });
  const deps = { pool: db.asPool(), now: () => NOW };
  const silent: PermissionNotifier = { permissionSubmitted: async () => {}, replyToEmployee: async () => {} };
  for (const body of [undefined, {}, { date: '2026-09-08' }, { date: '2026-09-08', startTime: '10:00' }, { date: 5, startTime: '10:00', endTime: '11:00' }]) {
    assert.equal((await previewPermissionForm(deps, TOKEN, body as Record<string, unknown>)).http, 400, JSON.stringify(body));
    assert.equal((await submitPermissionForm({ ...deps, notify: silent }, TOKEN, body as Record<string, unknown>)).http, 400);
  }
  assert.equal((await cancelPermissionForm(deps, TOKEN, { requestId: '1; drop table' })).http, 400);
  assert.equal(db.where(/from permission_requests|insert into permission/).length, 0);
});

test('the link message says how long it works and not to share it', () => {
  const text = permissionFormText('https://portal.test/p/abc', 30);
  assert.match(text, /^Open this link to ask for permission:\nhttps:\/\/portal\.test\/p\/abc/);
  assert.match(text, /works for 30 minutes/);
  assert.match(text, /Do not share it with anyone\.$/);
});

const row = (over: Record<string, unknown> = {}) => ({
  id: ID, status: 'PENDING', employee_id: 7, campus_id: 1, permission_date: '2026-09-08', start_time: '10:00', end_time: '11:30', reason: 'x',
  submitted_via: 'WHATSAPP_LINK', decided_via: null, decision_note: null, cancelled_by: null, cancel_reason: null, ...over,
});
const build = (status = 'PENDING') => { const db = new FakeDb().on(/for update/, { rows: [row({ status })] }); return { db, pool: db.asPool() }; };

test('decisions: approve once, reject with a reason, cancel by who and when', async () => {
  const a = build();
  assert.equal((await approvePermission(a.pool, { requestId: ID, via: 'WHATSAPP', userId: null })).status, 'DONE');
  assert.deepEqual(a.db.where(/update permission_requests/)[0].params, [ID, 'WHATSAPP', null]);
  assert.equal(a.db.where(/leave_ledger/).length, 0, 'a permission never touches the leave ledger');
  for (const status of ['APPROVED', 'REJECTED', 'CANCELLED']) {
    const b = build(status);
    assert.equal((await approvePermission(b.pool, { requestId: ID, via: 'WEB', userId: 1 })).status, 'ALREADY', status);
    assert.equal(b.db.where(/update permission_requests/).length, 0);
  }
  for (const note of [undefined, '', '  ', 'x'.repeat(501)]) {
    const c = build();
    const r = await rejectPermission(c.pool, { requestId: ID, via: 'WEB', userId: 1, note });
    assert.ok(r.status === 'REFUSED' && r.code === 'INVALID_INPUT');
    assert.equal(c.db.calls.length, 0, 'checked before touching the database');
  }
  const d = build();
  await rejectPermission(d.pool, { requestId: ID, via: 'WEB', userId: 1, note: '  Staff   meeting ' });
  assert.equal(d.db.where(/update permission_requests/)[0].params[3], 'Staff meeting');

  assert.equal((await cancelPermission(build().pool, { requestId: ID, canceller: { by: 'EMPLOYEE', employeeId: 7 }, reason: '' })).status, 'DONE');
  assert.equal((await cancelPermission(build().pool, { requestId: ID, canceller: { by: 'EMPLOYEE', employeeId: 8 }, reason: '' })).status, 'NOT_FOUND');
  const own = await cancelPermission(build('APPROVED').pool, { requestId: ID, canceller: { by: 'EMPLOYEE', employeeId: 7 }, reason: 'x' });
  assert.ok(own.status === 'REFUSED' && own.code === 'NOT_ALLOWED');
  const noWhy = await cancelPermission(build('APPROVED').pool, { requestId: ID, canceller: { by: 'DIRECTOR' }, reason: '' });
  assert.ok(noWhy.status === 'REFUSED' && noWhy.code === 'INVALID_INPUT');
  assert.equal((await cancelPermission(build('APPROVED').pool, { requestId: ID, canceller: { by: 'ADMIN' }, reason: 'Moved' })).status, 'DONE');
  assert.equal((await cancelPermission(build('REJECTED').pool, { requestId: ID, canceller: { by: 'DIRECTOR' }, reason: 'x' })).status, 'REFUSED');
  assert.equal((await cancelPermission(build('CANCELLED').pool, { requestId: ID, canceller: { by: 'DIRECTOR' }, reason: 'x' })).status, 'ALREADY');
});
