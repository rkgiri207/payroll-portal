import { writeAudit } from '../attendance/auditStore';
import { withTransaction, type PoolLike, type Queryable } from '../attendance/db';
import { ACCRUAL_PREFIX, planAccrual, type CreditMode, type PlannedEntry } from './accrual';

/**
 * The accrual job. It credits what each active employee has earned, per the policy of the academic
 * year that is running today. Safe to run any number of times: it only ever posts what is missing,
 * never twice (the database allows one credit per employee, leave type and month), and a lock stops
 * two runs from overlapping. A preview ("dry run") shows exactly what would be posted, posting nothing.
 */

export interface AccrualLine {
  employeeId: number; employeeCode: string; employeeName: string; leaveType: string; entries: PlannedEntry[];
}

export interface AccrualSummary {
  today: string;
  year: { id: number; label: string; accrualFrom: string | null } | null;
  dryRun: boolean;
  employeesConsidered: number;
  creditsPosted: number;
  adjustmentsPosted: number;
  daysPosted: number;
  /** Active employees with no joining date. They earn nothing until one is entered. */
  missingJoiningDate: { employeeId: number; employeeCode: string; employeeName: string }[];
  lines: AccrualLine[];
  /** True when lines was cut short to keep the reply small. */
  truncated: boolean;
}

const MAX_LINES = 500;
const empty = (today: string, dryRun: boolean): AccrualSummary => ({
  today, year: null, dryRun, employeesConsidered: 0, creditsPosted: 0, adjustmentsPosted: 0, daysPosted: 0, missingJoiningDate: [], lines: [], truncated: false,
});

interface Basis {
  year: { id: number; label: string; startDate: string; endDate: string; accrualFrom: string | null };
  policies: { typeId: number; typeName: string; mode: CreditMode; yearly: number; monthly: number }[];
  employees: { id: number; code: string; name: string; joiningDate: string | null }[];
  allocations: Map<string, { yearly: number; mode: CreditMode | null; monthly: number | null }>;
  ledger: Map<string, { months: string[]; posted: number }>;
}

const key = (employeeId: number, typeId: number) => `${employeeId}:${typeId}`;

async function loadBasis(q: Queryable, today: string): Promise<Basis | null> {
  const y = await q.query<{ id: number; label: string; start_date: string; end_date: string; accrual_from: string | null }>(
    `select id, label, to_char(start_date, 'YYYY-MM-DD') as start_date, to_char(end_date, 'YYYY-MM-DD') as end_date,
            to_char(accrual_from, 'YYYY-MM-DD') as accrual_from
       from academic_years where $1::date between start_date and end_date`,
    [today],
  );
  const year = y.rows[0];
  if (!year) return null;

  const p = await q.query<{ type_id: number; name: string; credit_mode: CreditMode; yearly: number; monthly: number }>(
    `select t.id as type_id, t.name, p.credit_mode, p.default_annual_days::float8 as yearly, p.monthly_accrual_days::float8 as monthly
       from leave_types t join leave_policies p on p.leave_type_id = t.id and p.academic_year_id = $1
      where t.is_active and t.tracks_balance order by t.sort_order, t.id`,
    [year.id],
  );
  const e = await q.query<{ id: number; employee_code: string; employee_name: string; joining_date: string | null }>(
    `select id, employee_code, employee_name, to_char(joining_date, 'YYYY-MM-DD') as joining_date
       from employees where status = 'ACTIVE' order by employee_name, id`,
  );
  const a = await q.query<{ employee_id: number; leave_type_id: number; yearly: number; mode: CreditMode | null; monthly: number | null }>(
    `select employee_id, leave_type_id, annual_days::float8 as yearly, credit_mode_override as mode, monthly_accrual_override::float8 as monthly
       from leave_allocations where academic_year_id = $1`,
    [year.id],
  );
  const l = await q.query<{ employee_id: number; leave_type_id: number; months: string[] | null; posted: number }>(
    `select employee_id, leave_type_id,
            array_agg(period) filter (where entry_type = 'CREDIT' and period is not null) as months,
            coalesce(sum(amount) filter (where (entry_type = 'CREDIT' and period is not null)
                                            or (entry_type = 'ADJUSTMENT' and reason like $2)), 0)::float8 as posted
       from leave_ledger where academic_year_id = $1 group by employee_id, leave_type_id`,
    [year.id, `${ACCRUAL_PREFIX}%`],
  );
  return {
    year: { id: year.id, label: year.label, startDate: year.start_date, endDate: year.end_date, accrualFrom: year.accrual_from },
    policies: p.rows.map(r => ({ typeId: r.type_id, typeName: r.name, mode: r.credit_mode, yearly: r.yearly, monthly: r.monthly })),
    employees: e.rows.map(r => ({ id: r.id, code: r.employee_code, name: r.employee_name, joiningDate: r.joining_date })),
    allocations: new Map(a.rows.map(r => [key(r.employee_id, r.leave_type_id), { yearly: r.yearly, mode: r.mode, monthly: r.monthly }])),
    ledger: new Map(l.rows.map(r => [key(r.employee_id, r.leave_type_id), { months: r.months ?? [], posted: r.posted }])),
  };
}

async function post(q: Queryable, line: { employeeId: number; typeId: number; yearId: number; entry: PlannedEntry; userId: number | null }): Promise<boolean> {
  const { rowCount } = await q.query(
    `insert into leave_ledger (employee_id, leave_type_id, academic_year_id, entry_type, amount, effective_date, period, reason, created_by)
     values ($1, $2, $3, $4, $5, $6::date, $7, $8, $9) on conflict do nothing`,
    [line.employeeId, line.typeId, line.yearId, line.entry.entryType, line.entry.amount, line.entry.effectiveDate, line.entry.period, line.entry.reason, line.userId],
  );
  return (rowCount ?? 0) > 0;
}

export async function runAccrual(
  pool: PoolLike, input: { today: string; dryRun: boolean; userId: number | null },
): Promise<AccrualSummary> {
  return withTransaction(pool, async q => {
    await q.query(`select pg_advisory_xact_lock(hashtextextended('leave-accrual', 0))`);
    const basis = await loadBasis(q, input.today);
    const summary = empty(input.today, input.dryRun);
    if (!basis) return summary;
    summary.year = { id: basis.year.id, label: basis.year.label, accrualFrom: basis.year.accrualFrom };

    const missing = new Map<number, { employeeId: number; employeeCode: string; employeeName: string }>();
    for (const employee of basis.employees) {
      let considered = false;
      for (const policy of basis.policies) {
        if (policy.mode === 'MANUAL' && !basis.allocations.get(key(employee.id, policy.typeId))?.mode) continue;
        const alloc = basis.allocations.get(key(employee.id, policy.typeId));
        const mode = alloc?.mode ?? policy.mode;
        if (mode === 'MANUAL') continue;
        const ledger = basis.ledger.get(key(employee.id, policy.typeId));
        const plan = planAccrual({
          today: input.today, year: basis.year, joiningDate: employee.joiningDate, mode,
          monthlyDays: alloc?.monthly ?? policy.monthly, yearlyDays: alloc?.yearly ?? policy.yearly,
          creditedMonths: ledger?.months ?? [], postedTotal: ledger?.posted ?? 0,
        });
        if (plan.skipped === 'NO_JOINING_DATE') {
          missing.set(employee.id, { employeeId: employee.id, employeeCode: employee.code, employeeName: employee.name });
          continue;
        }
        considered = true;
        if (plan.entries.length === 0) continue;
        if (summary.lines.length < MAX_LINES) summary.lines.push({ employeeId: employee.id, employeeCode: employee.code, employeeName: employee.name, leaveType: policy.typeName, entries: plan.entries });
        else summary.truncated = true;
        for (const entry of plan.entries) {
          const posted = input.dryRun ? true : await post(q, { employeeId: employee.id, typeId: policy.typeId, yearId: basis.year.id, entry, userId: input.userId });
          if (!posted) continue;                                   // someone else already posted this month
          if (entry.entryType === 'CREDIT') summary.creditsPosted += 1; else summary.adjustmentsPosted += 1;
          summary.daysPosted = Math.round((summary.daysPosted + entry.amount) * 100) / 100;
        }
      }
      if (considered) summary.employeesConsidered += 1;
    }
    summary.missingJoiningDate = [...missing.values()];

    if (!input.dryRun && (summary.creditsPosted > 0 || summary.adjustmentsPosted > 0)) {
      await writeAudit(q, {
        actorType: input.userId === null ? 'SYSTEM' : 'USER', actorUserId: input.userId, action: 'LEAVE_ACCRUAL_RUN',
        entityType: 'academic_year', entityId: String(basis.year.id),
        newValue: { today: input.today, credits: summary.creditsPosted, adjustments: summary.adjustmentsPosted, days: summary.daysPosted, employees: summary.employeesConsidered },
      });
    }
    return summary;
  });
}

const MARKER = 'leave_accrual_last_run';

/** Run the job once per IST day (the scheduled sweeper calls this often; it does the work only once a day). */
export async function runAccrualOncePerDay(pool: PoolLike, today: string): Promise<AccrualSummary | null> {
  const { rows } = await pool.query<{ value: unknown }>('select value from attendance_settings where key = $1', [MARKER]);
  if (rows[0]?.value === today) return null;
  const summary = await runAccrual(pool, { today, dryRun: false, userId: null });
  await pool.query(
    `insert into attendance_settings (key, value, description) values ($1, to_jsonb($2::text), 'Bookkeeping: the last day the monthly leave accrual ran')
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [MARKER, today],
  );
  return summary;
}
