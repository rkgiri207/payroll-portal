/**
 * Paid / LOP split for a leave request. Pure, no database access.
 * A request is counted in steps of 0.5 day. A balance (and so the paid and without-pay parts) may use
 * two decimal places, for example 1.25 days credited each month. LOP is never decided here on its
 * own: a request with an LOP part still needs the Director's approval like every request.
 */

export type InsufficientBalance = 'REJECT' | 'LOP' | 'NEGATIVE';

export interface SplitInput {
  requestedDays: number;
  balance: number;               // current ledger balance (may be negative)
  tracksBalance: boolean;        // false for unpaid leave
  insufficientBalance: InsufficientBalance;
}

export type SplitResult =
  | { ok: true; paidDays: number; lopDays: number }
  | { ok: false; reason: 'INSUFFICIENT_BALANCE'; availableDays: number };

/** A request length: a positive multiple of 0.5. */
export function isHalfStep(value: number): boolean {
  return Number.isFinite(value) && Math.round(value * 2) === value * 2;
}

/** Days with at most two decimal places (balances, credits and limits). */
export function isTwoDecimals(value: number): boolean {
  return Number.isFinite(value) && Math.abs(value * 100 - Math.round(value * 100)) < 1e-6;
}

/** Round to two decimals, so 1.1 - 0.8 is 0.3 and not 0.30000000000000004. */
export const round2 = (value: number): number => Math.round(value * 100) / 100;

export function splitPaidLop(input: SplitInput): SplitResult {
  const { requestedDays, balance, tracksBalance, insufficientBalance } = input;
  if (!isHalfStep(requestedDays) || requestedDays <= 0) throw new Error('Requested days must be a positive multiple of 0.5');
  if (!isTwoDecimals(balance)) throw new Error('Balance must have at most two decimal places');
  if (!tracksBalance) return { ok: true, paidDays: 0, lopDays: requestedDays };

  const available = round2(Math.max(balance, 0));
  if (requestedDays <= available) return { ok: true, paidDays: requestedDays, lopDays: 0 };

  switch (insufficientBalance) {
    case 'REJECT':
      return { ok: false, reason: 'INSUFFICIENT_BALANCE', availableDays: available };
    case 'NEGATIVE':
      return { ok: true, paidDays: requestedDays, lopDays: 0 };
    case 'LOP':
      return { ok: true, paidDays: available, lopDays: round2(requestedDays - available) };
  }
}
