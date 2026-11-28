import type { CarryForwardMode, CreditMode, InsufficientBalance, Policy } from './leave-policy-api';

/** Days, tidily: 1 -> "1", 1.5 -> "1.5", 1.25 -> "1.25", 1.10 -> "1.1". Never floating-point noise. */
export function fmtDays(n: number): string {
  return String(Math.round(n * 100) / 100);
}
const days = (n: number) => `${fmtDays(n)} day${fmtDays(n) === '1' ? '' : 's'}`;

export const CREDIT_OPTIONS: { value: CreditMode; label: string; help: string }[] = [
  { value: 'MONTHLY', label: 'A fixed number of days every month', help: 'Credited on the 1st of each month. The month an employee joins earns nothing; credits start the next month. Unused days carry on until the end of the academic year.' },
  { value: 'UPFRONT', label: 'All at the start', help: 'The full yearly days are credited at once, in the first month the employee is eligible.' },
  { value: 'MANUAL', label: 'Only when I add it', help: 'Nothing is credited automatically. Add days yourself.' },
];

export const CARRY_OPTIONS: { value: CarryForwardMode; label: string }[] = [
  { value: 'NONE', label: 'Unused leave lapses at year end' },
  { value: 'LIMIT', label: 'Carry forward up to a limit' },
  { value: 'ALL', label: 'Carry forward everything unused' },
];

export const INSUFFICIENT_OPTIONS: { value: InsufficientBalance; label: string; help: string }[] = [
  { value: 'LOP', label: 'The extra days become loss of pay', help: 'The Director still approves each request and sees the paid and loss-of-pay split.' },
  { value: 'REJECT', label: 'Refuse the request', help: 'An employee cannot ask for more than the balance.' },
  { value: 'NEGATIVE', label: 'Let the balance go negative', help: 'The shortfall is taken from future credits.' },
];

export const labelOf = <T extends string>(options: { value: T; label: string }[], value: T): string =>
  options.find(o => o.value === value)?.label ?? value;

/** How leave is credited, in one phrase, for a given mode and numbers. */
export function creditPhrase(mode: CreditMode, monthly: number, yearly: number): string {
  if (mode === 'MONTHLY') return monthly > 0 ? `${days(monthly)} credited each month` : 'credited monthly (set the days each month)';
  if (mode === 'UPFRONT') return `${days(yearly)} credited at the start`;
  return 'credited manually';
}

/** One readable line describing a saved policy, for the collapsed card. */
export function describePolicy(policy: Policy | null, tracksBalance: boolean): string {
  if (!policy) return 'Not set yet. Nothing is credited until you save a policy.';
  if (!tracksBalance) {
    const parts = [policy.allowHalfDay ? 'half-days allowed' : 'no half-days'];
    if (policy.minNoticeDays > 0) parts.push(`${days(policy.minNoticeDays)} notice`);
    if (policy.maxConsecutiveDays) parts.push(`up to ${days(policy.maxConsecutiveDays)} at a time`);
    const text = parts.join(', ');
    return `No balance. ${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
  }
  const parts = [
    policy.carryForwardMode === 'NONE' ? 'unused days lapse at year end'
      : policy.carryForwardMode === 'ALL' ? 'carry forward all' : `carry forward up to ${days(policy.carryForwardLimit ?? 0)}`,
    policy.encashmentAllowed ? 'encashment allowed' : 'no encashment',
    policy.insufficientBalance === 'LOP' ? 'extra days are loss of pay'
      : policy.insufficientBalance === 'REJECT' ? 'refused beyond the balance' : 'balance may go negative',
  ];
  const credit = creditPhrase(policy.creditMode, policy.monthlyAccrualDays, policy.defaultAnnualDays);
  return `${credit.charAt(0).toUpperCase()}${credit.slice(1)}; ${parts.join('; ')}.`;
}

/** Form values are kept as text so a field can be empty while someone types. */
export interface PolicyForm {
  creditMode: CreditMode; defaultAnnualDays: string; monthlyAccrualDays: string; carryForwardMode: CarryForwardMode; carryForwardLimit: string;
  encashmentAllowed: boolean; encashmentLimitDays: string; insufficientBalance: InsufficientBalance;
  allowHalfDay: boolean; minNoticeDays: string; maxConsecutiveDays: string;
}

export const emptyPolicyForm = (): PolicyForm => ({
  creditMode: 'MANUAL', defaultAnnualDays: '0', monthlyAccrualDays: '0', carryForwardMode: 'NONE', carryForwardLimit: '', encashmentAllowed: false,
  encashmentLimitDays: '', insufficientBalance: 'LOP', allowHalfDay: true, minNoticeDays: '0', maxConsecutiveDays: '',
});

export const policyToForm = (p: Policy | null): PolicyForm => !p ? emptyPolicyForm() : ({
  creditMode: p.creditMode, defaultAnnualDays: String(p.defaultAnnualDays), monthlyAccrualDays: String(p.monthlyAccrualDays),
  carryForwardMode: p.carryForwardMode, carryForwardLimit: p.carryForwardLimit === null ? '' : String(p.carryForwardLimit),
  encashmentAllowed: p.encashmentAllowed, encashmentLimitDays: p.encashmentLimitDays === null ? '' : String(p.encashmentLimitDays),
  insufficientBalance: p.insufficientBalance, allowHalfDay: p.allowHalfDay, minNoticeDays: String(p.minNoticeDays),
  maxConsecutiveDays: p.maxConsecutiveDays === null ? '' : String(p.maxConsecutiveDays),
});

/** The request body. The server validates again; this only tidies what the form holds. */
export const formToBody = (f: PolicyForm) => ({
  creditMode: f.creditMode, defaultAnnualDays: f.defaultAnnualDays,
  // The monthly days only matter for monthly credit, and the yearly days only for "all at the start".
  monthlyAccrualDays: f.creditMode === 'MONTHLY' ? f.monthlyAccrualDays : '0',
  carryForwardMode: f.carryForwardMode,
  carryForwardLimit: f.carryForwardMode === 'LIMIT' ? f.carryForwardLimit : '', encashmentAllowed: f.encashmentAllowed,
  encashmentLimitDays: f.encashmentAllowed ? f.encashmentLimitDays : '', insufficientBalance: f.insufficientBalance,
  allowHalfDay: f.allowHalfDay, minNoticeDays: f.minNoticeDays, maxConsecutiveDays: f.maxConsecutiveDays,
});

export const sameForm = (a: PolicyForm, b: PolicyForm): boolean => JSON.stringify(formToBody(a)) === JSON.stringify(formToBody(b));
