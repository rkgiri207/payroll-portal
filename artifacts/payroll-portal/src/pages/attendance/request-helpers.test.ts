import assert from 'node:assert/strict';
import test from 'node:test';
import type { LeaveRequest } from './leave-requests-api';
import { canCancel, cancelNeedsReason, decisionLine, isAutoRejected, requestCost, requestDates, waitingDays } from './request-helpers';

const req = (over: Partial<LeaveRequest> = {}): LeaveRequest => ({
  id: 'x', status: 'PENDING', employeeId: 1, employeeCode: 'T001', employeeName: 'Asha Rao', leaveTypeId: 1, leaveTypeName: 'Casual Leave',
  academicYearId: 1, academicYearLabel: '2026-27', campusId: 1, campusName: 'Main Campus', startDate: '2026-10-07', endDate: '2026-10-08',
  dayMode: 'FULL', reason: 'Family function', totalDays: 2, paidDays: 2, lopDays: 0, submittedVia: 'WHATSAPP_LINK', submittedAt: '2026-10-01 09:00:00+00',
  decidedVia: null, decidedAt: null, decisionNote: null, cancelledBy: null, cancelReason: null, ...over,
});

test('dates and cost read naturally', () => {
  assert.equal(requestDates(req()), '07 Oct 2026 to 08 Oct 2026');
  assert.equal(requestDates(req({ endDate: '2026-10-07', dayMode: 'FIRST_HALF', totalDays: 0.5 })), '07 Oct 2026 (first half)');
  assert.equal(requestCost(req()), '2 days (2 paid)');
  assert.equal(requestCost(req({ totalDays: 3, paidDays: 1, lopDays: 2 })), '3 days (1 paid, 2 without pay)');
  assert.equal(requestCost(req({ totalDays: 1, paidDays: 1 })), '1 day (1 paid)');
});

test('the history line says who decided, how, and why', () => {
  assert.equal(decisionLine(req()), null);
  assert.equal(decisionLine(req({ status: 'APPROVED', decidedVia: 'WHATSAPP' })), 'Approved by the Director on WhatsApp');
  assert.equal(decisionLine(req({ status: 'REJECTED', decidedVia: 'WEB', decisionNote: 'Exams that week' })), 'Not approved by the Director on the web: Exams that week');
  assert.equal(decisionLine(req({ status: 'REJECTED', decidedVia: 'SYSTEM', decisionNote: 'Campus limit of 2 reached on 2026-10-07' })), 'Campus limit of 2 reached on 2026-10-07');
  assert.equal(decisionLine(req({ status: 'CANCELLED', cancelledBy: 'EMPLOYEE', cancelReason: 'Plans changed' })), 'Cancelled by the employee: Plans changed');
  assert.equal(decisionLine(req({ status: 'CANCELLED', cancelledBy: 'ADMIN' })), 'Cancelled by an administrator');
});

test('automatic rejections are recognised; cancelling rules', () => {
  assert.ok(isAutoRejected(req({ status: 'REJECTED', decidedVia: 'SYSTEM' })));
  assert.ok(!isAutoRejected(req({ status: 'REJECTED', decidedVia: 'WEB' })));
  assert.ok(!isAutoRejected(req({ status: 'PENDING' })));
  assert.deepEqual(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'].map(s => canCancel({ status: s as LeaveRequest['status'] })), [true, true, false, false]);
  assert.ok(cancelNeedsReason({ status: 'APPROVED' }) && !cancelNeedsReason({ status: 'PENDING' }));
});

test('waiting time counts whole days and never goes negative', () => {
  const now = new Date('2026-10-04T10:00:00Z');
  assert.equal(waitingDays('2026-10-01 09:00:00+00', now), 3);
  assert.equal(waitingDays('2026-10-04 09:00:00+00', now), 0);
  assert.equal(waitingDays('2026-12-01 09:00:00+00', now), 0);
  assert.equal(waitingDays('2026-10-01 09:00:00.123456+00', now), 3);
  assert.equal(waitingDays('2026-10-01 14:30:00+05:30', now), 3);
  assert.equal(waitingDays('garbage', now), 0);
});
