import { withTransaction, type PoolLike, type Queryable } from '../attendance/db';
import { splitPaidLop, type InsufficientBalance } from './balance';
import { niceDay } from './leaveEvaluate';
import { REQUEST_COLUMNS, toRequest, type LeaveRequestRecord } from './leaveRequestStore';

/**
 * The Director's decision on a leave request, and what follows from it.
 *
 *  - Approve: the paid days are deducted from the balance of THAT academic year, in the leave
 *    ledger, in the same transaction as the approval. The paid / without-pay split is fixed now,
 *    from the balance at this moment. Days beyond the balance are recorded as loss of pay only.
 *  - Reject: no balance is touched and the campus places are released.
 *  - Cancel: an employee may cancel their own pending request. Only the Director or an admin may
 *    cancel an approved one, which posts an auditable reversal of the deduction.
 *
 * Who is allowed to decide is checked by the caller (web: the Director's login; WhatsApp: the
 * Director's saved number) and checked again by the database for web decisions.
 */

export type DecidedVia = 'WEB' | 'WHATSAPP';

export type DecisionResult =
  | { status: 'DONE'; request: LeaveRequestRecord }
  | { status: 'NOT_FOUND' }
  /** Someone already decided it. Returned so a repeated tap can say so instead of failing. */
  | { status: 'ALREADY'; request: LeaveRequestRecord }
  | { status: 'REFUSED'; code: 'INSUFFICIENT_BALANCE' | 'NOT_ALLOWED' | 'INVALID_INPUT'; message: string };

const refused = (code: Extract<DecisionResult, { status: 'REFUSED' }>['code'], message: string): DecisionResult => ({ status: 'REFUSED', code, message });

async function lockRequest(q: Queryable, id: string): Promise<LeaveRequestRecord | null> {
  const { rows } = await q.query<Parameters<typeof toRequest>[0]>(`select ${REQUEST_COLUMNS} from leave_requests where id = $1 for update`, [id]);
  return rows[0] ? toRequest(rows[0]) : null;
}

/** Serialise everything that changes one employee's balance for one leave type and academic year. */
async function lockBalance(q: Queryable, r: LeaveRequestRecord): Promise<void> {
  await q.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [`leave-balance:${r.employeeId}:${r.leaveTypeId}:${r.academicYearId}`]);
}

async function currentBalance(q: Queryable, r: LeaveRequestRecord): Promise<number> {
  const { rows } = await q.query<{ balance: number }>(
    `select coalesce((select balance from leave_balances where employee_id = $1 and leave_type_id = $2 and academic_year_id = $3), 0)::float8 as balance`,
    [r.employeeId, r.leaveTypeId, r.academicYearId],
  );
  return rows[0]?.balance ?? 0;
}

async function typeAndRule(q: Queryable, r: LeaveRequestRecord): Promise<{ name: string; tracksBalance: boolean; rule: InsufficientBalance }> {
  const { rows } = await q.query<{ name: string; tracks_balance: boolean; insufficient_balance: InsufficientBalance | null }>(
    `select t.name, t.tracks_balance, p.insufficient_balance
       from leave_types t left join leave_policies p on p.leave_type_id = t.id and p.academic_year_id = $2
      where t.id = $1`,
    [r.leaveTypeId, r.academicYearId],
  );
  const row = rows[0];
  return { name: row?.name ?? 'Leave', tracksBalance: row?.tracks_balance ?? true, rule: row?.insufficient_balance ?? 'LOP' };
}

/** What approving would do right now, for the screen the Director sees before deciding. */
export async function suggestedSplit(q: Queryable, r: LeaveRequestRecord): Promise<{ ok: true; paidDays: number; lopDays: number; balance: number } | { ok: false; balance: number; message: string }> {
  const [balance, type] = await Promise.all([currentBalance(q, r), typeAndRule(q, r)]);
  const split = splitPaidLop({ requestedDays: r.totalDays, balance, tracksBalance: type.tracksBalance, insufficientBalance: type.rule });
  return split.ok
    ? { ok: true, paidDays: split.paidDays, lopDays: split.lopDays, balance }
    : { ok: false, balance, message: `Only ${split.availableDays} day${split.availableDays === 1 ? '' : 's'} of ${type.name} ${split.availableDays === 1 ? 'is' : 'are'} left, and the policy does not allow going beyond the balance.` };
}

export async function approveLeave(
  pool: PoolLike, input: { requestId: string; via: DecidedVia; userId: number | null },
): Promise<DecisionResult> {
  return withTransaction<DecisionResult>(pool, async q => {
    const request = await lockRequest(q, input.requestId);
    if (!request) return { status: 'NOT_FOUND' };
    if (request.status !== 'PENDING') return { status: 'ALREADY', request };

    await lockBalance(q, request);
    const split = await suggestedSplit(q, request);
    if (!split.ok) return refused('INSUFFICIENT_BALANCE', split.message);

    await q.query(
      `update leave_requests
          set status = 'APPROVED', decided_via = $2, decided_by_user_id = $3, decided_at = now(), paid_days = $4, lop_days = $5
        where id = $1`,
      [request.id, input.via, input.userId, split.paidDays, split.lopDays],
    );
    if (split.paidDays > 0) {
      await q.query(
        `insert into leave_ledger (employee_id, leave_type_id, academic_year_id, entry_type, amount, effective_date, request_id, created_by)
         values ($1, $2, $3, 'DEDUCTION', $4, $5::date, $6, $7)`,
        [request.employeeId, request.leaveTypeId, request.academicYearId, -split.paidDays, request.startDate, request.id, input.userId],
      );
    }
    const done = await lockRequest(q, request.id);
    return { status: 'DONE', request: done! };
  });
}

export async function rejectLeave(
  pool: PoolLike, input: { requestId: string; via: DecidedVia; userId: number | null; note: unknown },
): Promise<DecisionResult> {
  const note = typeof input.note === 'string' ? input.note.trim().replace(/\s+/g, ' ') : '';
  if (note === '') return refused('INVALID_INPUT', 'Please give a reason for rejecting.');
  if (note.length > 500) return refused('INVALID_INPUT', 'The reason must be at most 500 characters.');
  return withTransaction<DecisionResult>(pool, async q => {
    const request = await lockRequest(q, input.requestId);
    if (!request) return { status: 'NOT_FOUND' };
    if (request.status !== 'PENDING') return { status: 'ALREADY', request };
    await q.query(
      `update leave_requests set status = 'REJECTED', decided_via = $2, decided_by_user_id = $3, decided_at = now(), decision_note = $4 where id = $1`,
      [request.id, input.via, input.userId, note],
    );
    return { status: 'DONE', request: (await lockRequest(q, request.id))! };
  });
}

export type Canceller = { by: 'EMPLOYEE'; employeeId: number } | { by: 'DIRECTOR' | 'ADMIN' };

export async function cancelLeave(
  pool: PoolLike, input: { requestId: string; canceller: Canceller; reason: unknown; today: string },
): Promise<DecisionResult> {
  const reason = typeof input.reason === 'string' ? input.reason.trim().replace(/\s+/g, ' ') : '';
  if (reason.length > 500) return refused('INVALID_INPUT', 'The reason must be at most 500 characters.');
  return withTransaction<DecisionResult>(pool, async q => {
    const request = await lockRequest(q, input.requestId);
    if (!request) return { status: 'NOT_FOUND' };
    if (input.canceller.by === 'EMPLOYEE' && input.canceller.employeeId !== request.employeeId) return { status: 'NOT_FOUND' };
    if (request.status === 'CANCELLED') return { status: 'ALREADY', request };
    if (request.status === 'REJECTED') return refused('NOT_ALLOWED', 'A rejected request does not need cancelling.');
    if (request.status === 'APPROVED' && input.canceller.by === 'EMPLOYEE') {
      return refused('NOT_ALLOWED', 'This leave is already approved. Please contact the school administration to cancel it.');
    }
    if (request.status === 'APPROVED' && reason === '') return refused('INVALID_INPUT', 'Please give a reason for cancelling approved leave.');

    if (request.status === 'APPROVED') {
      await lockBalance(q, request);
      // Reverse exactly what was deducted, once. The ledger's unique index also guards against a second reversal.
      const { rows } = await q.query<{ amount: number }>(
        `select (-amount)::float8 as amount from leave_ledger where request_id = $1 and entry_type = 'DEDUCTION'`, [request.id],
      );
      if (rows[0] && rows[0].amount > 0) {
        await q.query(
          `insert into leave_ledger (employee_id, leave_type_id, academic_year_id, entry_type, amount, effective_date, request_id, reason)
           values ($1, $2, $3, 'REVERSAL', $4, $5::date, $6, $7)`,
          [request.employeeId, request.leaveTypeId, request.academicYearId, rows[0].amount, input.today, request.id,
            `Cancelled by ${input.canceller.by.toLowerCase()}: ${reason}`],
        );
      }
    }
    await q.query(
      `update leave_requests set status = 'CANCELLED', cancelled_at = now(), cancelled_by = $2, cancel_reason = $3 where id = $1`,
      [request.id, input.canceller.by, reason === '' ? null : reason],
    );
    return { status: 'DONE', request: (await lockRequest(q, request.id))! };
  });
}

/** Plain wording of a decision for the employee. The same text is used on WhatsApp and the screen. */
export function decisionText(r: LeaveRequestRecord, typeName: string): string {
  const range = r.startDate === r.endDate ? niceDay(r.startDate) : `${niceDay(r.startDate)} to ${niceDay(r.endDate)}`;
  const days = `${r.totalDays} day${r.totalDays === 1 ? '' : 's'}`;
  if (r.status === 'APPROVED') {
    const lop = r.lopDays <= 0 ? ''
      : r.lopDays >= r.totalDays ? (r.totalDays === 1 ? ' This day is without pay.' : ' All of these days are without pay.')
        : ` ${r.lopDays} of these ${r.totalDays} days ${r.lopDays === 1 ? 'is' : 'are'} without pay.`;
    return `Your ${typeName} request for ${range} (${days}) has been approved.${lop}`;
  }
  if (r.status === 'REJECTED') {
    return `Your ${typeName} request for ${range} was not approved.${r.decisionNote ? ` Reason: ${r.decisionNote}` : ''}`;
  }
  return `Your ${typeName} request for ${range} has been cancelled.`;
}
