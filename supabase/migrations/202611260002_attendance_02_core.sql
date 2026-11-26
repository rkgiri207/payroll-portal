-- Attendance module, migration 02: core attendance tables.
-- ADDITIVE ONLY: new tables and two new functions; no existing object is altered.
-- Requires migration 01. Apply to the TEST Supabase project only (kcpaqvuburgehzrdtygk).
-- Idempotent: safe to run twice.

begin;

-- 1. One-time attendance links (only a hash of the token is stored) ----------
create table if not exists attendance_tokens (
  id                   uuid primary key default gen_random_uuid(),
  token_hash           text not null unique,
  employee_id          integer not null references employees(id) on delete restrict,
  campus_id            integer not null references campuses(id) on delete restrict,
  event_type           text not null check (event_type in ('IN', 'OUT')),
  work_date            date not null,
  created_at           timestamptz not null default now(),
  expires_at           timestamptz not null,
  location_verified_at timestamptz,          -- set when step 1 (location) passed
  used_at              timestamptz,          -- set when the event is recorded (single use)
  failed_attempts      integer not null default 0 check (failed_attempts >= 0),
  locked_at            timestamptz,
  source_message_id    text                  -- WhatsApp message ID that requested the link
);
create unique index if not exists attendance_tokens_msg_idx
  on attendance_tokens (source_message_id) where source_message_id is not null;
create index if not exists attendance_tokens_employee_idx on attendance_tokens (employee_id, created_at desc);
create index if not exists attendance_tokens_expiry_idx   on attendance_tokens (expires_at);

-- 2. Every location attempt, with reported coordinates and accuracy ----------
create table if not exists attendance_attempts (
  id            bigserial primary key,
  token_id      uuid not null references attendance_tokens(id) on delete cascade,
  employee_id   integer not null references employees(id) on delete restrict,
  campus_id     integer not null references campuses(id) on delete restrict,
  attempted_at  timestamptz not null default now(),
  reported_lat  numeric(9, 6),
  reported_lng  numeric(9, 6),
  accuracy_m    numeric(8, 2),
  distance_m    numeric(10, 2),
  result        text not null check (result in
                  ('PASSED','OUTSIDE_RADIUS','POOR_ACCURACY','NO_LOCATION','TOKEN_LOCKED',
                   'TOKEN_EXPIRED','TOKEN_USED','CAMPUS_NOT_ALLOWED','ERROR')),
  reason        text,
  user_agent    text
);
create index if not exists attendance_attempts_token_idx    on attendance_attempts (token_id);
create index if not exists attendance_attempts_employee_idx on attendance_attempts (employee_id, attempted_at desc);

-- 3. Attendance events: append-only record of each IN and OUT -----------------
create table if not exists attendance_events (
  id                   uuid primary key default gen_random_uuid(),
  employee_id          integer not null references employees(id) on delete restrict,
  campus_id            integer not null references campuses(id) on delete restrict,
  event_type           text not null check (event_type in ('IN', 'OUT')),
  work_date            date not null,                          -- IST calendar date
  server_ts            timestamptz not null default now(),     -- server time only
  punctuality          text not null check (punctuality in ('ON_TIME','LATE','NO_SHIFT','NOT_APPLICABLE')),
  late_minutes         integer check (late_minutes is null or late_minutes > 0),
  shift_login_time     time,                                   -- snapshot of the shift used
  shift_logout_time    time,
  shift_grace_minutes  integer,
  gps_lat              numeric(9, 6),
  gps_lng              numeric(9, 6),
  gps_accuracy_m       numeric(8, 2),
  gps_distance_m       numeric(10, 2),
  gps_result           text check (gps_result in ('PASSED', 'MANUAL')),
  selfie_path          text,                                   -- private bucket path, never a public URL
  selfie_deleted_at    timestamptz,                            -- set by the retention job
  review_status        text not null default 'PENDING'
                         check (review_status in ('PENDING','APPROVED','REJECTED','NOT_REQUIRED')),
  reviewed_by          integer references users(id) on delete set null,
  reviewed_at          timestamptz,
  review_note          text,
  face_match_status    text,                                   -- reserved for future face matching
  face_match_score     numeric(5, 4),                          -- reserved for future face matching
  source               text not null default 'WHATSAPP_LINK' check (source in ('WHATSAPP_LINK','MANUAL')),
  token_id             uuid unique references attendance_tokens(id) on delete restrict,
  manual_reason        text,
  recorded_by          integer references users(id) on delete set null,
  is_valid             boolean not null default true,
  created_at           timestamptz not null default now(),
  constraint attendance_events_manual_ok
    check (source <> 'MANUAL' or (nullif(btrim(manual_reason), '') is not null and recorded_by is not null))
);
-- One valid IN and one valid OUT per employee per working day.
create unique index if not exists attendance_events_one_valid_idx
  on attendance_events (employee_id, work_date, event_type) where is_valid;
create index if not exists attendance_events_day_idx      on attendance_events (work_date, campus_id);
create index if not exists attendance_events_employee_idx on attendance_events (employee_id, work_date desc);
create index if not exists attendance_events_review_idx   on attendance_events (review_status) where review_status = 'PENDING';

-- 4. Exceptions (GPS failures, missing OUT, ...) -------------------------------
create table if not exists attendance_exceptions (
  id               uuid primary key default gen_random_uuid(),
  employee_id      integer not null references employees(id) on delete restrict,
  campus_id        integer references campuses(id) on delete restrict,
  work_date        date not null,
  event_id         uuid references attendance_events(id) on delete restrict,
  token_id         uuid references attendance_tokens(id) on delete set null,
  kind             text not null check (kind in
                     ('GPS_OUTSIDE_RADIUS','POOR_ACCURACY','TOKEN_LOCKED','MISSING_OUT',
                      'NO_SHIFT','OUTSIDE_WORKING_DAY','SUSPICIOUS','OTHER')),
  detail           text,
  status           text not null default 'OPEN' check (status in ('OPEN','REVIEWED','RESOLVED')),
  created_at       timestamptz not null default now(),
  resolved_by      integer references users(id) on delete set null,
  resolved_at      timestamptz,
  resolution_note  text,
  constraint attendance_exceptions_resolved_ok
    check (status = 'OPEN' or (resolved_by is not null and resolved_at is not null))
);
-- Only one MISSING_OUT exception per employee per day.
create unique index if not exists attendance_exceptions_missing_out_idx
  on attendance_exceptions (employee_id, work_date) where kind = 'MISSING_OUT';
create index if not exists attendance_exceptions_status_idx   on attendance_exceptions (status, created_at desc);
create index if not exists attendance_exceptions_employee_idx on attendance_exceptions (employee_id, work_date);

-- 5. Adjustments: later admin corrections are stored here, originals stay -----
create table if not exists attendance_adjustments (
  id           uuid primary key default gen_random_uuid(),
  employee_id  integer not null references employees(id) on delete restrict,
  work_date    date not null,
  event_id     uuid references attendance_events(id) on delete restrict,
  field        text not null check (field in
                 ('IN_TIME','OUT_TIME','STATUS','CAMPUS','ADD_DAY','VOID_EVENT','RESOLVE_EXCEPTION')),
  old_value    jsonb,
  new_value    jsonb not null,
  reason       text not null check (nullif(btrim(reason), '') is not null),
  adjusted_by  integer not null references users(id) on delete restrict,
  created_at   timestamptz not null default now()
);
create index if not exists attendance_adjustments_employee_idx on attendance_adjustments (employee_id, work_date);

-- 6. Immutability guards (database-level, not just application rules) ---------
create or replace function attendance_block_mutation() returns trigger
language plpgsql set search_path = public as $$
begin
  raise exception '% rows are append-only and cannot be %d', tg_table_name, lower(tg_op);
end $$;

create or replace function attendance_events_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'attendance_events rows cannot be deleted; record an adjustment instead';
  end if;
  -- Core facts are frozen. Only review fields, face-match fields, is_valid and
  -- selfie removal (retention job) may change.
  if (new.employee_id, new.campus_id, new.event_type, new.work_date, new.server_ts,
      new.punctuality, new.late_minutes, new.shift_login_time, new.shift_logout_time,
      new.shift_grace_minutes, new.gps_lat, new.gps_lng, new.gps_accuracy_m,
      new.gps_distance_m, new.gps_result, new.source, new.token_id,
      new.manual_reason, new.recorded_by, new.created_at)
     is distinct from
     (old.employee_id, old.campus_id, old.event_type, old.work_date, old.server_ts,
      old.punctuality, old.late_minutes, old.shift_login_time, old.shift_logout_time,
      old.shift_grace_minutes, old.gps_lat, old.gps_lng, old.gps_accuracy_m,
      old.gps_distance_m, old.gps_result, old.source, old.token_id,
      old.manual_reason, old.recorded_by, old.created_at)
     or (new.selfie_path is distinct from old.selfie_path and new.selfie_path is not null)
  then
    raise exception 'attendance_events are append-only; record an adjustment instead';
  end if;
  return new;
end $$;

drop trigger if exists attendance_events_guard_trg on attendance_events;
create trigger attendance_events_guard_trg
  before update or delete on attendance_events
  for each row execute function attendance_events_guard();

drop trigger if exists attendance_adjustments_guard_trg on attendance_adjustments;
create trigger attendance_adjustments_guard_trg
  before update or delete on attendance_adjustments
  for each row execute function attendance_block_mutation();

-- 7. Row Level Security: no browser access --------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'attendance_tokens', 'attendance_attempts', 'attendance_events',
    'attendance_exceptions', 'attendance_adjustments'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format('revoke all on table %I from anon, authenticated', t);
    execute format('drop policy if exists "no browser access" on %I', t);
    execute format(
      'create policy "no browser access" on %I for all to anon, authenticated using (false) with check (false)', t);
  end loop;
end $$;

revoke all on sequence attendance_attempts_id_seq from anon, authenticated;

commit;
