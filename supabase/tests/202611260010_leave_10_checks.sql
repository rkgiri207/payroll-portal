-- Behaviour checks for migration 10. Leaves NO data behind (everything is rolled back).
-- Run on the TEST project after applying migration 10.
-- "Success. No rows returned." = every check passed. Any error message = a check failed.

begin;

do $$
declare
  e int; c int; y int; lt int; r uuid; bal numeric; n int;
begin
  insert into employees (employee_code, employee_name) values ('ZZ-ACC-E1', 'Accrual test') returning id into e;
  insert into campuses (code, name) values ('ZZ-ACC', 'Accrual test campus') returning id into c;
  insert into academic_years (label, start_date, end_date) values ('ZZ-ACC-Y', '2026-06-12', '2027-04-23') returning id into y;
  select id into lt from leave_types where code = 'CASUAL';

  -- 1. Two decimals are kept exactly.
  insert into leave_ledger (employee_id, leave_type_id, academic_year_id, entry_type, amount, effective_date, period)
    values (e, lt, y, 'CREDIT', 1.25, '2026-12-01', '2026-12');
  insert into leave_ledger (employee_id, leave_type_id, academic_year_id, entry_type, amount, effective_date, period)
    values (e, lt, y, 'CREDIT', 0.75, '2027-01-01', '2027-01');
  insert into leave_ledger (employee_id, leave_type_id, academic_year_id, entry_type, amount, effective_date)
    values (e, lt, y, 'OPENING', 4.35, '2026-12-01');
  select balance into bal from leave_balances where employee_id = e and leave_type_id = lt and academic_year_id = y;
  if bal is distinct from 6.35 then raise exception 'TEST FAILED: balance should be 6.35, got %', bal; end if;
  begin
    insert into leave_ledger (employee_id, leave_type_id, academic_year_id, entry_type, amount, effective_date, period)
      values (e, lt, y, 'CREDIT', 0, '2027-02-01', '2027-02');
    raise exception 'TEST FAILED: a zero ledger entry was accepted';
  exception when check_violation then null; end;

  -- A request keeps half-day lengths, but its paid and without-pay parts may use two decimals.
  insert into leave_requests (employee_id, campus_id, leave_type_id, academic_year_id, start_date, end_date, reason, total_days, paid_days, lop_days, idempotency_key)
    values (e, c, lt, y, '2026-12-14', '2026-12-15', 'two decimals', 2, 1.25, 0.75, 'zz-acc-1') returning id into r;
  begin
    insert into leave_requests (employee_id, campus_id, leave_type_id, academic_year_id, start_date, end_date, reason, total_days, paid_days, lop_days, idempotency_key)
      values (e, c, lt, y, '2026-12-16', '2026-12-16', 'does not add up', 1, 0.6, 0.5, 'zz-acc-2');
    raise exception 'TEST FAILED: paid + without pay not equal to total was accepted';
  exception when check_violation then null; end;

  -- 2. Policy: the monthly days setting defaults to 0 (nothing credited until set) and keeps two decimals.
  insert into leave_policies (leave_type_id, academic_year_id, credit_mode) values (lt, y, 'MONTHLY');
  if (select monthly_accrual_days from leave_policies where leave_type_id = lt and academic_year_id = y) <> 0 then
    raise exception 'TEST FAILED: monthly accrual days must default to 0';
  end if;
  update leave_policies set monthly_accrual_days = 1.25, default_annual_days = 13.75, carry_forward_mode = 'LIMIT', carry_forward_limit = 2.5
   where leave_type_id = lt and academic_year_id = y;
  if (select monthly_accrual_days from leave_policies where leave_type_id = lt and academic_year_id = y) <> 1.25 then
    raise exception 'TEST FAILED: 1.25 monthly days was not kept';
  end if;
  begin
    update leave_policies set monthly_accrual_days = -1 where leave_type_id = lt and academic_year_id = y;
    raise exception 'TEST FAILED: negative monthly days accepted';
  exception when check_violation then null; end;

  -- 3. Allocation overrides: monthly days, encashment on or off with a limit; empty follows the policy.
  insert into leave_allocations (employee_id, leave_type_id, academic_year_id, annual_days) values (e, lt, y, 12);
  if (select (monthly_accrual_override is null and encashment_override is null and encashment_limit_override is null)
        from leave_allocations where employee_id = e) is not true then
    raise exception 'TEST FAILED: overrides must start empty';
  end if;
  update leave_allocations set monthly_accrual_override = 1.5, encashment_override = true, encashment_limit_override = 3.25 where employee_id = e;
  begin
    update leave_allocations set monthly_accrual_override = -0.5 where employee_id = e;
    raise exception 'TEST FAILED: negative override accepted';
  exception when check_violation then null; end;
  begin
    update leave_allocations set encashment_limit_override = -1 where employee_id = e;
    raise exception 'TEST FAILED: negative encashment limit accepted';
  exception when check_violation then null; end;

  -- 4. "Accrue from": empty by default; inside the year; never before the start or after the end.
  if (select accrual_from from academic_years where id = y) is not null then raise exception 'TEST FAILED: accrual_from must start empty'; end if;
  update academic_years set accrual_from = '2026-12-01' where id = y;
  begin
    update academic_years set accrual_from = '2026-05-01' where id = y;
    raise exception 'TEST FAILED: accrual starting before the academic year was accepted';
  exception when check_violation then null; end;
  begin
    update academic_years set accrual_from = '2027-05-01' where id = y;
    raise exception 'TEST FAILED: accrual starting after the academic year ended was accepted';
  exception when sqlstate 'LY003' then null; end;
  begin
    insert into academic_years (label, start_date, end_date, accrual_from) values ('ZZ-ACC-Y2', '2027-06-12', '2028-04-23', '2027-05-01');
    raise exception 'TEST FAILED: a new year with accrual starting before it began was accepted';
  exception when check_violation then null; end;

  -- Moving the year so the accrual month would fall outside it is refused, with the usual message.
  begin
    update academic_years set start_date = '2026-12-15' where id = y;      -- accrual_from 1 Dec would be before the new start
    raise exception 'TEST FAILED: moving the year start past the accrual month was accepted';
  exception when sqlstate 'LY003' then null; when check_violation then null; end;
  -- The older rules from migration 08 still hold.
  begin
    update academic_years set end_date = '2026-12-14' where id = y;        -- the leave request on 14-15 Dec would fall outside
    raise exception 'TEST FAILED: shrinking a year below an existing leave request was accepted';
  exception when sqlstate 'LY003' then null; end;
  update academic_years set end_date = '2027-04-30' where id = y;          -- extending is still fine
end $$;

rollback;
