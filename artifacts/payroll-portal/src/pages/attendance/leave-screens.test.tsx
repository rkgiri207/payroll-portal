import assert from 'node:assert/strict';
import test from 'node:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { Router } from 'wouter';
import type { Me } from './api';
import type { AcademicYear } from './leave-api';
import LeavePoliciesPage from './leave-policies';
import { policyKeys, type LeaveType, type Policy, type PolicyRow } from './leave-policy-api';
import { leaveKeys } from './leave-api';
import { LeaveTypesTab } from './leave-types-tab';
import { PolicyTab } from './policy-tab';
import LeaveRequestsPage from './leave-requests';
import { requestKeys, type LeaveRequest } from './leave-requests-api';
import { keys } from './use-attendance';

const me: Me = { userId: 1, role: 'DIRECTOR', canEditDirectorSettings: true, whatsappMode: 'live' };
const year: AcademicYear = { id: 1, label: '2026-27', startDate: '2026-06-12', endDate: '2027-04-23', draftCount: 0, confirmedCount: 45, accrualFrom: null };
const year2: AcademicYear = { id: 2, label: '2027-28', startDate: '2027-06-12', endDate: '2028-04-23', draftCount: 0, confirmedCount: 0, accrualFrom: null };

const casual: LeaveType = { id: 1, code: 'CASUAL', name: 'Casual Leave', isPaid: true, tracksBalance: true, isActive: true, sortOrder: 1 };
const unpaid: LeaveType = { id: 4, code: 'UNPAID', name: 'Unpaid Leave', isPaid: false, tracksBalance: false, isActive: true, sortOrder: 4 };
const policy: Policy = {
  creditMode: 'MONTHLY', defaultAnnualDays: 12, monthlyAccrualDays: 1.25, carryForwardMode: 'LIMIT', carryForwardLimit: 5, encashmentAllowed: true,
  encashmentLimitDays: 3, insufficientBalance: 'LOP', allowHalfDay: true, minNoticeDays: 2, maxConsecutiveDays: 10, updatedAt: '2026-11-26',
};

function render(node: React.ReactElement, preload: (client: QueryClient) => void = () => {}): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  preload(client);
  return renderToStaticMarkup(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

test('policy tab: saved policy shows a plain summary; an unset one is open for setup', () => {
  const rows: PolicyRow[] = [{ type: casual, policy }, { type: unpaid, policy: null }];
  const html = render(<PolicyTab year={year} otherYears={[year2]} />, c => c.setQueryData(policyKeys.policies(1), rows));
  assert.match(html, /1\.25 days credited each month; carry forward up to 5 days; encashment allowed; extra days are loss of pay\./);
  assert.match(html, /academic year <strong>2026-27<\/strong> only/);
  assert.match(html, /1 leave type has no policy yet/);
  assert.match(html, /Copy policies from/);                       // another year exists and a policy is missing
  assert.match(html, /Not set/);
  assert.match(html, /Unpaid Leave has no balance, so only the request rules below apply/);
  assert.ok(!/id="days-4"/.test(html), 'an unpaid leave type must not offer yearly days');
  assert.ok(!/id="days-1"/.test(html), 'a saved policy starts collapsed');
});

test('policy tab: no copy option when there is no other year or nothing is missing', () => {
  const full: PolicyRow[] = [{ type: casual, policy }, { type: unpaid, policy: { ...policy, defaultAnnualDays: 0 } }];
  assert.ok(!/Copy policies from/.test(render(<PolicyTab year={year} otherYears={[year2]} />, c => c.setQueryData(policyKeys.policies(1), full))));
  const missing: PolicyRow[] = [{ type: casual, policy: null }];
  assert.ok(!/Copy policies from/.test(render(<PolicyTab year={year} otherYears={[]} />, c => c.setQueryData(policyKeys.policies(1), missing))));
});

test('leave types tab lists every type with its pay and balance behaviour', () => {
  const html = render(<LeaveTypesTab />, c => c.setQueryData(policyKeys.types, [casual, { ...unpaid, isActive: false }]));
  assert.match(html, /Casual Leave/);
  assert.match(html, /Paid/);
  assert.match(html, /Keeps a balance/);
  assert.match(html, /Without pay/);
  assert.match(html, /No balance/);
  assert.match(html, />Off</);
  assert.match(html, /Add leave type/);
  assert.match(html, /aria-label="Edit Casual Leave"/);
});

test('leave policies page: asks for an academic year first when none exists', () => {
  const html = render(<Router ssrPath="/leave/policies"><LeavePoliciesPage /></Router>, c => { c.setQueryData(keys.me, me); c.setQueryData(leaveKeys.years, []); });
  assert.match(html, /Set up an academic year first/);
  assert.match(html, /href="\/leave\/calendar"/);
});

test('leave policies page: heading and explanation render with years present', () => {
  const html = render(<Router ssrPath="/leave/policies"><LeavePoliciesPage /></Router>, c => { c.setQueryData(keys.me, me); c.setQueryData(leaveKeys.years, [year, year2]); });
  assert.match(html, /Leave policies/);
  assert.match(html, /Everything follows your academic year/);
  assert.match(html, /Academic year/);
});

const pending: LeaveRequest = {
  id: '8a3f1c52-7d1e-4b0a-9a55-0c2f6b8d1e77', status: 'PENDING', employeeId: 7, employeeCode: 'T001', employeeName: 'Asha Rao', leaveTypeId: 1,
  leaveTypeName: 'Casual Leave', academicYearId: 1, academicYearLabel: '2026-27', campusId: 1, campusName: 'Main Campus',
  startDate: '2026-10-07', endDate: '2026-10-08', dayMode: 'FULL', reason: 'Family function', totalDays: 2, paidDays: 1, lopDays: 1,
  submittedVia: 'WHATSAPP_LINK', submittedAt: '2020-01-01 09:00:00+00', decidedVia: null, decidedAt: null, decisionNote: null, cancelledBy: null, cancelReason: null,
};

function renderRequests(role: Me['role'], requests: LeaveRequest[]) {
  return render(<Router ssrPath="/leave/requests"><LeaveRequestsPage /></Router>, c => {
    c.setQueryData(keys.me, { ...me, role });
    c.setQueryData(leaveKeys.years, [year]);
    c.setQueryData(requestKeys.list('PENDING', null), { requests, counts: { PENDING: requests.length, APPROVED: 3, REJECTED: 1, CANCELLED: 0 } });
  });
}

test('leave requests: the Director sees a pending request with its cost and working Approve and Reject buttons', () => {
  const html = renderRequests('DIRECTOR', [pending]);
  assert.match(html, /Asha Rao/);
  assert.match(html, /Casual Leave · 07 Oct 2026 to 08 Oct 2026/);
  assert.match(html, /2 days \(1 paid, 1 without pay\)/);
  assert.match(html, /Family function/);
  assert.match(html, /Pending \(1\)/);
  assert.match(html, /Approved \(3\)/);
  assert.match(html, /Waiting \d+ days?/);
  assert.ok(!/Only the Director can approve or reject\./.test(html));
  const approve = html.match(/<button[^>]*>(?:(?!<\/button>).)*Approve<\/button>/)?.[0] ?? '';
  assert.ok(approve && !/ disabled=""/.test(approve), 'Approve must be usable for the Director');
});

test('leave requests: a non-Director cannot approve or reject and is told why', () => {
  const html = renderRequests('ADMIN', [pending]);
  assert.match(html, /Only the Director can approve or reject\./);
  const approve = html.match(/<button[^>]*>(?:(?!<\/button>).)*Approve<\/button>/)?.[0] ?? '';
  assert.match(approve, / disabled=""/);
  assert.match(html, /Cancel leave/);                                   // an administrator may still cancel
});

test('leave requests: an empty pending list says so', () => {
  assert.match(renderRequests('DIRECTOR', []), /No leave requests are waiting for a decision\./);
});
