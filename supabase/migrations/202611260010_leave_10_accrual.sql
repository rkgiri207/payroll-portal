-- Leave module, migration 10: monthly accrual.
--   1. Leave amounts hold TWO decimal places (they held one): ledger entries, balances, the paid and
--      without-pay split, the policy day settings and the allocations. Widening a numeric column
--      never loses a value. A request itself is still counted in whole and half days.
--   2. New policy setting: days credited each month (default 0, so nothing is credited until set).
--   3. New per-employee overrides on an allocation: days credited each month, and encashment
--      (allowed or not, with a limit). Empty means "follow the policy".
--   4. New per academic year: the month accrual starts from. Empty means the year's first day. This
--      is how the app goes live part-way through a year: months before it are never credited by the
--      system; opening balances cover them.
-- ADDITIVE: no row is removed or rewritten. Nothing in payroll, payslips, employees or users is touched.
-- Requires migrations 01 to 09. Apply to the TEST Supabase project only (kcpaqvuburgehzrdtygk).
-- Idempotent: safe to run twice.

begin;

-- The balances view reads the ledger amount, so it is dropped while the column is widened.
drop view if exists leave_balances;

alter table leave_ledger   alter column amount    type numeric(8,2);
alter table leave_requests alter column paid_days type numeric(6,2);
alter table leave_requests alter column lop_days  type numeric(6,2);

alter table leave_policies alter column default_annual_days  type numeric(6,2);
alter table leave_policies alter column carry_forward_limit  type numeric(6,2);
alter table leave_policies alter column encashment_limit_days type numeric(6,2);
alter table leave_policies
  add column if not exists monthly_accrual_days numeric(6,2) not null default 0 check (monthly_accrual_days >= 0);

alter table leave_allocations alter column annual_days type numeric(6,2);
alter table leave_allocations alter column carry_forward_limit_override type numeric(6,2);
alter table leave_allocations
  add column if not exists monthly_accrual_override  numeric(6,2) check (monthly_accrual_override is null or monthly_accrual_override >= 0),
  add column if not exists encashment_override       boolean,
  add column if not exists encashment_limit_override numeric(6,2) check (encashment_limit_override is null or encashment_limit_override >= 0);

alter table academic_years
  add column if not exists accrual_from date
    check (accrual_from is null or accrual_from >= start_date);

create or replace view leave_balances as
  select employee_id, leave_type_id, academic_year_id,
         sum(amount)::numeric(10,2) as balance, count(*)::integer as entries
    from leave_ledger
   group by employee_id, leave_type_id, academic_year_id;
revoke all on leave_balances from anon, authenticated;

-- Changing a year's dates is refused if anything would fall outside them. This now also covers the
-- "accrue from" month. (Replaces the function from migration 08; its other rules are unchanged.)
create or replace function academic_year_dates_guard() returns trigger
language plpgsql set search_path = public as $$
declare n_holidays int; n_requests int; n_ledger int; n_permissions int; accrual_outside boolean;
begin
  if new.start_date = old.start_date and new.end_date = old.end_date then
    return new;
  end if;

  select count(*) into n_holidays from holidays
   where academic_year_id = old.id and (start_date < new.start_date or end_date > new.end_date);
  select count(*) into n_requests from leave_requests
   where academic_year_id = old.id and (start_date < new.start_date or end_date > new.end_date);
  select count(*) into n_ledger from leave_ledger
   where academic_year_id = old.id
     and ((entry_type in ('OPENING', 'CREDIT', 'CARRY_FORWARD', 'DEDUCTION')
           and (effective_date < new.start_date or effective_date > new.end_date))
       or (period is not null
           and ((to_date(period || '-01', 'YYYY-MM-DD') + interval '1 month' - interval '1 day')::date < new.start_date
                or to_date(period || '-01', 'YYYY-MM-DD') > new.end_date)));
  select count(*) into n_permissions from permission_requests
   where permission_date between old.start_date and old.end_date
     and (permission_date < new.start_date or permission_date > new.end_date);
  accrual_outside := new.accrual_from is not null and (new.accrual_from < new.start_date or new.accrual_from > new.end_date);

  if n_holidays + n_requests + n_ledger + n_permissions > 0 or accrual_outside then
    raise exception 'these dates cannot be used for academic year %: % holiday(s), % leave request(s), % ledger entr(ies) and % permission(s) would fall outside them%',
      old.label, n_holidays, n_requests, n_ledger, n_permissions,
      case when accrual_outside then ', and the month accrual starts from would be outside the year' else '' end
      using errcode = 'LY003';
  end if;
  return new;
end $$;

-- The accrual start must also lie inside the year's end (the column check above covers the start).
create or replace function academic_year_accrual_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.accrual_from is not null and new.accrual_from > new.end_date then
    raise exception 'accrual cannot start after the academic year ends (%)', new.end_date using errcode = 'LY003';
  end if;
  return new;
end $$;

drop trigger if exists academic_year_accrual_guard_trg on academic_years;
create trigger academic_year_accrual_guard_trg
  before insert or update on academic_years
  for each row execute function academic_year_accrual_guard();

commit;
