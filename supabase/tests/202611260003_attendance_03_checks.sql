-- Behaviour checks for migration 03. Leaves NO data behind (everything is rolled back).
-- Run on the TEST project after applying migration 03.
-- "Success. No rows returned." = every check passed. Any error message = a check failed.

begin;

do $$
declare ob uuid; n int;
begin
  -- 1. The same webhook event inserted twice is stored once (duplicate protection).
  insert into whatsapp_webhook_events (event_key, kind) values ('msg:zz-test-1', 'MESSAGE')
    on conflict (event_key) do nothing;
  insert into whatsapp_webhook_events (event_key, kind) values ('msg:zz-test-1', 'MESSAGE')
    on conflict (event_key) do nothing;
  select count(*) into n from whatsapp_webhook_events where event_key = 'msg:zz-test-1';
  if n <> 1 then raise exception 'TEST FAILED: duplicate webhook event stored % times', n; end if;

  -- 2. A TEMPLATE message must name its template.
  begin
    insert into notification_outbox (recipient_type, recipient_e164, kind, delivery_mode, payload, idempotency_key)
      values ('DIRECTOR', '910000000000', 'DIRECTOR_CHECKIN', 'TEMPLATE', '{}'::jsonb, 'zz-test-no-template');
    raise exception 'TEST FAILED: TEMPLATE message without a template name accepted';
  exception when check_violation then null; end;

  -- 3. A valid message is stored.
  insert into notification_outbox (recipient_type, recipient_e164, kind, delivery_mode,
                                   template_name, template_language, payload, idempotency_key)
    values ('DIRECTOR', '910000000000', 'DIRECTOR_CHECKIN', 'TEMPLATE',
            'attendance_checkin', 'en', '{"x":1}'::jsonb, 'zz-test-key')
    returning id into ob;

  -- 4. The same idempotency key cannot be queued twice.
  begin
    insert into notification_outbox (recipient_type, recipient_e164, kind, delivery_mode,
                                     template_name, payload, idempotency_key)
      values ('DIRECTOR', '910000000000', 'DIRECTOR_CHECKIN', 'TEMPLATE',
              'attendance_checkin', '{}'::jsonb, 'zz-test-key');
    raise exception 'TEST FAILED: duplicate idempotency key accepted';
  exception when unique_violation then null; end;

  -- 5. An invalid status is rejected.
  begin
    update notification_outbox set status = 'BOGUS' where id = ob;
    raise exception 'TEST FAILED: invalid status accepted';
  exception when check_violation then null; end;

  -- 6. The delivery log accepts a history row for the message.
  insert into notification_delivery_log (outbox_id, status, detail) values (ob, 'STUBBED', 'test');
end $$;

rollback;
