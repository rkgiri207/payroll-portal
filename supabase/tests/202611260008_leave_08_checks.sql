-- Behaviour checks for migration 08. Leaves NO data behind (everything is rolled back).
-- Run on the TEST project after applying migrations 06, 07 and 08.
-- "Success. No rows returned." = every check passed. Any error message = a check failed.

begin;

do $$
declare
  e int; c int; y int; y2 int; lt int; r uuid; r2 uuid; n int;
begin
  insert into employees (employee_code, employee_name) values ('ZZ-Y-E1', 'Year test') returning id into e;
  insert into campuses (code, name) values ('ZZ-YR', 'Year test campus') returning id into c;
  insert into academic_years (label, start_date, end_date) values ('ZZ-Y', '2026-06-12', '2027-04-23') returning id into y;
  insert into academic_years (label, start_date, end_date) values ('ZZ-Y2', '2027-06-12', '2028-04-23') returning id into y2;
  select id into lt from leave_types where code = 'CASUAL';

  -- 1. The setting exists and is OFF; the attendance flag defaults to false. --------------------
  if (select value from attendance_settings where key = 'allow_attendance_outside_academic_year') is distinct from 'false'::jsonb then
    raise exception 'TEST FAILED: allow_attendance_outside_academic_year must exist and default to false';
  end if;
  select count(*) into n from information_schema.columns
   where table_name = 'attendance_events' and column_name = 'outside_academic_year' and column_default = 'false';
  if n <> 1 then raise exception 'TEST FAILED: attendance_events.outside_academic_year missing or not default false'; end if;

  -- 2. Leave requests: inside the year is fine; before it, after it or across two years is refused.
  insert into leave_requests (employee_id, campus_id, leave_type_id, academic_year_id, start_date, end_date, reason, total_days, paid_days, idempotency_key)
    values (e, c, lt, y, '2026-12-01', '2026-12-02', 'ok', 2, 2, 'zz-y-1') returning id into r;
  begin
    insert into leave_requests (employee_id, campus_id, leave_type_id, academic_year_id, start_date, end_date, reason, total_days, paid_days, idempotency_key)
      values (e, c, lt, y, '2027-04-20', '2027-06-15', 'spans two years', 3, 3, 'zz-y-2');
    raise exception 'TEST FAILED: a request spanning two academic years was accepted';
  exception when sqlstate 'LY001' then null; end;
  begin
    insert into leave_requests (employee_id, campus_id, leave_type_id, academic_year_id, start_date, end_date, reason, total_days, paid_days, idempotency_key)
      values (e, c, lt, y, '2026-06-01', '2026-06-01', 'before the year', 1, 1, 'zz-y-3');
    raise exception 'TEST FAILED: a request before the academic year started was accepted';
  exception when sqlstate 'LY001' then null; end;
  begin
    insert into leave_requests (employee_id, campus_id, leave_type_id, academic_year_id, start_date, end_date, reason, total_days, paid_days, idempotency_key)
      values (e, c, lt, y2, '2027-01-04', '2027-01-04', 'wrong year chosen', 1, 1, 'zz-y-4');
    raise exception 'TEST FAILED: a request outside its chosen academic year was accepted';
  exception when sqlstate 'LY001' then null; end;

  -- 3. Ledger entries belong to their year. -------------------------------------------------------
  insert into leave_ledger (employee_id, leave_type_id, academic_year_id, entry_type, amount, effective_date)
    values (e, lt, y, 'OPENING', 12, '2026-06-12');
  insert into leave_ledger (employee_id, leave_type_id, academic_year_id, entry_type, amount, effective_date, period)
    values (e, lt, y, 'CREDIT', 1, '2026-06-12', '2026-06');                 -- first month of the year
  insert into leave_ledger (employee_id, leave_type_id, academic_year_id, entry_type, amount, effective_date, period)
    values (e, lt, y, 'CREDIT', 1, '2027-04-01', '2027-04');                 -- last month of the year
  begin
    insert into leave_ledger (employee_id, leave_type_id, academic_year_id, entry_type, amount, effective_date, period)
      values (e, lt, y, 'CREDIT', 1, '2026-06-12', '2026-05');
    raise exception 'TEST FAILED: a credit for a month before the academic year was accepted';
  exception when sqlstate 'LY002' then null; end;
  begin
    insert into leave_ledger (employee_id, leave_type_id, academic_year_id, entry_type, amount, effective_date, period)
      values (e, lt, y, 'CREDIT', 1, '2027-04-01', '2027-05');
    raise exception 'TEST FAILED: a credit for a month after the academic year was accepted';
  exception when sqlstate 'LY002' then null; end;
  begin
    insert into leave_ledger (employee_id, leave_type_id, academic_year_id, entry_type, amount, effective_date)
      values (e, lt, y2, 'OPENING', 5, '2026-12-01');
    raise exception 'TEST FAILED: an opening balance dated outside its academic year was accepted';
  exception when sqlstate 'LY002' then null; end;
  begin
    insert into leave_ledger (employee_id, leave_type_id, academic_year_id, entry_type, amount, effective_date, request_id)
      values (e, lt, y2, 'DEDUCTION', -2, '2027-07-01', r);                  -- request belongs to year y, not y2
    raise exception 'TEST FAILED: a deduction in a different year from its request was accepted';
  exception when sqlstate 'LY002' then null; end;

  insert into leave_ledger (employee_id, leave_type_id, academic_year_id, entry_type, amount, effective_date, request_id)
    values (e, lt, y, 'DEDUCTION', -2, '2026-12-01', r);
  -- A reversal posted after the year ended (a late cancellation) is allowed, and stays in the same year.
  insert into leave_ledger (employee_id, leave_type_id, academic_year_id, entry_type, amount, effective_date, request_id)
    values (e, lt, y, 'REVERSAL', 2, '2027-06-01', r);

  -- Balances never mix years: the next year starts at zero until an opening or carry-forward is posted.
  select count(*) into n from leave_balances where employee_id = e and academic_year_id = y2;
  if n <> 0 then raise exception 'TEST FAILED: another academic year shows a balance it never received'; end if;
  if (select balance from leave_balances where employee_id = e and academic_year_id = y and leave_type_id = lt) <> 14 then
    raise exception 'TEST FAILED: expected balance 12 + 1 + 1 - 2 + 2 = 14';
  end if;

  -- 4. Permissions need an academic year. --------------------------------------------------------
  insert into permission_requests (employee_id, campus_id, permission_date, start_time, end_time, reason, idempotency_key)
    values (e, c, '2026-12-03', '10:00', '11:00', 'ok', 'zz-y-p1');
  begin
    insert into permission_requests (employee_id, campus_id, permission_date, start_time, end_time, reason, idempotency_key)
      values (e, c, '2030-01-03', '10:00', '11:00', 'no year', 'zz-y-p2');
    raise exception 'TEST FAILED: a permission outside every academic year was accepted';
  exception when sqlstate 'LY004' then null; end;

  -- 5. Changing a year's dates: refused if records would fall outside, allowed otherwise. ----------
  begin
    update academic_years set end_date = '2026-11-30' where id = y;           -- the request on 1-2 Dec would fall outside
    raise exception 'TEST FAILED: shrinking a year below an existing leave request was accepted';
  exception when sqlstate 'LY003' then null; end;
  begin
    update academic_years set end_date = '2027-03-15' where id = y;           -- the April credit would fall outside
    raise exception 'TEST FAILED: shrinking a year below an existing monthly credit was accepted';
  exception when sqlstate 'LY003' then null; end;
  begin
    update academic_years set start_date = '2026-06-20' where id = y;         -- the opening balance dated 12 Jun would fall outside
    raise exception 'TEST FAILED: moving a year start past an existing opening entry was accepted';
  exception when sqlstate 'LY003' then null; end;
  update academic_years set end_date = '2027-04-30' where id = y;             -- extending is fine
  update academic_years set start_date = '2026-06-01' where id = y;           -- starting earlier is fine
  update academic_years set label = 'ZZ-Y-renamed' where id = y;              -- renaming never trips the guard
  begin
    update academic_years set end_date = '2027-06-20' where id = y;           -- would overlap the next year
    raise exception 'TEST FAILED: a year was stretched into the next year';
  exception when exclusion_violation then null; end;
end $$;

rollback;
