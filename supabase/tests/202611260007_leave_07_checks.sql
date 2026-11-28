-- Behaviour checks for migration 07. Leaves NO data behind (everything is rolled back).
-- Run on the TEST project after applying migrations 06 and 07.
-- "Success. No rows returned." = every check passed. Any error message = a check failed.
-- These checks run in ONE database session, so they prove the rules but not simultaneous
-- submissions from two sessions; that needs the separate concurrency test.

begin;

do $$
declare
  dir int; plain int;                       -- the Director login and a non-Director login
  e1 int; e2 int; e3 int; e4 int;           -- four temporary employees
  c int; y int; lt int;
  r1 uuid; r2 uuid; r3 uuid; r4 uuid; r5 uuid; r6 uuid; r7 uuid; p1 uuid;
  n int; bal numeric;

  -- helper: create a pending request with its day row for a date
  d date;
begin
  -- Setup -------------------------------------------------------------------------------------
  insert into users (name, email, password_hash) values ('ZZ Director', 'zz-director@invalid.local', 'x') returning id into dir;
  insert into users (name, email, password_hash) values ('ZZ Plain Admin', 'zz-admin@invalid.local', 'x') returning id into plain;
  insert into attendance_roles (user_id, role) values (plain, 'ADMIN');          -- explicitly NOT the Director
  insert into employees (employee_code, employee_name) values ('ZZ-E1', 'E1') returning id into e1;
  insert into employees (employee_code, employee_name) values ('ZZ-E2', 'E2') returning id into e2;
  insert into employees (employee_code, employee_name) values ('ZZ-E3', 'E3') returning id into e3;
  insert into employees (employee_code, employee_name) values ('ZZ-E4', 'E4') returning id into e4;
  insert into campuses (code, name) values ('ZZ-CAP', 'Cap test campus') returning id into c;
  insert into academic_years (label, start_date, end_date) values ('ZZ-Y', '2026-06-12', '2027-04-23') returning id into y;
  select id into lt from leave_types where code = 'CASUAL';

  if not attendance_is_director(dir) then raise exception 'TEST FAILED: an ADMIN login must be the Director by default'; end if;
  if attendance_is_director(plain) then raise exception 'TEST FAILED: an explicit ADMIN role must NOT be the Director'; end if;

  -- 1. Settings seeded ------------------------------------------------------------------------
  select count(*) into n from attendance_settings where key in
    ('leave_cap_per_campus_per_day','form_token_ttl_minutes','permission_max_minutes','permission_max_per_month',
     'template_leave_request','template_permission_request','template_leave_decision','template_permission_decision');
  if n <> 8 then raise exception 'TEST FAILED: expected 8 leave settings, found %', n; end if;

  -- 2. THE CAP: two on a date are fine, the third is refused --------------------------------------
  d := date '2026-12-01';
  insert into leave_requests (employee_id, campus_id, leave_type_id, academic_year_id, start_date, end_date, reason, total_days, paid_days, idempotency_key)
    values (e1, c, lt, y, d, d, 'r1', 1, 1, 'zz-r1') returning id into r1;
  insert into leave_request_days (request_id, employee_id, campus_id, leave_date, fraction) values (r1, e1, c, d, 1);
  insert into leave_requests (employee_id, campus_id, leave_type_id, academic_year_id, start_date, end_date, reason, total_days, paid_days, idempotency_key)
    values (e2, c, lt, y, d, d, 'r2', 1, 1, 'zz-r2') returning id into r2;
  insert into leave_request_days (request_id, employee_id, campus_id, leave_date, fraction) values (r2, e2, c, d, 1);

  insert into leave_requests (employee_id, campus_id, leave_type_id, academic_year_id, start_date, end_date, reason, total_days, paid_days, idempotency_key)
    values (e3, c, lt, y, d, d, 'r3', 1, 1, 'zz-r3') returning id into r3;
  begin
    insert into leave_request_days (request_id, employee_id, campus_id, leave_date, fraction) values (r3, e3, c, d, 1);
    raise exception 'TEST FAILED: a third leave on a full date was accepted';
  exception when sqlstate 'LC001' then null; end;

  -- A different date at the same campus is unaffected.
  insert into leave_request_days (request_id, employee_id, campus_id, leave_date, fraction) values (r3, e3, c, d + 1, 1);

  -- 3. Rejecting a request releases its place in the same step -----------------------------------
  update leave_requests set status = 'REJECTED', decided_via = 'WEB', decided_by_user_id = dir, decided_at = now(), decision_note = 'not this day'
   where id = r1;
  select count(*) into n from leave_request_days where request_id = r1 and counts_toward_cap;
  if n <> 0 then raise exception 'TEST FAILED: a rejected request still counts towards the cap'; end if;
  insert into leave_requests (employee_id, campus_id, leave_type_id, academic_year_id, start_date, end_date, reason, total_days, paid_days, idempotency_key)
    values (e4, c, lt, y, d, d, 'r4', 1, 1, 'zz-r4') returning id into r4;
  insert into leave_request_days (request_id, employee_id, campus_id, leave_date, fraction) values (r4, e4, c, d, 1);   -- freed place is reusable

  -- 4. Cancelling an APPROVED request also releases its place --------------------------------------
  update leave_requests set status = 'APPROVED', decided_via = 'WEB', decided_by_user_id = dir, decided_at = now() where id = r2;
  begin
    insert into leave_requests (employee_id, campus_id, leave_type_id, academic_year_id, start_date, end_date, reason, total_days, paid_days, idempotency_key)
      values (e1, c, lt, y, d, d, 'again', 1, 1, 'zz-r5') returning id into r5;
    insert into leave_request_days (request_id, employee_id, campus_id, leave_date, fraction) values (r5, e1, c, d, 1);
    raise exception 'TEST FAILED: cap should be full again (approved + pending)';
  exception when sqlstate 'LC001' then null; end;
  update leave_requests set status = 'CANCELLED', cancelled_at = now(), cancelled_by = 'EMPLOYEE', cancel_reason = 'changed plans' where id = r2;
  insert into leave_requests (employee_id, campus_id, leave_type_id, academic_year_id, start_date, end_date, reason, total_days, paid_days, idempotency_key)
    values (e1, c, lt, y, d, d, 'after cancel', 1, 1, 'zz-r6') returning id into r6;
  insert into leave_request_days (request_id, employee_id, campus_id, leave_date, fraction) values (r6, e1, c, d, 1);

  -- 5. The cap number is a setting ---------------------------------------------------------------------
  update attendance_settings set value = '1'::jsonb where key = 'leave_cap_per_campus_per_day';
  d := date '2026-12-10';
  insert into leave_requests (employee_id, campus_id, leave_type_id, academic_year_id, start_date, end_date, reason, total_days, paid_days, idempotency_key)
    values (e1, c, lt, y, d, d, 'cap1 a', 1, 1, 'zz-c1') returning id into r7;
  insert into leave_request_days (request_id, employee_id, campus_id, leave_date, fraction) values (r7, e1, c, d, 1);
  begin
    insert into leave_requests (employee_id, campus_id, leave_type_id, academic_year_id, start_date, end_date, reason, total_days, paid_days, idempotency_key)
      values (e2, c, lt, y, d, d, 'cap1 b', 1, 1, 'zz-c2') returning id into r5;
    insert into leave_request_days (request_id, employee_id, campus_id, leave_date, fraction) values (r5, e2, c, d, 1);
    raise exception 'TEST FAILED: a cap of 1 was not enforced';
  exception when sqlstate 'LC001' then null; end;
  update attendance_settings set value = '2'::jsonb where key = 'leave_cap_per_campus_per_day';

  -- 6. The same employee cannot have two active leaves on one date --------------------------------------
  begin
    insert into leave_requests (employee_id, campus_id, leave_type_id, academic_year_id, start_date, end_date, reason, total_days, paid_days, idempotency_key)
      values (e1, c, lt, y, d, d, 'dup', 1, 1, 'zz-dup') returning id into r5;
    insert into leave_request_days (request_id, employee_id, campus_id, leave_date, fraction) values (r5, e1, c, d, 1);
    raise exception 'TEST FAILED: overlapping leave for the same employee accepted';
  exception when unique_violation then null; end;

  -- 7. Only the Director may decide; rejections need a reason; decisions are final ----------------------------
  insert into leave_requests (employee_id, campus_id, leave_type_id, academic_year_id, start_date, end_date, reason, total_days, paid_days, idempotency_key)
    values (e3, c, lt, y, date '2026-12-15', date '2026-12-15', 'guard tests', 1, 1, 'zz-g1') returning id into r5;
  begin
    update leave_requests set status = 'APPROVED', decided_via = 'WEB', decided_by_user_id = plain, decided_at = now() where id = r5;
    raise exception 'TEST FAILED: a non-Director approved leave';
  exception when raise_exception then
    if sqlerrm like 'TEST FAILED%' then raise; end if;
  end;
  begin
    update leave_requests set status = 'APPROVED', decided_via = 'WEB', decided_at = now() where id = r5;
    raise exception 'TEST FAILED: a web approval with no named user was accepted';
  exception when raise_exception then
    if sqlerrm like 'TEST FAILED%' then raise; end if;
  end;
  begin
    update leave_requests set status = 'REJECTED', decided_via = 'WEB', decided_by_user_id = dir, decided_at = now() where id = r5;
    raise exception 'TEST FAILED: a rejection without a reason was accepted';
  exception when raise_exception then
    if sqlerrm like 'TEST FAILED%' then raise; end if;
  end;
  -- A WhatsApp decision (verified by the application against the Director's number) is allowed.
  update leave_requests set status = 'APPROVED', decided_via = 'WHATSAPP', decided_at = now(), paid_days = 1, lop_days = 0 where id = r5;
  begin
    update leave_requests set status = 'REJECTED', decided_via = 'WEB', decided_by_user_id = dir, decided_at = now(), decision_note = 'x' where id = r5;
    raise exception 'TEST FAILED: an approved request was turned into a rejection';
  exception when raise_exception then
    if sqlerrm like 'TEST FAILED%' then raise; end if;
  end;
  begin
    update leave_requests set decision_note = 'rewritten history' where id = r5;
    raise exception 'TEST FAILED: a recorded decision was edited';
  exception when raise_exception then
    if sqlerrm like 'TEST FAILED%' then raise; end if;
  end;
  begin
    update leave_requests set reason = 'something else' where id = r5;
    raise exception 'TEST FAILED: request details were edited';
  exception when raise_exception then
    if sqlerrm like 'TEST FAILED%' then raise; end if;
  end;
  begin
    delete from leave_requests where id = r5;
    raise exception 'TEST FAILED: a leave request was deleted';
  exception when raise_exception then
    if sqlerrm like 'TEST FAILED%' then raise; end if;
  end;
  begin
    update leave_requests set paid_days = 0, lop_days = 1 where id = r5;
    raise exception 'TEST FAILED: the paid split changed after approval';
  exception when raise_exception then
    if sqlerrm like 'TEST FAILED%' then raise; end if;
  end;

  -- 8. Requests start PENDING (or are rejected by the system with a reason) ------------------------------------
  begin
    insert into leave_requests (employee_id, campus_id, leave_type_id, academic_year_id, start_date, end_date, reason, total_days, paid_days, status, idempotency_key)
      values (e1, c, lt, y, date '2026-12-20', date '2026-12-20', 'sneaky', 1, 1, 'APPROVED', 'zz-sneak');
    raise exception 'TEST FAILED: a request was created already approved';
  exception when raise_exception then
    if sqlerrm like 'TEST FAILED%' then raise; end if;
  end;
  insert into leave_requests (employee_id, campus_id, leave_type_id, academic_year_id, start_date, end_date, reason, total_days, paid_days, status, decided_via, decided_at, decision_note, idempotency_key)
    values (e1, c, lt, y, date '2026-12-21', date '2026-12-21', 'cap full', 1, 1, 'REJECTED', 'SYSTEM', now(), 'Campus limit reached on 2026-12-21', 'zz-auto');
  begin
    insert into leave_requests (employee_id, campus_id, leave_type_id, academic_year_id, start_date, end_date, reason, total_days, paid_days, status, decided_via, decided_at, idempotency_key)
      values (e1, c, lt, y, date '2026-12-22', date '2026-12-22', 'no note', 1, 1, 'REJECTED', 'SYSTEM', now(), 'zz-auto2');
    raise exception 'TEST FAILED: an automatic rejection without a reason was accepted';
  exception when raise_exception then
    if sqlerrm like 'TEST FAILED%' then raise; end if;
  end;

  -- 9. Half days: single date only; the paid + LOP split must add up ---------------------------------------------
  begin
    insert into leave_requests (employee_id, campus_id, leave_type_id, academic_year_id, start_date, end_date, day_mode, reason, total_days, paid_days, idempotency_key)
      values (e1, c, lt, y, date '2026-12-23', date '2026-12-24', 'FIRST_HALF', 'x', 1, 1, 'zz-half');
    raise exception 'TEST FAILED: a half-day over several dates was accepted';
  exception when check_violation then null; end;
  begin
    insert into leave_requests (employee_id, campus_id, leave_type_id, academic_year_id, start_date, end_date, reason, total_days, paid_days, lop_days, idempotency_key)
      values (e1, c, lt, y, date '2026-12-23', date '2026-12-23', 'x', 1, 1, 1, 'zz-split');
    raise exception 'TEST FAILED: paid + LOP not equal to total accepted';
  exception when check_violation then null; end;
  begin
    insert into leave_requests (employee_id, campus_id, leave_type_id, academic_year_id, start_date, end_date, reason, total_days, paid_days, idempotency_key)
      values (e1, c, lt, y, date '2026-12-23', date '2026-12-23', 'dupkey', 1, 1, 'zz-r1');
    raise exception 'TEST FAILED: a repeated idempotency key was accepted';
  exception when unique_violation then null; end;

  -- 10. THE LEDGER -------------------------------------------------------------------------------------------------
  insert into leave_ledger (employee_id, leave_type_id, academic_year_id, entry_type, amount, effective_date, period)
    values (e1, lt, y, 'CREDIT', 1.0, date '2026-06-12', '2026-06');
  insert into leave_ledger (employee_id, leave_type_id, academic_year_id, entry_type, amount, effective_date, period)
    values (e1, lt, y, 'CREDIT', 1.0, date '2026-07-01', '2026-07');
  insert into leave_ledger (employee_id, leave_type_id, academic_year_id, entry_type, amount, effective_date)
    values (e1, lt, y, 'OPENING', 3.5, date '2026-06-12');
  begin
    insert into leave_ledger (employee_id, leave_type_id, academic_year_id, entry_type, amount, effective_date, period)
      values (e1, lt, y, 'CREDIT', 1.0, date '2026-07-02', '2026-07');
    raise exception 'TEST FAILED: the same monthly credit was posted twice';
  exception when unique_violation then null; end;
  begin
    insert into leave_ledger (employee_id, leave_type_id, academic_year_id, entry_type, amount, effective_date)
      values (e1, lt, y, 'OPENING', 1.0, date '2026-06-13');
    raise exception 'TEST FAILED: a second opening balance was accepted';
  exception when unique_violation then null; end;
  begin
    insert into leave_ledger (employee_id, leave_type_id, academic_year_id, entry_type, amount, effective_date, request_id)
      values (e3, lt, y, 'DEDUCTION', 1.0, date '2026-12-15', r5);
    raise exception 'TEST FAILED: a positive deduction was accepted';
  exception when check_violation then null; end;
  begin
    insert into leave_ledger (employee_id, leave_type_id, academic_year_id, entry_type, amount, effective_date)
      values (e1, lt, y, 'DEDUCTION', -1.0, date '2026-12-15');
    raise exception 'TEST FAILED: a deduction with no request was accepted';
  exception when check_violation then null; end;
  begin
    insert into leave_ledger (employee_id, leave_type_id, academic_year_id, entry_type, amount, effective_date)
      values (e1, lt, y, 'ADJUSTMENT', 2.0, date '2026-12-15');
    raise exception 'TEST FAILED: an adjustment with no reason was accepted';
  exception when check_violation then null; end;
  begin
    insert into leave_ledger (employee_id, leave_type_id, academic_year_id, entry_type, amount, effective_date, request_id)
      values (e3, lt, y, 'CREDIT', 1.0, date '2026-12-15', r5);
    raise exception 'TEST FAILED: a credit tied to a request was accepted';
  exception when check_violation then null; end;

  insert into leave_ledger (employee_id, leave_type_id, academic_year_id, entry_type, amount, effective_date, request_id)
    values (e3, lt, y, 'DEDUCTION', -1.0, date '2026-12-15', r5);
  begin
    insert into leave_ledger (employee_id, leave_type_id, academic_year_id, entry_type, amount, effective_date, request_id)
      values (e3, lt, y, 'DEDUCTION', -1.0, date '2026-12-15', r5);
    raise exception 'TEST FAILED: a request was deducted twice';
  exception when unique_violation then null; end;
  insert into leave_ledger (employee_id, leave_type_id, academic_year_id, entry_type, amount, effective_date, request_id, reason)
    values (e3, lt, y, 'REVERSAL', 1.0, date '2026-12-16', r5, 'leave cancelled');
  insert into leave_ledger (employee_id, leave_type_id, academic_year_id, entry_type, amount, effective_date, reason, created_by)
    values (e1, lt, y, 'ADJUSTMENT', -0.5, date '2026-12-17', 'correction', dir);

  -- Balance = opening 3.5 + credits 2.0 - deduction 1.0 + reversal 1.0 - adjustment 0.5 = 5.0
  select balance into bal from leave_balances where employee_id = e1 and leave_type_id = lt and academic_year_id = y;
  if bal is distinct from 5.0 then raise exception 'TEST FAILED: balance should be 5.0, got %', bal; end if;

  begin
    update leave_ledger set amount = 99 where employee_id = e1;
    raise exception 'TEST FAILED: a ledger entry was edited';
  exception when raise_exception then
    if sqlerrm like 'TEST FAILED%' then raise; end if;
  end;
  begin
    delete from leave_ledger where employee_id = e1;
    raise exception 'TEST FAILED: a ledger entry was deleted';
  exception when raise_exception then
    if sqlerrm like 'TEST FAILED%' then raise; end if;
  end;

  -- 11. Leave day rows are frozen, and a released place cannot be re-activated -------------------------------------
  begin
    update leave_request_days set counts_toward_cap = true where request_id = r1;
    raise exception 'TEST FAILED: a released leave day was re-activated';
  exception when raise_exception then
    if sqlerrm like 'TEST FAILED%' then raise; end if;
  end;
  begin
    update leave_request_days set leave_date = leave_date + 1 where request_id = r4;
    raise exception 'TEST FAILED: a leave day was moved';
  exception when raise_exception then
    if sqlerrm like 'TEST FAILED%' then raise; end if;
  end;
  begin
    delete from leave_request_days where request_id = r4;
    raise exception 'TEST FAILED: a leave day was deleted';
  exception when raise_exception then
    if sqlerrm like 'TEST FAILED%' then raise; end if;
  end;

  -- 12. PERMISSIONS ------------------------------------------------------------------------------------------------------
  begin
    insert into permission_requests (employee_id, campus_id, permission_date, start_time, end_time, reason, idempotency_key)
      values (e1, c, date '2026-12-02', '11:00', '10:00', 'x', 'zz-p0');
    raise exception 'TEST FAILED: a permission ending before it starts was accepted';
  exception when check_violation then null; end;
  insert into permission_requests (employee_id, campus_id, permission_date, start_time, end_time, reason, idempotency_key)
    values (e1, c, date '2026-12-02', '10:00', '11:00', 'doctor', 'zz-p1') returning id into p1;
  begin
    update permission_requests set status = 'APPROVED', decided_via = 'WEB', decided_by_user_id = plain, decided_at = now() where id = p1;
    raise exception 'TEST FAILED: a non-Director approved a permission';
  exception when raise_exception then
    if sqlerrm like 'TEST FAILED%' then raise; end if;
  end;
  update permission_requests set status = 'APPROVED', decided_via = 'WEB', decided_by_user_id = dir, decided_at = now() where id = p1;
  begin
    update permission_requests set reason = 'changed' where id = p1;
    raise exception 'TEST FAILED: permission details were edited';
  exception when raise_exception then
    if sqlerrm like 'TEST FAILED%' then raise; end if;
  end;
  update permission_requests set status = 'CANCELLED', cancelled_at = now(), cancelled_by = 'DIRECTOR' where id = p1;

  -- 13. Form links and the Director's pending input ------------------------------------------------------------------------
  insert into form_tokens (token_hash, employee_id, purpose, expires_at) values ('zz-hash', e1, 'LEAVE', now() + interval '30 minutes');
  begin
    insert into form_tokens (token_hash, employee_id, purpose, expires_at) values ('zz-hash', e2, 'LEAVE', now() + interval '30 minutes');
    raise exception 'TEST FAILED: a duplicate form token hash was accepted';
  exception when unique_violation then null; end;
  begin
    insert into form_tokens (token_hash, employee_id, purpose, expires_at) values ('zz-hash2', e1, 'HOLIDAY', now());
    raise exception 'TEST FAILED: an unknown form purpose was accepted';
  exception when check_violation then null; end;
  insert into director_pending_input (request_kind, request_id, action, expires_at) values ('LEAVE', r5, 'REJECT', now() + interval '10 minutes');
end $$;

rollback;
