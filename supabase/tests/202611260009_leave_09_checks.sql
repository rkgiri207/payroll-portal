-- Behaviour checks for migration 09. Leaves NO data behind (everything is rolled back).
-- Run on the TEST project after applying migration 09.
-- "Success. No rows returned." = every check passed. Any error message = a check failed.

begin;

do $$
declare k text; n int := 0;
begin
  -- The four new kinds are accepted.
  foreach k in array array['LEAVE_INFO', 'LEAVE_DECISION', 'PERMISSION_DECISION', 'DIRECTOR_INFO'] loop
    insert into notification_outbox (recipient_type, recipient_e164, kind, delivery_mode, payload, idempotency_key)
      values ('EMPLOYEE', '919000000001', k, 'TEXT', '{"body":"x"}'::jsonb, 'zz-kind-' || k);
    n := n + 1;
  end loop;
  if n <> 4 then raise exception 'TEST FAILED: expected 4 new kinds accepted'; end if;

  -- Every kind that existed before is still accepted.
  foreach k in array array['LINK','CHECKIN_CONFIRM','CHECKOUT_CONFIRM','FAILED_VERIFICATION','TOKEN_LOCKED','HELP','COMING_SOON',
      'CAMPUS_CHOICE','DIRECTOR_CHECKIN','DIRECTOR_CHECKOUT','DIRECTOR_LATE','DIRECTOR_EXCEPTION','DIRECTOR_MISSING_OUT',
      'DIRECTOR_DIGEST','DIRECTOR_LEAVE_REQUEST','DIRECTOR_PERMISSION_REQUEST'] loop
    insert into notification_outbox (recipient_type, recipient_e164, kind, delivery_mode, payload, idempotency_key)
      values ('DIRECTOR', '919000000001', k, 'TEXT', '{"body":"x"}'::jsonb, 'zz-old-' || k);
  end loop;

  -- An unknown kind is still refused.
  begin
    insert into notification_outbox (recipient_type, recipient_e164, kind, delivery_mode, payload, idempotency_key)
      values ('EMPLOYEE', '919000000001', 'SOMETHING_ELSE', 'TEXT', '{"body":"x"}'::jsonb, 'zz-kind-bad');
    raise exception 'TEST FAILED: an unknown message kind was accepted';
  exception when check_violation then null; end;
end $$;

rollback;
