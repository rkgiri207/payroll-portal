import type { Result } from '../attendance/adminValidation';
import { isTwoDecimals } from './balance';

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const fail = <T = never>(error: string): Result<T> => ({ ok: false, error });
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export const MAX_DAYS = 366;

export type CreditMode = 'UPFRONT' | 'MONTHLY' | 'MANUAL';
export type CarryForwardMode = 'NONE' | 'LIMIT' | 'ALL';
export type InsufficientBalance = 'REJECT' | 'LOP' | 'NEGATIVE';

const CREDIT_MODES: CreditMode[] = ['UPFRONT', 'MONTHLY', 'MANUAL'];
const CARRY_MODES: CarryForwardMode[] = ['NONE', 'LIMIT', 'ALL'];
const INSUFFICIENT: InsufficientBalance[] = ['REJECT', 'LOP', 'NEGATIVE'];

const blank = (v: unknown) => v === undefined || v === null || v === '';

/** Days: a number from 0 to 366 with at most two decimal places. Accepts "12" or 12. */
function days(value: unknown, label: string): Result<number> {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > MAX_DAYS || !isTwoDecimals(n)) {
    return fail(`${label} must be a number from 0 to ${MAX_DAYS} with at most 2 decimal places`);
  }
  return ok(n);
}

function wholeNumber(value: unknown, label: string, min: number, max: number): Result<number> {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > max) return fail(`${label} must be a whole number from ${min} to ${max}`);
  return ok(n);
}

function flag(value: unknown, label: string): Result<boolean> {
  return typeof value === 'boolean' ? ok(value) : fail(`${label} must be on or off`);
}

function oneOf<T extends string>(value: unknown, allowed: T[], label: string): Result<T> {
  return typeof value === 'string' && (allowed as string[]).includes(value) ? ok(value as T) : fail(`${label} is not a valid choice`);
}

// ── Leave types ───────────────────────────────────────────────────────────────
export interface LeaveTypeInput { code: string; name: string; isPaid: boolean; tracksBalance: boolean }

export function validateLeaveType(body: unknown): Result<LeaveTypeInput> {
  if (!isRecord(body)) return fail('Send the leave type details');
  const code = typeof body.code === 'string' ? body.code.trim().toUpperCase() : '';
  if (!/^[A-Z0-9_]{2,20}$/.test(code)) return fail('Code must be 2 to 20 letters, numbers or underscores');
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (name === '' || name.length > 60) return fail('Name is required (up to 60 characters)');
  const isPaid = flag(body.isPaid, 'Paid');
  if (!isPaid.ok) return isPaid;
  const tracksBalance = flag(body.tracksBalance, 'Tracks a balance');
  if (!tracksBalance.ok) return tracksBalance;
  return ok({ code, name, isPaid: isPaid.value, tracksBalance: tracksBalance.value });
}

export interface LeaveTypeChanges { name?: string; isActive?: boolean; sortOrder?: number; isPaid?: boolean; tracksBalance?: boolean }

export function validateLeaveTypeChanges(body: unknown): Result<LeaveTypeChanges> {
  if (!isRecord(body)) return fail('Send the changes');
  const out: LeaveTypeChanges = {};
  if (body.name !== undefined) {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (name === '' || name.length > 60) return fail('Name is required (up to 60 characters)');
    out.name = name;
  }
  for (const key of ['isActive', 'isPaid', 'tracksBalance'] as const) {
    if (body[key] !== undefined) {
      const f = flag(body[key], key);
      if (!f.ok) return fail(`${key === 'isActive' ? 'Active' : key === 'isPaid' ? 'Paid' : 'Tracks a balance'} must be on or off`);
      out[key] = f.value;
    }
  }
  if (body.sortOrder !== undefined) {
    const s = wholeNumber(body.sortOrder, 'Order', 0, 1000);
    if (!s.ok) return s;
    out.sortOrder = s.value;
  }
  return Object.keys(out).length === 0 ? fail('Nothing to change') : ok(out);
}

// ── Policy: one per leave type per academic year ──────────────────────────────
export interface PolicyInput {
  creditMode: CreditMode;
  defaultAnnualDays: number;
  /** Days credited on the 1st of each month when the credit mode is MONTHLY (two decimal places). */
  monthlyAccrualDays: number;
  carryForwardMode: CarryForwardMode;
  carryForwardLimit: number | null;
  encashmentAllowed: boolean;
  encashmentLimitDays: number | null;
  insufficientBalance: InsufficientBalance;
  allowHalfDay: boolean;
  minNoticeDays: number;
  maxConsecutiveDays: number | null;
}

/**
 * For a leave type without a balance (unpaid leave) only the request rules matter, so the balance
 * options are forced to their inert values whatever was sent.
 */
export function validatePolicy(body: unknown, type: { tracksBalance: boolean }): Result<PolicyInput> {
  if (!isRecord(body)) return fail('Send the policy details');
  const half = flag(body.allowHalfDay, 'Half-days');
  if (!half.ok) return half;
  const notice = wholeNumber(blank(body.minNoticeDays) ? 0 : body.minNoticeDays, 'Minimum notice', 0, 365);
  if (!notice.ok) return notice;
  let maxConsecutive: number | null = null;
  if (!blank(body.maxConsecutiveDays)) {
    const m = wholeNumber(body.maxConsecutiveDays, 'Longest single leave', 1, MAX_DAYS);
    if (!m.ok) return m;
    maxConsecutive = m.value;
  }
  const requestRules = { allowHalfDay: half.value, minNoticeDays: notice.value, maxConsecutiveDays: maxConsecutive };

  if (!type.tracksBalance) {
    return ok({
      creditMode: 'MANUAL', defaultAnnualDays: 0, monthlyAccrualDays: 0, carryForwardMode: 'NONE', carryForwardLimit: null,
      encashmentAllowed: false, encashmentLimitDays: null, insufficientBalance: 'LOP', ...requestRules,
    });
  }

  const creditMode = oneOf(body.creditMode, CREDIT_MODES, 'How leave is credited');
  if (!creditMode.ok) return creditMode;
  const annual = days(body.defaultAnnualDays, 'Yearly days');
  if (!annual.ok) return annual;
  const monthly = blank(body.monthlyAccrualDays) ? ok(0) : days(body.monthlyAccrualDays, 'Days credited each month');
  if (!monthly.ok) return monthly;
  const carryMode = oneOf(body.carryForwardMode, CARRY_MODES, 'Carry forward');
  if (!carryMode.ok) return carryMode;
  let carryLimit: number | null = null;
  if (carryMode.value === 'LIMIT') {
    if (blank(body.carryForwardLimit)) return fail('Enter the most days that can be carried forward');
    const c = days(body.carryForwardLimit, 'Carry-forward limit');
    if (!c.ok) return c;
    carryLimit = c.value;
  }
  const encash = flag(body.encashmentAllowed, 'Encashment');
  if (!encash.ok) return encash;
  let encashLimit: number | null = null;
  if (encash.value && !blank(body.encashmentLimitDays)) {
    const e = days(body.encashmentLimitDays, 'Encashment limit');
    if (!e.ok) return e;
    encashLimit = e.value;
  }
  const insufficient = oneOf(body.insufficientBalance, INSUFFICIENT, 'When the balance is not enough');
  if (!insufficient.ok) return insufficient;

  return ok({
    creditMode: creditMode.value, defaultAnnualDays: annual.value, monthlyAccrualDays: monthly.value, carryForwardMode: carryMode.value,
    carryForwardLimit: carryLimit, encashmentAllowed: encash.value, encashmentLimitDays: encashLimit,
    insufficientBalance: insufficient.value, ...requestRules,
  });
}

// ── Allocation: days for one employee, one leave type, one academic year ────────
export interface AllocationInput {
  annualDays: number;
  creditModeOverride: CreditMode | null;
  carryForwardOverride: CarryForwardMode | null;
  carryForwardLimitOverride: number | null;
  /** Days credited each month for this employee, or null to follow the policy. */
  monthlyAccrualOverride: number | null;
  /** Encashment for this employee: true or false, or null to follow the policy. */
  encashmentOverride: boolean | null;
  encashmentLimitOverride: number | null;
}

export function validateAllocation(body: unknown): Result<AllocationInput> {
  if (!isRecord(body)) return fail('Send the allocation details');
  const annual = days(body.annualDays, 'Yearly days');
  if (!annual.ok) return annual;
  let creditMode: CreditMode | null = null;
  if (!blank(body.creditModeOverride)) {
    const c = oneOf(body.creditModeOverride, CREDIT_MODES, 'How leave is credited');
    if (!c.ok) return c;
    creditMode = c.value;
  }
  let carry: CarryForwardMode | null = null;
  let carryLimit: number | null = null;
  if (!blank(body.carryForwardOverride)) {
    const c = oneOf(body.carryForwardOverride, CARRY_MODES, 'Carry forward');
    if (!c.ok) return c;
    carry = c.value;
    if (carry === 'LIMIT') {
      if (blank(body.carryForwardLimitOverride)) return fail('Enter the most days that can be carried forward');
      const l = days(body.carryForwardLimitOverride, 'Carry-forward limit');
      if (!l.ok) return l;
      carryLimit = l.value;
    }
  }
  let monthly: number | null = null;
  if (!blank(body.monthlyAccrualOverride)) {
    const m = days(body.monthlyAccrualOverride, 'Days credited each month');
    if (!m.ok) return m;
    monthly = m.value;
  }
  let encash: boolean | null = null;
  let encashLimit: number | null = null;
  if (!blank(body.encashmentOverride)) {
    const e = flag(body.encashmentOverride, 'Encashment');
    if (!e.ok) return e;
    encash = e.value;
    if (encash && !blank(body.encashmentLimitOverride)) {
      const l = days(body.encashmentLimitOverride, 'Encashment limit');
      if (!l.ok) return l;
      encashLimit = l.value;
    }
  }
  return ok({
    annualDays: annual.value, creditModeOverride: creditMode, carryForwardOverride: carry, carryForwardLimitOverride: carryLimit,
    monthlyAccrualOverride: monthly, encashmentOverride: encash, encashmentLimitOverride: encashLimit,
  });
}

export interface BulkAllocationInput { annualDays: number; employeeIds: number[] | 'ALL'; overwrite: boolean }

export function validateBulkAllocation(body: unknown): Result<BulkAllocationInput> {
  if (!isRecord(body)) return fail('Send the details');
  const annual = days(body.annualDays, 'Yearly days');
  if (!annual.ok) return annual;
  let employeeIds: number[] | 'ALL';
  if (body.employeeIds === 'ALL') {
    employeeIds = 'ALL';
  } else if (Array.isArray(body.employeeIds) && body.employeeIds.length > 0 && body.employeeIds.length <= 2000
    && body.employeeIds.every(id => Number.isInteger(id) && id > 0)) {
    employeeIds = [...new Set(body.employeeIds as number[])];
  } else {
    return fail('Choose which employees to apply this to');
  }
  if (typeof body.overwrite !== 'boolean') return fail('Choose whether to replace existing allocations');
  return ok({ annualDays: annual.value, employeeIds, overwrite: body.overwrite });
}
