import assert from 'node:assert/strict';
import test from 'node:test';
import type { Policy } from './leave-policy-api';
import { describePolicy, emptyPolicyForm, formToBody, policyToForm, sameForm } from './policy-helpers';

const policy: Policy = {
  creditMode: 'MONTHLY', defaultAnnualDays: 12, monthlyAccrualDays: 1.25, carryForwardMode: 'LIMIT', carryForwardLimit: 5, encashmentAllowed: true,
  encashmentLimitDays: 3, insufficientBalance: 'LOP', allowHalfDay: true, minNoticeDays: 2, maxConsecutiveDays: 10, updatedAt: null,
};

test('a saved policy reads as one clear line', () => {
  assert.equal(describePolicy(policy, true),
    '1.25 days credited each month; carry forward up to 5 days; encashment allowed; extra days are loss of pay.');
  assert.equal(describePolicy({ ...policy, defaultAnnualDays: 1, carryForwardMode: 'NONE', encashmentAllowed: false, creditMode: 'UPFRONT', insufficientBalance: 'REJECT' }, true),
    '1 day credited at the start; unused days lapse at year end; no encashment; refused beyond the balance.');
  assert.equal(describePolicy(null, true), 'Not set yet. Nothing is credited until you save a policy.');
});

test('a leave type without a balance describes only its request rules', () => {
  assert.equal(describePolicy({ ...policy, allowHalfDay: false, minNoticeDays: 1, maxConsecutiveDays: null }, false),
    'No balance. No half-days, 1 day notice.');
  assert.equal(describePolicy(policy, false), 'No balance. Half-days allowed, 2 days notice, up to 10 days at a time.');
});

test('the form round-trips a policy and drops options that do not apply', () => {
  const form = policyToForm(policy);
  assert.equal(form.carryForwardLimit, '5');
  assert.equal(formToBody(form).carryForwardLimit, '5');
  const all = { ...form, carryForwardMode: 'ALL' as const };
  assert.equal(formToBody(all).carryForwardLimit, '');                    // a limit means nothing for "carry forward all"
  const noEncash = { ...form, encashmentAllowed: false };
  assert.equal(formToBody(noEncash).encashmentLimitDays, '');
  assert.ok(sameForm(form, policyToForm(policy)));
  assert.ok(!sameForm(form, { ...form, defaultAnnualDays: '13' }));
  // changing a value that does not apply is not a change
  assert.ok(sameForm(all, { ...all, carryForwardLimit: '99' }));
});

test('an unset policy starts inert', () => {
  const f = emptyPolicyForm();
  assert.deepEqual([f.creditMode, f.defaultAnnualDays, f.carryForwardMode, f.encashmentAllowed, f.insufficientBalance], ['MANUAL', '0', 'NONE', false, 'LOP']);
  assert.deepEqual(policyToForm(null), f);
});
