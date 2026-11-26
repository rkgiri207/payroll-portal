-- Behaviour checks for migration 04. Leaves NO data behind (everything is rolled back).
-- Run on the TEST project after applying migration 04.
-- "Success. No rows returned." = every check passed. Any error message = a check failed.

begin;

do $$
declare aid bigint; is_public boolean; n int;
begin
  -- 1. An audit entry can be written.
  insert into attendance_audit_log (actor_type, action, entity_type, entity_id, reason)
    values ('SYSTEM', 'TEST_ENTRY', 'test', '1', 'check') returning id into aid;

  -- 2. An audit entry cannot be edited.
  begin
    update attendance_audit_log set reason = 'changed' where id = aid;
    raise exception 'TEST FAILED: audit entry was editable';
  exception when raise_exception then
    if sqlerrm like 'TEST FAILED%' then raise; end if;
  end;

  -- 3. An audit entry cannot be deleted.
  begin
    delete from attendance_audit_log where id = aid;
    raise exception 'TEST FAILED: audit entry was deletable';
  exception when raise_exception then
    if sqlerrm like 'TEST FAILED%' then raise; end if;
  end;

  -- 4. An audit entry needs an action.
  begin
    insert into attendance_audit_log (actor_type, action) values ('SYSTEM', '  ');
    raise exception 'TEST FAILED: blank action accepted';
  exception when check_violation then null; end;

  -- 5. The selfie bucket exists and is PRIVATE.
  select count(*) into n from storage.buckets where id = 'attendance-selfies';
  if n <> 1 then raise exception 'TEST FAILED: attendance-selfies bucket is missing'; end if;
  select public into is_public from storage.buckets where id = 'attendance-selfies';
  if is_public then raise exception 'TEST FAILED: attendance-selfies bucket is PUBLIC'; end if;
end $$;

rollback;
