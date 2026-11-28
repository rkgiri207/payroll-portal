import assert from 'node:assert/strict';
import test from 'node:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Me } from './api';
import { accrualKeys, type AccrualSummary, type OpeningRow } from './accrual-api';
import { accrualFromText, changedEntries, entryText, isValidDaysText, summaryLine } from './accrual-helpers';
import { AccrualTab } from './accrual-tab';
import type { AcademicYear } from './leave-api';
import { policyKeys, type LeaveType } from './leave-policy-api';
import { creditPhrase, fmtDays, formToBody, policyToForm } from './policy-helpers';
import { keys } from './use-attendance';

const year: AcademicYear = { id: 1, label: '2026-27', startDate: '2026-06-12', endDate: '2027-04-23', draftCount: 0, confirmedCount: 45, accrualFrom: '2026-12-01' };
const casual: LeaveType = { id: 1, code: 'CASUAL', name: 'Casual Leave', isPaid: true, tracksBalance: true, isActive: true, sortOrder: 1 };
const me = (role: Me['role']): Me => ({ userId: 1, role, canEditDirectorSettings: role === 'DIRECTOR', whatsappMode: 'live' });

test('days are shown tidily, with up to two decimals and no noise', () => {
  assert.equal(fmtDays(1), '1');
  assert.equal(fmtDays(1.5), '1.5');
  assert.equal(fmtDays(1.25), '1.25');
  assert.equal(fmtDays(1.1), '1.1');
  assert.equal(fmtDays(0.1 + 0.2), '0.3');
  assert.equal(fmtDays(12), '12');
});

test('how leave is credited, in a phrase', () => {
  assert.equal(creditPhrase('MONTHLY', 1.25, 0), '1.25 days credited each month');
  assert.equal(creditPhrase('MONTHLY', 1, 0), '1 day credited each month');
  assert.match(creditPhrase('MONTHLY', 0, 0), /set the days each month/);
  assert.equal(creditPhrase('UPFRONT', 0, 12), '12 days credited at the start');
  assert.equal(creditPhrase('MANUAL', 1, 12), 'credited manually');
});

test('the policy form sends the monthly days only for monthly credit', () => {
  const form = policyToForm({ creditMode: 'MONTHLY', defaultAnnualDays: 12, monthlyAccrualDays: 1.25, carryForwardMode: 'NONE', carryForwardLimit: null, encashmentAllowed: false,
    encashmentLimitDays: null, insufficientBalance: 'LOP', allowHalfDay: true, minNoticeDays: 0, maxConsecutiveDays: null, updatedAt: null });
  assert.equal(form.monthlyAccrualDays, '1.25');
  assert.equal(formToBody(form).monthlyAccrualDays, '1.25');
  assert.equal(formToBody({ ...form, creditMode: 'UPFRONT' }).monthlyAccrualDays, '0');
  assert.equal(formToBody({ ...form, creditMode: 'MANUAL' }).monthlyAccrualDays, '0');
});

test('the accrual explanation names the month leave starts being credited from', () => {
  assert.match(accrualFromText(year), /from December 2026\. Months before that are never credited/);
  assert.match(accrualFromText({ ...year, accrualFrom: null }), /from June 2026, the first month of the academic year/);
});

test('a preview or run reads as one clear line', () => {
  const s = (over: Partial<AccrualSummary> = {}): AccrualSummary => ({ today: '2026-12-01', year: { id: 1, label: '2026-27', accrualFrom: '2026-12-01' }, dryRun: true,
    employeesConsidered: 3, creditsPosted: 6, adjustmentsPosted: 0, daysPosted: 7.5, missingJoiningDate: [], lines: [], truncated: false, ...over });
  assert.equal(summaryLine(s()), 'Would credit 6 credits, 7.5 days in total, to 3 employees.');
  assert.equal(summaryLine(s({ dryRun: false, creditsPosted: 1, employeesConsidered: 1, daysPosted: 1.25 })), 'Credited 1 credit, 1.25 days in total, to 1 employee.');
  assert.equal(summaryLine(s({ adjustmentsPosted: 2 })), 'Would credit 6 credits and 2 catch-ups, 7.5 days in total, to 3 employees.');
  assert.equal(summaryLine(s({ creditsPosted: 0, daysPosted: 0 })), 'Nothing is due today (3 employees checked).');
  assert.match(summaryLine(s({ year: null })), /outside every academic year/);
  assert.equal(entryText({ entryType: 'CREDIT', amount: 1.25, effectiveDate: '2026-12-01', period: '2026-12', reason: '' }), '+1.25 for December 2026');
  assert.equal(entryText({ entryType: 'ADJUSTMENT', amount: 1, effectiveDate: '2027-02-01', period: '2027-02', reason: '' }), '+1 catch-up');
});

test('opening balances: only real changes are saved, and only for people with a joining date', () => {
  const rows: OpeningRow[] = [
    { employeeId: 1, employeeCode: 'A', employeeName: 'Asha', joiningDate: '2024-04-01', opening: null },
    { employeeId: 2, employeeCode: 'B', employeeName: 'Bala', joiningDate: '2024-04-01', opening: 4 },
    { employeeId: 3, employeeCode: 'C', employeeName: 'Chitra', joiningDate: null, opening: null },
    { employeeId: 4, employeeCode: 'D', employeeName: 'Dev', joiningDate: '2024-04-01', opening: null },
  ];
  assert.deepEqual(changedEntries(rows, { 1: '3.25', 2: '4', 3: '5', 4: '0' }), [{ employeeId: 1, days: '3.25' }], 'B unchanged, C has no joining date, D is zero with nothing before');
  assert.deepEqual(changedEntries(rows, { 2: '4.5' }), [{ employeeId: 2, days: '4.5' }], 'a correction');
  assert.deepEqual(changedEntries(rows, { 2: '0' }), [{ employeeId: 2, days: '0' }], 'correcting down to zero is a change');
  assert.deepEqual(changedEntries(rows, { 1: '  ', 2: '' }), [], 'blank means nothing entered');
  assert.deepEqual(changedEntries(rows, {}), []);
  for (const ok of ['', '4', '4.5', '4.25', '0', '366']) assert.ok(isValidDaysText(ok), ok);
  for (const bad of ['-1', '4.123', 'abc', '4,5', '367', '1e3', '.5']) assert.ok(!isValidDaysText(bad), bad);
});

function render(role: Me['role'], missing: { employeeId: number; employeeCode: string; employeeName: string }[], opening: OpeningRow[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(keys.me, me(role));
  client.setQueryData(accrualKeys.missing, missing);
  client.setQueryData(policyKeys.types, [casual]);
  client.setQueryData(accrualKeys.opening(1, 0, ''), opening);   // before a leave type is chosen the screen reads this key
  return renderToStaticMarkup(<QueryClientProvider client={client}><AccrualTab year={year} /></QueryClientProvider>);
}
const buttonWith = (html: string, text: string) => html.match(new RegExp(`<button[^>]*>(?:(?!</button>).)*${text}</button>`))?.[0] ?? '';

test('the accrual tab explains the rules and offers a preview, and "Credit now" only to the Director', () => {
  const dir = render('DIRECTOR', [], []);
  assert.match(dir, /Monthly credit, 2026-27/);
  assert.match(dir, /Leave is credited on the 1st of each month from December 2026/);
  assert.match(dir, /The month an employee joins earns nothing/);
  assert.match(dir, /Preview what would be credited today/);
  assert.ok(!/ disabled=""/.test(buttonWith(dir, 'Credit now')), 'usable for the Director');
  const admin = render('ADMIN', [], []);
  assert.match(buttonWith(admin, 'Credit now'), / disabled=""/);
  assert.match(admin, /Only the Director can credit now/);
  assert.match(admin, /Preview what would be credited today/, 'anyone with access can preview');
});

test('employees with no joining date are called out, with what to do', () => {
  const html = render('DIRECTOR', [{ employeeId: 3, employeeCode: 'C', employeeName: 'Chitra' }, { employeeId: 4, employeeCode: 'D', employeeName: 'Dev' }], []);
  assert.match(html, /2 employees have no joining date/);
  assert.match(html, /Chitra \(C\), Dev \(D\)/);
  assert.match(html, /until their joining date is on their employee record/);
  assert.ok(!/have no joining date/.test(render('DIRECTOR', [], [])), 'nothing shown when everyone has one');
  assert.match(render('DIRECTOR', [{ employeeId: 3, employeeCode: 'C', employeeName: 'Chitra' }], []), /1 employee has no joining date/);
});

test('opening balances are explained, with the date they are recorded at', () => {
  const html = render('DIRECTOR', [], []);
  assert.match(html, /Opening balances, 2026-27/);
  assert.match(html, /It is dated 2026-12-01/);
  assert.match(html, /never overwritten/);
  assert.match(html, /Fill for everyone/);
  assert.match(html, /Save opening balances/);
});
