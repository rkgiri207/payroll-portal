-- Behaviour checks for migration 02. Leaves NO data behind (everything is rolled back).
-- Run on the TEST project after applying migration 02.
-- "Success. No rows returned." = every check passed. Any error message = a check failed.
-- Uses your first existing employee and user as foreign-key targets, or temporary ones if none
-- exist. Changes nothing permanently (the whole script ends with ROLLBACK).

begin;

do $$
declare emp int; usr int; cam int; tok uuid; ev uuid;
begin
  -- Use existing rows if there are any; otherwise create temporary ones.
  -- Everything is rolled back at the end, so nothing is kept.
  select min(id) into emp from employees;
  select min(id) into usr from users;
  if emp is null then
    insert into employees (employee_code, employee_name)
      values ('ZZ-TEST-EMP', 'Rollback test employee') returning id into emp;
  end if;
  if usr is null then
    insert into users (name, email, password_hash)
      values ('Rollback test user', 'zz-test@invalid.local', 'x') returning id into usr;
  end if;

  insert into campuses (code, name) values ('ZZ-TEST', 'Rollback test campus') returning id into cam;
  insert into attendance_tokens (token_hash, employee_id, campus_id, event_type, work_date, expires_at)
    values ('zz-test-hash', emp, cam, 'IN', current_date, now() + interval '5 minutes') returning id into tok;
  insert into attendance_events (employee_id, campus_id, event_type, work_date, punctuality, source, token_id)
    values (emp, cam, 'IN', current_date, 'ON_TIME', 'WHATSAPP_LINK', tok) returning id into ev;

  -- 1. A second valid IN on the same day must be rejected.
  begin
    insert into attendance_events (employee_id, campus_id, event_type, work_date, punctuality, source)
      values (emp, cam, 'IN', current_date, 'ON_TIME', 'WHATSAPP_LINK');
    raise exception 'TEST FAILED: duplicate IN accepted';
  exception when unique_violation then null; end;

  -- 2. The same token cannot create a second event.
  begin
    insert into attendance_events (employee_id, campus_id, event_type, work_date, punctuality, source, token_id)
      values (emp, cam, 'OUT', current_date, 'NOT_APPLICABLE', 'WHATSAPP_LINK', tok);
    raise exception 'TEST FAILED: token reused for a second event';
  exception when unique_violation then null; end;

  -- 3. The original time cannot be edited.
  begin
    update attendance_events set server_ts = server_ts + interval '1 hour' where id = ev;
    raise exception 'TEST FAILED: event time was editable';
  exception when raise_exception then
    if sqlerrm like 'TEST FAILED%' then raise; end if;
  end;

  -- 4. An event cannot be deleted.
  begin
    delete from attendance_events where id = ev;
    raise exception 'TEST FAILED: event was deletable';
  exception when raise_exception then
    if sqlerrm like 'TEST FAILED%' then raise; end if;
  end;

  -- 5. Review fields CAN change.
  update attendance_events set review_status = 'APPROVED', reviewed_by = usr, reviewed_at = now() where id = ev;

  -- 6. A manual event needs a reason.
  begin
    insert into attendance_events (employee_id, campus_id, event_type, work_date, punctuality, source, recorded_by)
      values (emp, cam, 'OUT', current_date, 'NOT_APPLICABLE', 'MANUAL', usr);
    raise exception 'TEST FAILED: manual event without reason accepted';
  exception when check_violation then null; end;

  -- 7. An adjustment needs a reason, and cannot be edited or deleted.
  begin
    insert into attendance_adjustments (employee_id, work_date, field, new_value, reason, adjusted_by)
      values (emp, current_date, 'IN_TIME', '{}'::jsonb, '   ', usr);
    raise exception 'TEST FAILED: adjustment without reason accepted';
  exception when check_violation then null; end;

  insert into attendance_adjustments (employee_id, work_date, event_id, field, new_value, reason, adjusted_by)
    values (emp, current_date, ev, 'IN_TIME', '{"time":"09:05"}'::jsonb, 'test reason', usr);
  begin
    update attendance_adjustments set reason = 'changed' where employee_id = emp and work_date = current_date;
    raise exception 'TEST FAILED: adjustment was editable';
  exception when raise_exception then
    if sqlerrm like 'TEST FAILED%' then raise; end if;
  end;

  -- 8. Only one MISSING_OUT exception per employee per day.
  insert into attendance_exceptions (employee_id, campus_id, work_date, kind)
    values (emp, cam, current_date, 'MISSING_OUT');
  begin
    insert into attendance_exceptions (employee_id, campus_id, work_date, kind)
      values (emp, cam, current_date, 'MISSING_OUT');
    raise exception 'TEST FAILED: duplicate MISSING_OUT accepted';
  exception when unique_violation then null; end;
end $$;

rollback;
