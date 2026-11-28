import { pgCode, PG_FOREIGN_KEY_VIOLATION, PG_UNIQUE_VIOLATION } from '../attendance/adminAccess';
import type { Queryable } from '../attendance/db';
import type {
  AllocationInput, BulkAllocationInput, CarryForwardMode, CreditMode, InsufficientBalance, LeaveTypeChanges,
  LeaveTypeInput, PolicyInput,
} from './policyValidation';

type Outcome<T> = { ok: true; value: T } | { ok: false; error: string; status: number };
const notFound = (what: string): Outcome<never> => ({ ok: false, status: 404, error: `${what} not found` });

// ── Leave types ───────────────────────────────────────────────────────────────
export interface LeaveTypeView {
  id: number; code: string; name: string; isPaid: boolean; tracksBalance: boolean; isActive: boolean; sortOrder: number;
}
interface TypeRow { id: number; code: string; name: string; is_paid: boolean; tracks_balance: boolean; is_active: boolean; sort_order: number }
const toType = (r: TypeRow): LeaveTypeView => ({
  id: r.id, code: r.code, name: r.name, isPaid: r.is_paid, tracksBalance: r.tracks_balance, isActive: r.is_active, sortOrder: r.sort_order,
});
const TYPE_COLUMNS = 'id, code, name, is_paid, tracks_balance, is_active, sort_order';

export async function listLeaveTypes(q: Queryable): Promise<LeaveTypeView[]> {
  const { rows } = await q.query<TypeRow>(`select ${TYPE_COLUMNS} from leave_types order by sort_order, id`);
  return rows.map(toType);
}

export async function getLeaveType(q: Queryable, id: number): Promise<LeaveTypeView | null> {
  const { rows } = await q.query<TypeRow>(`select ${TYPE_COLUMNS} from leave_types where id = $1`, [id]);
  return rows[0] ? toType(rows[0]) : null;
}

export async function createLeaveType(q: Queryable, input: LeaveTypeInput): Promise<Outcome<LeaveTypeView>> {
  try {
    const { rows } = await q.query<TypeRow>(
      `insert into leave_types (code, name, is_paid, tracks_balance, sort_order)
       values ($1, $2, $3, $4, (select coalesce(max(sort_order), 0) + 1 from leave_types))
       returning ${TYPE_COLUMNS}`,
      [input.code, input.name, input.isPaid, input.tracksBalance],
    );
    return { ok: true, value: toType(rows[0]) };
  } catch (error) {
    if (pgCode(error) === PG_UNIQUE_VIOLATION) return { ok: false, status: 409, error: 'A leave type with this code already exists' };
    throw error;
  }
}

/** True once any leave request or ledger entry uses the type; its pay and balance behaviour is then fixed. */
async function typeInUse(q: Queryable, id: number): Promise<boolean> {
  const { rows } = await q.query<{ used: boolean }>(
    `select (exists (select 1 from leave_requests where leave_type_id = $1)
          or exists (select 1 from leave_ledger where leave_type_id = $1)) as used`,
    [id],
  );
  return rows[0]?.used ?? false;
}

export async function updateLeaveType(
  q: Queryable, id: number, changes: LeaveTypeChanges,
): Promise<Outcome<{ before: LeaveTypeView; after: LeaveTypeView }>> {
  const before = await getLeaveType(q, id);
  if (!before) return notFound('Leave type');
  const changesBehaviour = (changes.isPaid !== undefined && changes.isPaid !== before.isPaid)
    || (changes.tracksBalance !== undefined && changes.tracksBalance !== before.tracksBalance);
  if (changesBehaviour && (await typeInUse(q, id))) {
    return {
      ok: false, status: 409,
      error: 'This leave type is already used by requests or balances, so whether it is paid or tracks a balance can no longer change. Add a new leave type instead.',
    };
  }
  const next = { ...before, ...changes };
  await q.query(
    'update leave_types set name = $2, is_paid = $3, tracks_balance = $4, is_active = $5, sort_order = $6 where id = $1',
    [id, next.name, next.isPaid, next.tracksBalance, next.isActive, next.sortOrder],
  );
  return { ok: true, value: { before, after: next } };
}

// ── Policies ──────────────────────────────────────────────────────────────────
export interface PolicyView extends PolicyInput { updatedAt: string | null }
export interface PolicyRow {
  type: LeaveTypeView;
  /** null until a policy has been saved for this type and year. */
  policy: PolicyView | null;
}

interface PolicyDb {
  credit_mode: CreditMode; default_annual_days: string; monthly_accrual_days: string; carry_forward_mode: CarryForwardMode;
  carry_forward_limit: string | null; encashment_allowed: boolean; encashment_limit_days: string | null;
  insufficient_balance: InsufficientBalance; allow_half_day: boolean; min_notice_days: number;
  max_consecutive_days: number | null; updated_at: string;
}
const num = (v: string | null): number | null => (v === null ? null : Number(v));
const toPolicy = (r: PolicyDb): PolicyView => ({
  creditMode: r.credit_mode, defaultAnnualDays: Number(r.default_annual_days), monthlyAccrualDays: Number(r.monthly_accrual_days), carryForwardMode: r.carry_forward_mode,
  carryForwardLimit: num(r.carry_forward_limit), encashmentAllowed: r.encashment_allowed,
  encashmentLimitDays: num(r.encashment_limit_days), insufficientBalance: r.insufficient_balance,
  allowHalfDay: r.allow_half_day, minNoticeDays: r.min_notice_days, maxConsecutiveDays: r.max_consecutive_days,
  updatedAt: r.updated_at,
});

export async function listPolicies(q: Queryable, yearId: number): Promise<PolicyRow[]> {
  const { rows } = await q.query<TypeRow & Partial<PolicyDb> & { has_policy: boolean }>(
    `select t.id, t.code, t.name, t.is_paid, t.tracks_balance, t.is_active, t.sort_order,
            (p.id is not null) as has_policy, p.credit_mode, p.default_annual_days::text, p.monthly_accrual_days::text, p.carry_forward_mode,
            p.carry_forward_limit::text, p.encashment_allowed, p.encashment_limit_days::text,
            p.insufficient_balance, p.allow_half_day, p.min_notice_days, p.max_consecutive_days, p.updated_at::text
       from leave_types t
       left join leave_policies p on p.leave_type_id = t.id and p.academic_year_id = $1
      order by t.sort_order, t.id`,
    [yearId],
  );
  return rows.map(r => ({ type: toType(r), policy: r.has_policy ? toPolicy(r as unknown as PolicyDb) : null }));
}

export async function upsertPolicy(
  q: Queryable, yearId: number, typeId: number, input: PolicyInput, userId: number | null,
): Promise<Outcome<PolicyView>> {
  try {
    const { rows } = await q.query<PolicyDb>(
      `insert into leave_policies
         (leave_type_id, academic_year_id, credit_mode, default_annual_days, monthly_accrual_days, carry_forward_mode, carry_forward_limit,
          encashment_allowed, encashment_limit_days, insufficient_balance, allow_half_day, min_notice_days,
          max_consecutive_days, updated_by)
       values ($1, $2, $3, $4, $14, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       on conflict (leave_type_id, academic_year_id) do update set
         credit_mode = excluded.credit_mode, default_annual_days = excluded.default_annual_days,
         monthly_accrual_days = excluded.monthly_accrual_days,
         carry_forward_mode = excluded.carry_forward_mode, carry_forward_limit = excluded.carry_forward_limit,
         encashment_allowed = excluded.encashment_allowed, encashment_limit_days = excluded.encashment_limit_days,
         insufficient_balance = excluded.insufficient_balance, allow_half_day = excluded.allow_half_day,
         min_notice_days = excluded.min_notice_days, max_consecutive_days = excluded.max_consecutive_days,
         updated_at = now(), updated_by = excluded.updated_by
       returning credit_mode, default_annual_days::text, monthly_accrual_days::text, carry_forward_mode, carry_forward_limit::text, encashment_allowed,
                 encashment_limit_days::text, insufficient_balance, allow_half_day, min_notice_days, max_consecutive_days,
                 updated_at::text`,
      [
        typeId, yearId, input.creditMode, input.defaultAnnualDays, input.carryForwardMode, input.carryForwardLimit,
        input.encashmentAllowed, input.encashmentLimitDays, input.insufficientBalance, input.allowHalfDay,
        input.minNoticeDays, input.maxConsecutiveDays, userId, input.monthlyAccrualDays ?? 0,
      ],
    );
    return { ok: true, value: toPolicy(rows[0]) };
  } catch (error) {
    if (pgCode(error) === PG_FOREIGN_KEY_VIOLATION) return notFound('Leave type or academic year');
    throw error;
  }
}

/** Copy every policy of one year into another, leaving any policy the target year already has. */
export async function copyPolicies(q: Queryable, fromYearId: number, toYearId: number, userId: number | null): Promise<number> {
  const { rowCount } = await q.query(
    `insert into leave_policies
       (leave_type_id, academic_year_id, credit_mode, default_annual_days, monthly_accrual_days, carry_forward_mode, carry_forward_limit,
        encashment_allowed, encashment_limit_days, insufficient_balance, allow_half_day, min_notice_days,
        max_consecutive_days, updated_by)
     select leave_type_id, $2, credit_mode, default_annual_days, monthly_accrual_days, carry_forward_mode, carry_forward_limit,
            encashment_allowed, encashment_limit_days, insufficient_balance, allow_half_day, min_notice_days,
            max_consecutive_days, $3
       from leave_policies where academic_year_id = $1
     on conflict (leave_type_id, academic_year_id) do nothing`,
    [fromYearId, toYearId, userId],
  );
  return rowCount ?? 0;
}

// ── Allocations ───────────────────────────────────────────────────────────────
export interface AllocationRow {
  employeeId: number; employeeCode: string; employeeName: string; designation: string | null;
  /** null when the employee has no allocation of their own and follows the policy default. */
  annualDays: number | null;
  creditModeOverride: CreditMode | null; carryForwardOverride: CarryForwardMode | null; carryForwardLimitOverride: number | null;
  monthlyAccrualOverride: number | null; encashmentOverride: boolean | null; encashmentLimitOverride: number | null;
  /** What actually applies: the employee's own allocation, else the policy's default. */
  effectiveDays: number;
  /** What actually applies to this employee: their own setting, else the policy's. */
  effectiveMode: CreditMode | null;
  effectiveMonthlyDays: number;
}

export async function listAllocations(
  q: Queryable, yearId: number, typeId: number, search: string | null,
): Promise<AllocationRow[]> {
  const { rows } = await q.query<{
    id: number; employee_code: string; employee_name: string; designation: string | null;
    annual_days: string | null; credit_mode_override: CreditMode | null; carry_forward_override: CarryForwardMode | null;
    carry_forward_limit_override: string | null; policy_days: string | null;
    monthly_accrual_override: string | null; encashment_override: boolean | null; encashment_limit_override: string | null;
    policy_mode: CreditMode | null; policy_monthly: string | null;
  }>(
    `select e.id, e.employee_code, e.employee_name, e.designation,
            a.annual_days::text, a.credit_mode_override, a.carry_forward_override,
            a.carry_forward_limit_override::text, p.default_annual_days::text as policy_days,
            a.monthly_accrual_override::text, a.encashment_override, a.encashment_limit_override::text,
            p.credit_mode as policy_mode, p.monthly_accrual_days::text as policy_monthly
       from employees e
       left join leave_allocations a on a.employee_id = e.id and a.leave_type_id = $2 and a.academic_year_id = $1
       left join leave_policies p on p.leave_type_id = $2 and p.academic_year_id = $1
      where e.status = 'ACTIVE'
        and ($3::text is null or e.employee_name ilike '%' || $3 || '%' or e.employee_code ilike '%' || $3 || '%')
      order by e.employee_name, e.id`,
    [yearId, typeId, search],
  );
  return rows.map(r => ({
    employeeId: r.id, employeeCode: r.employee_code, employeeName: r.employee_name, designation: r.designation,
    annualDays: num(r.annual_days), creditModeOverride: r.credit_mode_override, carryForwardOverride: r.carry_forward_override,
    carryForwardLimitOverride: num(r.carry_forward_limit_override),
    monthlyAccrualOverride: num(r.monthly_accrual_override), encashmentOverride: r.encashment_override,
    encashmentLimitOverride: num(r.encashment_limit_override),
    effectiveDays: Number(r.annual_days ?? r.policy_days ?? 0),
    effectiveMode: r.credit_mode_override ?? r.policy_mode,
    effectiveMonthlyDays: Number(r.monthly_accrual_override ?? r.policy_monthly ?? 0),
  }));
}

export async function upsertAllocation(
  q: Queryable, yearId: number, typeId: number, employeeId: number, input: AllocationInput, userId: number | null,
): Promise<Outcome<{ before: number | null; after: AllocationInput }>> {
  const existing = await q.query<{ annual_days: string }>(
    'select annual_days::text from leave_allocations where employee_id = $1 and leave_type_id = $2 and academic_year_id = $3',
    [employeeId, typeId, yearId],
  );
  try {
    await q.query(
      `insert into leave_allocations
         (employee_id, leave_type_id, academic_year_id, annual_days, credit_mode_override, carry_forward_override,
          carry_forward_limit_override, monthly_accrual_override, encashment_override, encashment_limit_override, updated_by)
       values ($1, $2, $3, $4, $5, $6, $7, $9, $10, $11, $8)
       on conflict (employee_id, leave_type_id, academic_year_id) do update set
         annual_days = excluded.annual_days, credit_mode_override = excluded.credit_mode_override,
         carry_forward_override = excluded.carry_forward_override,
         carry_forward_limit_override = excluded.carry_forward_limit_override,
         monthly_accrual_override = excluded.monthly_accrual_override, encashment_override = excluded.encashment_override,
         encashment_limit_override = excluded.encashment_limit_override,
         updated_at = now(), updated_by = excluded.updated_by`,
      [employeeId, typeId, yearId, input.annualDays, input.creditModeOverride, input.carryForwardOverride,
        input.carryForwardLimitOverride, userId, input.monthlyAccrualOverride, input.encashmentOverride, input.encashmentLimitOverride],
    );
  } catch (error) {
    if (pgCode(error) === PG_FOREIGN_KEY_VIOLATION) return notFound('Employee, leave type or academic year');
    throw error;
  }
  return { ok: true, value: { before: num(existing.rows[0]?.annual_days ?? null), after: input } };
}

/** Remove an employee's own allocation so they follow the policy default again. */
export async function deleteAllocation(q: Queryable, yearId: number, typeId: number, employeeId: number): Promise<boolean> {
  const { rowCount } = await q.query(
    'delete from leave_allocations where employee_id = $1 and leave_type_id = $2 and academic_year_id = $3',
    [employeeId, typeId, yearId],
  );
  return (rowCount ?? 0) > 0;
}

/** Give many active employees the same yearly days. Existing allocations are kept unless `overwrite`. */
export async function applyAllocation(
  q: Queryable, yearId: number, typeId: number, input: BulkAllocationInput, userId: number | null,
): Promise<number> {
  const ids = input.employeeIds === 'ALL' ? null : input.employeeIds;
  const conflict = input.overwrite
    ? 'on conflict (employee_id, leave_type_id, academic_year_id) do update set annual_days = excluded.annual_days, updated_at = now(), updated_by = excluded.updated_by'
    : 'on conflict (employee_id, leave_type_id, academic_year_id) do nothing';
  const { rowCount } = await q.query(
    `insert into leave_allocations (employee_id, leave_type_id, academic_year_id, annual_days, updated_by)
     select e.id, $2, $1, $3, $4 from employees e
      where e.status = 'ACTIVE' and ($5::int[] is null or e.id = any($5::int[]))
     ${conflict}`,
    [yearId, typeId, input.annualDays, userId, ids],
  );
  return rowCount ?? 0;
}
