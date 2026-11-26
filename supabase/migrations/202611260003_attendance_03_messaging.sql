-- Attendance module, migration 03: WhatsApp messaging tables.
-- ADDITIVE ONLY: three new tables; no existing object is altered.
-- Requires migrations 01 and 02. Apply to the TEST Supabase project only (kcpaqvuburgehzrdtygk).
-- Idempotent: safe to run twice.
-- Privacy: message bodies from employees are NOT stored (only the parsed command);
-- phone numbers in the webhook log are masked; the application must clear the link URL
-- from an outbox payload once that message is sent.

begin;

-- 1. Inbound webhook events: duplicate protection and an audit trail ----------
-- event_key examples:  msg:<wamid>   status:<wamid>:<status>
-- The webhook inserts with ON CONFLICT DO NOTHING; no row inserted = duplicate, ignore it.
create table if not exists whatsapp_webhook_events (
  event_key     text primary key,
  kind          text not null check (kind in ('MESSAGE', 'STATUS')),
  received_at   timestamptz not null default now(),
  from_masked   text,                          -- e.g. '******3605' (never the full number)
  command       text,                          -- IN | OUT | HELP | LEAVE | PERMISSION | BALANCE | null
  employee_id   integer references employees(id) on delete set null,
  outcome       text not null default 'RECEIVED' check (outcome in
                  ('RECEIVED','REPLIED','IGNORED_UNREGISTERED','IGNORED_GROUP',
                   'IGNORED_NOT_COMMAND','IGNORED_NOT_TEXT','STATUS_APPLIED','ERROR')),
  detail        text
);
create index if not exists whatsapp_webhook_events_received_idx on whatsapp_webhook_events (received_at desc);

-- 2. Notification outbox: every outbound WhatsApp message goes through here -----
create table if not exists notification_outbox (
  id                uuid primary key default gen_random_uuid(),
  recipient_type    text not null check (recipient_type in ('DIRECTOR', 'EMPLOYEE')),
  recipient_e164    text not null,
  employee_id       integer references employees(id) on delete set null,  -- the employee the message is about
  event_id          uuid references attendance_events(id) on delete set null,
  exception_id      uuid references attendance_exceptions(id) on delete set null,
  kind              text not null check (kind in
                      ('LINK','CHECKIN_CONFIRM','CHECKOUT_CONFIRM','FAILED_VERIFICATION','TOKEN_LOCKED',
                       'HELP','COMING_SOON','CAMPUS_CHOICE',
                       'DIRECTOR_CHECKIN','DIRECTOR_CHECKOUT','DIRECTOR_LATE','DIRECTOR_EXCEPTION',
                       'DIRECTOR_MISSING_OUT','DIRECTOR_DIGEST',
                       'DIRECTOR_LEAVE_REQUEST','DIRECTOR_PERMISSION_REQUEST')),
  delivery_mode     text not null check (delivery_mode in ('TEXT', 'TEMPLATE')),
  template_name     text,
  template_language text,
  payload           jsonb not null,            -- text body or template parameters. Never selfies.
  idempotency_key   text not null unique,
  status            text not null default 'QUEUED' check (status in
                      ('QUEUED','SENDING','SENT','DELIVERED','READ','FAILED','STUBBED','CANCELLED')),
  attempts          integer not null default 0 check (attempts >= 0),
  max_attempts      integer not null default 5 check (max_attempts > 0),
  next_attempt_at   timestamptz not null default now(),
  locked_until      timestamptz,               -- a sender holds this while sending; expires if it crashes
  last_error        text,                      -- Meta error code/message only; never tokens
  meta_message_id   text,
  created_at        timestamptz not null default now(),
  sent_at           timestamptz,
  delivered_at      timestamptz,
  updated_at        timestamptz not null default now(),
  constraint notification_outbox_template_ok
    check (delivery_mode <> 'TEMPLATE' or template_name is not null)
);
create index if not exists notification_outbox_due_idx
  on notification_outbox (next_attempt_at) where status = 'QUEUED';
create index if not exists notification_outbox_meta_idx
  on notification_outbox (meta_message_id) where meta_message_id is not null;
create index if not exists notification_outbox_created_idx on notification_outbox (created_at desc);
create index if not exists notification_outbox_failed_idx
  on notification_outbox (created_at desc) where status = 'FAILED';

-- 3. Delivery log: status history per outbound message -------------------------
create table if not exists notification_delivery_log (
  id               bigserial primary key,
  outbox_id        uuid not null references notification_outbox(id) on delete cascade,
  status           text not null check (status in
                     ('QUEUED','SENT','DELIVERED','READ','FAILED','STUBBED','RETRY')),
  detail           text,
  meta_message_id  text,
  at               timestamptz not null default now()
);
create index if not exists notification_delivery_log_outbox_idx on notification_delivery_log (outbox_id, at);

-- 4. Row Level Security: no browser access --------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'whatsapp_webhook_events', 'notification_outbox', 'notification_delivery_log'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format('revoke all on table %I from anon, authenticated', t);
    execute format('drop policy if exists "no browser access" on %I', t);
    execute format(
      'create policy "no browser access" on %I for all to anon, authenticated using (false) with check (false)', t);
  end loop;
end $$;

revoke all on sequence notification_delivery_log_id_seq from anon, authenticated;

commit;
