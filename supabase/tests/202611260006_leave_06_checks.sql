-- Behaviour checks for migration 06. Leaves NO data behind (everything is rolled back).
-- Run on the TEST project after applying migration 06.
-- "Success. No rows returned." = every check passed. Any error message = a check failed.

begin;

do $$
declare y1 int; y2 int; emp int; lt int; n int;
begin
  -- 1. The four leave types are seeded.
  select count(*) into n from leave_types where code in ('CASUAL', 'SICK', 'EARNED', 'UNPAID');
  if n <> 4 then raise exception 'TEST FAILED: expected 4 seeded leave types, found %', n; end if;
  if (select tracks_balance from leave_types where code = 'UNPAID') then
    raise exception 'TEST FAILED: unpaid leave must not track a balance';
  end if;

  -- 2. Academic years: valid, non-overlapping, and an overlap is refused.
  insert into academic_years (label, start_date, end_date) values ('ZZ-2026-27', '2026-06-12', '2027-04-23') returning id into y1;
  begin
    insert into academic_years (label, start_date, end_date) values ('ZZ-overlap', '2027-01-01', '2027-12-31');
    raise exception 'TEST FAILED: overlapping academic year accepted';
  exception when exclusion_violation then null; end;
  begin
    insert into academic_years (label, start_date, end_date) values ('ZZ-backwards', '2030-06-01', '2030-05-01');
    raise exception 'TEST FAILED: backwards academic year accepted';
  exception when check_violation then null; end;
  insert into academic_years (label, start_date, end_date) values ('ZZ-2027-28', '2027-06-12', '2028-04-23') returning id into y2;

  -- 3. Holidays: inside the year is fine; outside it, duplicates, bad kinds and unconfirmed-but-marked are refused.
  insert into holidays (academic_year_id, name, kind, start_date, end_date, source)
    values (y1, 'Dasara', 'VACATION', '2026-10-12', '2026-10-21', 'test');
  insert into holidays (academic_year_id, name, kind, start_date, end_date) values (y1, 'Gandhi Jayanthi', 'HOLIDAY', '2026-10-02', '2026-10-02');
  begin
    insert into holidays (academic_year_id, name, kind, start_date, end_date) values (y1, 'Too early', 'HOLIDAY', '2026-05-01', '2026-05-01');
    raise exception 'TEST FAILED: holiday before the academic year accepted';
  exception when raise_exception then
    if sqlerrm like 'TEST FAILED%' then raise; end if;
  end;
  begin
    insert into holidays (academic_year_id, name, kind, start_date, end_date) values (y1, 'Too late', 'VACATION', '2027-04-20', '2027-04-30');
    raise exception 'TEST FAILED: holiday running past the academic year accepted';
  exception when raise_exception then
    if sqlerrm like 'TEST FAILED%' then raise; end if;
  end;
  begin
    insert into holidays (academic_year_id, name, kind, start_date, end_date) values (y1, 'Dasara', 'VACATION', '2026-10-12', '2026-10-21');
    raise exception 'TEST FAILED: duplicate holiday accepted';
  exception when unique_violation then null; end;
  begin
    insert into holidays (academic_year_id, name, kind, start_date, end_date) values (y1, 'Odd', 'PARTY', '2026-10-05', '2026-10-05');
    raise exception 'TEST FAILED: unknown holiday kind accepted';
  exception when check_violation then null; end;
  begin
    insert into holidays (academic_year_id, name, kind, start_date, end_date, status) values (y1, 'Unproven', 'HOLIDAY', '2026-10-06', '2026-10-06', 'CONFIRMED');
    raise exception 'TEST FAILED: CONFIRMED holiday without confirmed_at accepted';
  exception when check_violation then null; end;
  begin
    insert into holidays (academic_year_id, name, kind, start_date, end_date) values (y1, 'Backwards', 'HOLIDAY', '2026-10-09', '2026-10-08');
    raise exception 'TEST FAILED: backwards holiday accepted';
  exception when check_violation then null; end;
  -- The same day may be a holiday at one campus only (campus-specific rows are allowed).
  insert into holidays (academic_year_id, campus_id, name, kind, start_date, end_date) select y1, null, 'All campuses', 'HOLIDAY', '2026-11-08', '2026-11-08';

  -- 4. Policy: carry-forward LIMIT needs a limit; one policy per type per year.
  select id into lt from leave_types where code = 'CASUAL';
  begin
    insert into leave_policies (leave_type_id, academic_year_id, carry_forward_mode) values (lt, y1, 'LIMIT');
    raise exception 'TEST FAILED: LIMIT carry-forward without a limit accepted';
  exception when check_violation then null; end;
  insert into leave_policies (leave_type_id, academic_year_id, credit_mode, default_annual_days, carry_forward_mode, carry_forward_limit)
    values (lt, y1, 'MONTHLY', 12, 'LIMIT', 5);
  begin
    insert into leave_policies (leave_type_id, academic_year_id) values (lt, y1);
    raise exception 'TEST FAILED: a second policy for the same type and year accepted';
  exception when unique_violation then null; end;
  begin
    insert into leave_policies (leave_type_id, academic_year_id, insufficient_balance) values (lt, y2, 'SHRUG');
    raise exception 'TEST FAILED: unknown insufficient-balance option accepted';
  exception when check_violation then null; end;

  -- 5. Allocation: one per employee, type and year; negative days refused.
  -- A fresh temporary employee, so real employees and their registrations never interfere.
  insert into employees (employee_code, employee_name) values ('ZZ-TEST-EMP', 'Rollback test employee') returning id into emp;
  insert into leave_allocations (employee_id, leave_type_id, academic_year_id, annual_days) values (emp, lt, y1, 12);
  begin
    insert into leave_allocations (employee_id, leave_type_id, academic_year_id, annual_days) values (emp, lt, y1, 6);
    raise exception 'TEST FAILED: duplicate allocation accepted';
  exception when unique_violation then null; end;
  begin
    insert into leave_allocations (employee_id, leave_type_id, academic_year_id, annual_days) values (emp, lt, y2, -1);
    raise exception 'TEST FAILED: negative allocation accepted';
  exception when check_violation then null; end;

  -- 6. The vacation-work flag exists on attendance_employees and defaults to off.
  insert into attendance_employees (employee_id) values (emp);
  if (select reports_during_vacations from attendance_employees where employee_id = emp) then
    raise exception 'TEST FAILED: reports_during_vacations should default to false';
  end if;
end $$;

rollback;
