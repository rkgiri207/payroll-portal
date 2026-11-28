import type { Result } from '../attendance/adminValidation';
import { withTransaction, type PoolLike, type Queryable } from '../attendance/db';
import { isTwoDecimals, round2 } from './balance';

/**
 * Opening balances: what an employee already has when the app starts (for example on 1 December,
 * from your own records as at 30 November). Entered once per employee, leave type and academic year.
 * Every change goes to the ledger, so it can be audited and nothing is overwritten:
 *   - the first entry is an OPENING entry;
 *   - a later correction is an ADJUSTMENT for the difference, with the reason "Opening balance corrected".
 * An employee needs a joining date before an opening balance can be entered.
 */

export interface OpeningRow {
  employeeId: number; employeeCode: string; employeeName: string;
  joiningDate: string | null;
  /** The opening balance entered so far (the OPENING entry plus any corrections), or null if none. */
  opening: number | null;
}

export async function listOpening(q: Queryable, yearId: number, typeId: number, search: string | null): Promise<OpeningRow[]> {
  const { rows } = await q.query<{ id: number; employee_code: string; employee_name: string; joining_date: string | null; opening: number | null }>(
    `select e.id, e.employee_code, e.employee_name, to_char(e.joining_date, 'YYYY-MM-DD') as joining_date,
            (select sum(l.amount)::float8 from leave_ledger l
              where l.employee_id = e.id and l.leave_type_id = $2 and l.academic_year_id = $1
                and (l.entry_type = 'OPENING' or (l.entry_type = 'ADJUSTMENT' and l.reason like 'Opening balance%'))) as opening
       from employees e
      where e.status = 'ACTIVE'
        and ($3::text is null or e.employee_name ilike '%' || $3 || '%' or e.employee_code ilike '%' || $3 || '%')
      order by e.employee_name, e.id`,
    [yearId, typeId, search],
  );
  return rows.map(r => ({ employeeId: r.id, employeeCode: r.employee_code, employeeName: r.employee_name, joiningDate: r.joining_date, opening: r.opening }));
}

export interface OpeningEntry { employeeId: number; days: number }

export function validateOpeningEntries(body: unknown): Result<OpeningEntry[]> {
  const entries = typeof body === 'object' && body !== null ? (body as { entries?: unknown }).entries : undefined;
  if (!Array.isArray(entries) || entries.length === 0) return { ok: false, error: 'Enter at least one balance' };
  if (entries.length > 2000) return { ok: false, error: 'Too many employees in one go' };
  const out: OpeningEntry[] = [];
  const seen = new Set<number>();
  for (const e of entries) {
    const employeeId = (e as { employeeId?: unknown })?.employeeId;
    const raw = (e as { days?: unknown })?.days;
    const days = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
    if (typeof employeeId !== 'number' || !Number.isInteger(employeeId) || employeeId <= 0) return { ok: false, error: 'An employee is not valid' };
    if (seen.has(employeeId)) return { ok: false, error: 'An employee appears twice' };
    if (typeof days !== 'number' || !Number.isFinite(days) || days < 0 || days > 366 || !isTwoDecimals(days)) {
      return { ok: false, error: 'Days must be a number from 0 to 366 with at most 2 decimal places' };
    }
    seen.add(employeeId);
    out.push({ employeeId, days: round2(days) });
  }
  return { ok: true, value: out };
}

export type OpeningResult =
  | { ok: true; created: number; corrected: number; unchanged: number }
  | { ok: false; code: 'NOT_FOUND' | 'MISSING_JOINING_DATE'; message: string; employees?: { employeeId: number; employeeName: string }[] };

/**
 * Set opening balances. All or nothing: if any employee has no joining date (or is not active) nothing
 * is saved, and the screen is told who to fix.
 */
export async function setOpening(
  pool: PoolLike, input: { yearId: number; typeId: number; entries: OpeningEntry[]; userId: number | null },
): Promise<OpeningResult> {
  return withTransaction<OpeningResult>(pool, async q => {
    await q.query(`select pg_advisory_xact_lock(hashtextextended('leave-opening', 0))`);
    const y = await q.query<{ date: string }>(
      `select to_char(coalesce(accrual_from, start_date), 'YYYY-MM-DD') as date from academic_years where id = $1`, [input.yearId],
    );
    const t = await q.query<{ tracks_balance: boolean }>('select tracks_balance from leave_types where id = $1', [input.typeId]);
    if (!y.rows[0] || !t.rows[0]) return { ok: false, code: 'NOT_FOUND', message: 'Academic year or leave type not found' };
    if (!t.rows[0].tracks_balance) return { ok: false, code: 'NOT_FOUND', message: 'This leave type has no balance, so it has no opening balance' };

    const ids = input.entries.map(e => e.employeeId);
    const who = await q.query<{ id: number; employee_name: string; status: string; joined: boolean }>(
      `select id, employee_name, status, (joining_date is not null) as joined from employees where id = any($1::int[])`, [ids],
    );
    const known = new Map(who.rows.map(r => [r.id, r]));
    const unknown = ids.filter(id => !known.has(id) || known.get(id)!.status !== 'ACTIVE');
    if (unknown.length > 0) return { ok: false, code: 'NOT_FOUND', message: 'Some employees were not found or are not active' };
    const noDate = who.rows.filter(r => !r.joined);
    if (noDate.length > 0) {
      return {
        ok: false, code: 'MISSING_JOINING_DATE',
        message: 'A joining date is needed before an opening balance can be entered. Nothing was saved.',
        employees: noDate.map(r => ({ employeeId: r.id, employeeName: r.employee_name })),
      };
    }

    const effectiveDate = y.rows[0].date;
    const current = await q.query<{ employee_id: number; opening: number | null }>(
      `select employee_id, sum(amount)::float8 as opening from leave_ledger
        where leave_type_id = $2 and academic_year_id = $1 and employee_id = any($3::int[])
          and (entry_type = 'OPENING' or (entry_type = 'ADJUSTMENT' and reason like 'Opening balance%'))
        group by employee_id`,
      [input.yearId, input.typeId, ids],
    );
    const have = new Map(current.rows.map(r => [r.employee_id, r.opening ?? 0]));
    const hasOpeningEntry = new Set((await q.query<{ employee_id: number }>(
      `select employee_id from leave_ledger where leave_type_id = $2 and academic_year_id = $1 and entry_type = 'OPENING' and employee_id = any($3::int[])`,
      [input.yearId, input.typeId, ids])).rows.map(r => r.employee_id));

    let created = 0; let corrected = 0; let unchanged = 0;
    for (const e of input.entries) {
      const before = round2(have.get(e.employeeId) ?? 0);
      const difference = round2(e.days - before);
      if (difference === 0) { unchanged += 1; continue; }
      if (!hasOpeningEntry.has(e.employeeId) && difference > 0) {
        await q.query(
          `insert into leave_ledger (employee_id, leave_type_id, academic_year_id, entry_type, amount, effective_date, reason, created_by)
           values ($1, $2, $3, 'OPENING', $4, $5::date, 'Opening balance', $6)`,
          [e.employeeId, input.typeId, input.yearId, e.days, effectiveDate, input.userId],
        );
        created += 1;
      } else {
        await q.query(
          `insert into leave_ledger (employee_id, leave_type_id, academic_year_id, entry_type, amount, effective_date, reason, created_by)
           values ($1, $2, $3, 'ADJUSTMENT', $4, $5::date, $6, $7)`,
          [e.employeeId, input.typeId, input.yearId, difference, effectiveDate, `Opening balance corrected from ${before} to ${e.days}`, input.userId],
        );
        corrected += 1;
      }
    }
    return { ok: true, created, corrected, unchanged };
  });
}
