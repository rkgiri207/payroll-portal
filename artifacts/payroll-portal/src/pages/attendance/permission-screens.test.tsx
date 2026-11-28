import assert from 'node:assert/strict';
import test from 'node:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { clockText, minutesOf, permissionDecisionLine, permissionWhen } from './permission-helpers';
import { PermissionRequestsPanel } from './permission-requests-panel';
import { permissionKeys, type PermissionRequest } from './permission-requests-api';

const base: PermissionRequest = {
  id: '8a3f1c52-7d1e-4b0a-9a55-0c2f6b8d1e77', status: 'PENDING', employeeId: 7, employeeCode: 'T001', employeeName: 'Asha Rao', campusName: 'Main Campus',
  date: '2026-09-08', startTime: '10:00', endTime: '11:30', reason: 'Doctor appointment', submittedVia: 'WHATSAPP_LINK',
  submittedAt: '2020-01-01 09:00:00+00', decidedVia: null, decidedAt: null, decisionNote: null, cancelledBy: null, cancelReason: null,
};

test('times and lengths read naturally', () => {
  assert.equal(clockText('00:30'), '12:30 AM');
  assert.equal(clockText('09:05'), '9:05 AM');
  assert.equal(clockText('12:00'), '12:00 PM');
  assert.equal(clockText('15:45'), '3:45 PM');
  assert.equal(minutesOf(base), 90);
  assert.equal(permissionWhen(base), '08 Sep 2026, 10:00 AM to 11:30 AM (1 hour 30 minutes)');
  assert.equal(permissionWhen({ ...base, endTime: '10:20' }), '08 Sep 2026, 10:00 AM to 10:20 AM (20 minutes)');
  assert.equal(permissionWhen({ ...base, endTime: '11:00' }), '08 Sep 2026, 10:00 AM to 11:00 AM (1 hour)');
});

test('the history line says who decided, how and why', () => {
  assert.equal(permissionDecisionLine(base), null);
  assert.equal(permissionDecisionLine({ ...base, status: 'APPROVED', decidedVia: 'WHATSAPP' }), 'Approved by the Director on WhatsApp');
  assert.equal(permissionDecisionLine({ ...base, status: 'REJECTED', decidedVia: 'WEB', decisionNote: 'Staff meeting then' }), 'Not approved by the Director on the web: Staff meeting then');
  assert.equal(permissionDecisionLine({ ...base, status: 'CANCELLED', cancelledBy: 'EMPLOYEE', cancelReason: 'Plans changed' }), 'Cancelled by the employee: Plans changed');
  assert.equal(permissionDecisionLine({ ...base, status: 'CANCELLED', cancelledBy: 'ADMIN' }), 'Cancelled by an administrator');
});

function render(isDirector: boolean, permissions: PermissionRequest[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(permissionKeys.list('PENDING'), { permissions, counts: { PENDING: permissions.length, APPROVED: 4, REJECTED: 1, CANCELLED: 2 } });
  return renderToStaticMarkup(<QueryClientProvider client={client}><PermissionRequestsPanel isDirector={isDirector} /></QueryClientProvider>);
}
const approveButton = (html: string) => html.match(/<button[^>]*>(?:(?!<\/button>).)*Approve<\/button>/)?.[0] ?? '';

test('the Director sees a pending permission with working buttons and counts on the tabs', () => {
  const html = render(true, [base]);
  assert.match(html, /Asha Rao/);
  assert.match(html, /08 Sep 2026, 10:00 AM to 11:30 AM \(1 hour 30 minutes\)/);
  assert.match(html, /Doctor appointment/);
  assert.match(html, /Pending \(1\)/);
  assert.match(html, /Approved \(4\)/);
  assert.match(html, /Waiting \d+ days?/);
  assert.match(html, /use no leave balance/);
  const approve = approveButton(html);
  assert.ok(approve && !/ disabled=""/.test(approve));
  assert.ok(!/Only the Director can approve or reject\./.test(html));
});

test('a non-Director cannot approve or reject, and is told why', () => {
  const html = render(false, [base]);
  assert.match(approveButton(html), / disabled=""/);
  assert.match(html, /Only the Director can approve or reject\./);
  assert.match(html, /Cancel permission/);
});

test('an empty list says so', () => {
  assert.match(render(true, []), /No permission requests are waiting for a decision\./);
});
