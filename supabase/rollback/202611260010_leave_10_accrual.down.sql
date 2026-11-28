-- ROLLBACK for 202611260010_leave_10_accrual.sql
-- Puts leave amounts back to ONE decimal place, drops the accrual columns (the monthly days setting,
-- the per-employee overrides, and the "accrue from" month) and restores migration 08's year-date rule.
-- It REFUSES to run if any stored amount uses a second decimal place (for example a 1.25-day
-- credit), because narrowing would round it. Dropping the columns loses the accrual settings.
-- Do not run without explicit approval. Run BEFORE rolling back migration 09 and earlier.

begin;

do $$
declare n int;
begin
  select (select count(*) from leave_ledger where amount <> round(amount, 1))
       + (select count(*) from leave_requests where paid_days <> round(paid_days, 1) or lop_days <> round(lop_days, 1))
       + (select count(*) from leave_policies where default_annual_days <> round(default_annual_days, 1)
            or carry_forward_limit <> round(carry_forward_limit, 1) or encashment_limit_days <> round(encashment_limit_days, 1))
       + (select count(*) from leave_allocations where annual_days <> round(annual_days, 1) or carry_forward_limit_override <> round(carry_forward_limit_override, 1))
    into n;
  if n > 0 then
    raise exception 'cannot roll back: % stored leave amount(s) use two decimal places and would be rounded', n;
  end if;
end $$;

drop view if exists leave_balances;

drop trigger if exists academic_year_accrual_guard_trg on academic_years;
drop function if exists academic_year_accrual_guard();

alter table academic_years drop column if exists accrual_from;
alter table leave_allocations
  drop column if exists monthly_accrual_override,
  drop column if exists encashment_override,
  drop column if exists encashment_limit_override;
alter table leave_policies drop column if exists monthly_accrual_days;

alter table leave_allocations alter column annual_days type numeric(5,1);
alter table leave_allocations alter column carry_forward_limit_override type numeric(5,1);
alter table leave_policies alter column default_annual_days type numeric(5,1);
alter table leave_policies alter column carry_forward_limit type numeric(5,1);
alter table leave_policies alter column encashment_limit_days type numeric(5,1);
alter table leave_requests alter column paid_days type numeric(5,1);
alter table leave_requests alter column lop_days type numeric(5,1);
alter table leave_ledger alter column amount type numeric(6,1);

create or replace view leave_balances as
  select employee_id, leave_type_id, academic_year_id,
         sum(amount)::numeric(8,1) as balance, count(*)::integer as entries
    from leave_ledger
   group by employee_id, leave_type_id, academic_year_id;
revoke all on leave_balances from anon, authenticated;

-- Migration 08's version of the year-date rule (without the accrual month).
create or replace function academic_year_dates_guard() returns trigger
language plpgsql set search_path = public as $$
declare n_holidays int; n_requests int; n_ledger int; n_permissions int;
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

  if n_holidays + n_requests + n_ledger + n_permissions > 0 then
    raise exception 'these dates cannot be used for academic year %: % holiday(s), % leave request(s), % ledger entr(ies) and % permission(s) would fall outside them',
      old.label, n_holidays, n_requests, n_ledger, n_permissions
      using errcode = 'LY003';
  end if;
  return new;
end $$;

commit;
