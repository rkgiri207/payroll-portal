import { randomUUID } from 'node:crypto';
import { pgCode, PG_UNIQUE_VIOLATION } from '../attendance/adminAccess';
import { withTransaction, type PoolLike } from '../attendance/db';
import { cleanReason, evaluateLeave, niceDay, type DayMode, type EvalResult, type LeavePlan } from './leaveEvaluate';
import { loadLeaveFacts } from './leaveLoader';
import {
  findFullDates, findRequestByKey, getLeaveCap, insertAutoRejectedRequest, insertPendingRequest,
  type LeaveRequestRecord, type NewRequest,
} from './leaveRequestStore';

/**
 * Submitting leave. The rules live in leaveEvaluate (pure). This file loads the facts, saves the
 * request, and handles the one thing only the database can decide: whether a date is already full.
 *
 * A request that hits a full date is rejected as a whole, kept for audit as REJECTED by SYSTEM
 * (it never counts towards the limit) and is NOT forwarded to the Director.
 * Nothing here approves leave or touches a balance: the Director's decision does that, later.
 */

export interface SubmitInput {
  employeeId: number; leaveTypeId: number; startDate: string; endDate: string; dayMode: DayMode; reason: unknown;
  submittedVia: 'WHATSAPP_LINK' | 'MANUAL'; enteredByUserId: number | null;
  /** The same key always gives the same outcome, so a double tap or retry cannot create two requests. */
  idempotencyKey?: string;
  /** IST date today. */
  today: string;
}

export type SubmitResult =
  | { status: 'SUBMITTED' | 'DUPLICATE'; request: LeaveRequestRecord; plan?: LeavePlan }
  | { status: 'CAP_REACHED'; request: LeaveRequestRecord; fullDates: string[]; cap: number }
  | { status: 'REFUSED'; code: Extract<EvalResult, { ok: false }>['code'] | 'EMPLOYEE_NOT_FOUND' | 'TYPE_NOT_FOUND' | 'EMPLOYEE_INACTIVE'; message: string; dates?: string[]; availableDays?: number };

const refuse = (code: Extract<SubmitResult, { status: 'REFUSED' }>['code'], message: string, extra: { dates?: string[]; availableDays?: number } = {}): SubmitResult =>
  ({ status: 'REFUSED', code, message, ...extra });

export type PreviewResult =
  | { ok: true; plan: LeavePlan; yearLabel: string; leaveType: string; availableBalance: number }
  | { ok: false; code: Extract<SubmitResult, { status: 'REFUSED' }>['code']; message: string; dates?: string[]; availableDays?: number };

/** What a request would cost, without saving anything. The employee form shows this before they send. */
export async function previewLeave(
  pool: PoolLike, input: Pick<SubmitInput, 'employeeId' | 'leaveTypeId' | 'startDate' | 'endDate' | 'dayMode' | 'today'> & { byAdmin: boolean },
): Promise<PreviewResult> {
  const facts = await loadLeaveFacts(pool, input.employeeId, input.leaveTypeId, input.startDate, input.endDate);
  if ('error' in facts) return { ok: false, code: facts.error, message: facts.error === 'EMPLOYEE_NOT_FOUND' ? 'Employee not found' : 'Leave type not found' };
  if (!facts.employee.active) return { ok: false, code: 'EMPLOYEE_INACTIVE', message: 'This employee is not active.' };
  const result = evaluateLeave(facts.context, { ...input });
  if (!result.ok) return result;
  return { ok: true, plan: result.plan, yearLabel: facts.context.year!.label, leaveType: facts.type.name, availableBalance: facts.context.availableBalance };
}

export async function submitLeaveRequest(pool: PoolLike, input: SubmitInput): Promise<SubmitResult> {
  const key = input.idempotencyKey ?? `leave:${randomUUID()}`;

  // A repeat of a request we already handled returns that same outcome.
  const earlier = await findRequestByKey(pool, key);
  if (earlier) return { status: 'DUPLICATE', request: earlier };

  const reason = cleanReason(input.reason);
  if (!reason.ok) return refuse('INVALID_INPUT', reason.message);

  const facts = await loadLeaveFacts(pool, input.employeeId, input.leaveTypeId, input.startDate, input.endDate);
  if ('error' in facts) return refuse(facts.error, facts.error === 'EMPLOYEE_NOT_FOUND' ? 'Employee not found' : 'Leave type not found');
  if (!facts.employee.active) return refuse('EMPLOYEE_INACTIVE', 'This employee is not active.');

  const evaluated = evaluateLeave(facts.context, {
    startDate: input.startDate, endDate: input.endDate, dayMode: input.dayMode, today: input.today, byAdmin: input.submittedVia === 'MANUAL',
  });
  if (!evaluated.ok) return refuse(evaluated.code, evaluated.message, { dates: evaluated.dates, availableDays: evaluated.availableDays });
  const { plan } = evaluated;

  const request: NewRequest = {
    employeeId: input.employeeId, leaveTypeId: input.leaveTypeId, academicYearId: facts.yearId!, startDate: input.startDate,
    endDate: input.endDate, dayMode: input.dayMode, reason: reason.value, plan, submittedVia: input.submittedVia,
    enteredByUserId: input.enteredByUserId, idempotencyKey: key,
  };

  try {
    await withTransaction(pool, q => insertPendingRequest(q, request));
    const saved = await findRequestByKey(pool, key);
    return { status: 'SUBMITTED', request: saved!, plan };
  } catch (error) {
    const code = pgCode(error);
    if (code === 'LC001') return capReached(pool, request, plan);
    if (code === PG_UNIQUE_VIOLATION) {
      const constraint = (error as { constraint?: string }).constraint ?? '';
      // The same key arrived twice at the same moment: report the request the first one created.
      const winner = await findRequestByKey(pool, key);
      if (winner) return { status: 'DUPLICATE', request: winner };
      if (constraint.includes('employee_date')) return refuse('OVERLAP', 'You already have leave on some of these dates.');
    }
    throw error;
  }
}

/** The database said a date is full. Keep an audit record, and tell the caller which dates to avoid. */
async function capReached(pool: PoolLike, request: NewRequest, plan: LeavePlan): Promise<SubmitResult> {
  const cap = await getLeaveCap(pool);
  const fullDates = await findFullDates(pool, plan.days.map(d => ({ campusId: d.campusId, date: d.date })), cap);
  const note = `Campus limit of ${cap} reached on ${fullDates.length > 0 ? fullDates.join(', ') : 'a requested date'}`;
  await withTransaction(pool, q => insertAutoRejectedRequest(q, request, note));
  const saved = await findRequestByKey(pool, request.idempotencyKey);
  return { status: 'CAP_REACHED', request: saved!, fullDates, cap };
}

/** The message the employee receives when a date is full. The number is the configured limit, not a fixed two. */
export function capReachedText(cap: number, fullDates: string[]): string {
  const people = cap === 1 ? 'one employee' : `${numberWord(cap)} employees`;
  const dates = fullDates.length > 0 ? `\n\nFull on: ${fullDates.map(niceDay).join(', ')}.` : '';
  return (
    `Sorry, leave applications for this date have reached the maximum permitted limit of ${people} for your campus.${dates}\n\n` +
    'Your leave application has not been forwarded to the Director.\n\n' +
    'Please select another date or contact the school administration.'
  );
}

const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
const numberWord = (n: number) => WORDS[n] ?? String(n);
