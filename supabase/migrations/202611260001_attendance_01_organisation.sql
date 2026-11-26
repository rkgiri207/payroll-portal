-- Attendance module, migration 01: organisation and configuration.
-- ADDITIVE ONLY: creates new tables; no existing table or type is altered.
-- Apply to the TEST Supabase project only (ref kcpaqvuburgehzrdtygk) after approval.
-- Idempotent: safe to run twice.
-- Weekday numbers follow Postgres/JavaScript: 0 = Sunday ... 6 = Saturday.

begin;

-- 1. Attendance roles --------------------------------------------------------
-- Maps an existing portal login (users.id) to DIRECTOR or ADMIN for attendance.
-- Until a row exists the API treats an existing ADMIN login as DIRECTOR.
create table if not exists attendance_roles (
  user_id     integer primary key references users(id) on delete cascade,
  role        text not null check (role in ('DIRECTOR', 'ADMIN')),
  created_at  timestamptz not null default now(),
  created_by  integer references users(id) on delete set null
);

-- 2. Settings (every tunable value lives here, editable from the app) --------
create table if not exists attendance_settings (
  key          text primary key,
  value        jsonb not null,
  description  text,
  updated_at   timestamptz not null default now(),
  updated_by   integer references users(id) on delete set null
);

insert into attendance_settings (key, value, description) values
  ('default_grace_minutes',      '10'::jsonb,          'Default grace minutes offered when creating a campus shift'),
  ('default_geofence_radius_m',  '25'::jsonb,          'Default geofence radius in metres for new campuses'),
  ('required_gps_accuracy_m',    '10'::jsonb,          'Maximum acceptable reported GPS accuracy in metres (campus can override)'),
  ('token_ttl_minutes',          '5'::jsonb,           'Attendance link lifetime in minutes'),
  ('max_failed_attempts',        '3'::jsonb,           'Failed location attempts before a link is locked'),
  ('missing_out_after_minutes',  '60'::jsonb,          'Minutes after campus logout time before a missing OUT exception is raised'),
  ('selfie_retention_days',      '90'::jsonb,          'Days before selfies become eligible for deletion (deletion job is design-only in Phase 1)'),
  ('director_whatsapp_e164',     'null'::jsonb,        'Director WhatsApp number, digits with country code, e.g. 919876543210'),
  ('alert_mode',                 '"individual"'::jsonb,'Director alert mode: individual | digest | mute_normal'),
  ('digest_interval_minutes',    '60'::jsonb,          'Digest interval in minutes when alert_mode = digest'),
  ('attendance_link_base_url',   '""'::jsonb,          'Public base URL for attendance links; empty = use APP_BASE_URL'),
  ('whatsapp_template_language', '"en"'::jsonb,        'Language code for approved Director alert templates'),
  ('template_checkin',           '"attendance_checkin"'::jsonb,      'Approved template name: check-in alert'),
  ('template_checkout',          '"attendance_checkout"'::jsonb,     'Approved template name: check-out alert'),
  ('template_late',              '"attendance_late"'::jsonb,         'Approved template name: late alert'),
  ('template_exception',         '"attendance_exception"'::jsonb,    'Approved template name: exception alert'),
  ('template_missing_out',       '"attendance_missing_out"'::jsonb,  'Approved template name: missing OUT alert')
on conflict (key) do nothing;

-- 3. Campuses ----------------------------------------------------------------
create table if not exists campuses (
  id                  serial primary key,
  code                text not null unique,
  name                text not null,
  address             text,
  latitude            numeric(9, 6) check (latitude  between -90  and 90),
  longitude           numeric(9, 6) check (longitude between -180 and 180),
  geofence_radius_m   integer not null default 25 check (geofence_radius_m > 0),
  required_accuracy_m integer check (required_accuracy_m > 0),   -- null = use global setting
  is_active           boolean not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- 4. Campus shifts (effective-dated; past events keep their own snapshot) -----
create table if not exists campus_shifts (
  id              serial primary key,
  campus_id       integer not null references campuses(id) on delete cascade,
  login_time      time not null,
  logout_time     time not null,
  grace_minutes   integer not null default 10 check (grace_minutes >= 0),
  weekdays        smallint[] not null,
  effective_from  date not null,
  created_at      timestamptz not null default now(),
  created_by      integer references users(id) on delete set null,
  constraint campus_shifts_times_ok check (logout_time > login_time),
  constraint campus_shifts_weekdays_ok
    check (cardinality(weekdays) > 0 and weekdays <@ array[0,1,2,3,4,5,6]::smallint[])
);
create unique index if not exists campus_shifts_unique_idx
  on campus_shifts (campus_id, effective_from, weekdays);
create index if not exists campus_shifts_lookup_idx
  on campus_shifts (campus_id, effective_from desc);

-- 5. Employee attendance registration (references the EXISTING employees table)
create table if not exists attendance_employees (
  employee_id          integer primary key references employees(id) on delete restrict,
  whatsapp_e164        text unique check (whatsapp_e164 ~ '^[1-9][0-9]{7,14}$'),
  attendance_applicable boolean not null default true,
  registered_at        timestamptz,
  registered_by        integer references users(id) on delete set null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

-- 6. Campus assignments (primary + temporary duty) ---------------------------
create table if not exists employee_campus_assignments (
  id           serial primary key,
  employee_id  integer not null references employees(id) on delete restrict,
  campus_id    integer not null references campuses(id) on delete restrict,
  kind         text not null check (kind in ('PRIMARY', 'TEMPORARY')),
  mode         text not null default 'REPLACE' check (mode in ('REPLACE', 'ADDITIONAL')),
  start_date   date not null,
  end_date     date,
  note         text,
  created_at   timestamptz not null default now(),
  created_by   integer references users(id) on delete set null,
  constraint eca_dates_ok check (end_date is null or end_date >= start_date),
  constraint eca_temp_needs_end check (kind = 'PRIMARY' or end_date is not null),
  constraint eca_mode_only_temp check (kind = 'TEMPORARY' or mode = 'REPLACE')
);
-- At most one open-ended primary campus per employee.
create unique index if not exists eca_one_open_primary_idx
  on employee_campus_assignments (employee_id)
  where kind = 'PRIMARY' and end_date is null;
create index if not exists eca_employee_idx on employee_campus_assignments (employee_id, start_date);
create index if not exists eca_campus_idx   on employee_campus_assignments (campus_id);

-- 7. Row Level Security: no browser access. The API uses a server-side database
--    connection; browsers (anon/authenticated roles) get nothing.
do $$
declare t text;
begin
  foreach t in array array[
    'attendance_roles', 'attendance_settings', 'campuses', 'campus_shifts',
    'attendance_employees', 'employee_campus_assignments'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format('revoke all on table %I from anon, authenticated', t);
    execute format('drop policy if exists "no browser access" on %I', t);
    execute format(
      'create policy "no browser access" on %I for all to anon, authenticated using (false) with check (false)', t);
  end loop;
end $$;

revoke all on sequence campuses_id_seq                      from anon, authenticated;
revoke all on sequence campus_shifts_id_seq                 from anon, authenticated;
revoke all on sequence employee_campus_assignments_id_seq   from anon, authenticated;

commit;

-- VERIFY (run after applying; all should return the stated result):
--   select count(*) from information_schema.tables
--     where table_schema='public' and table_name in
--     ('attendance_roles','attendance_settings','campuses','campus_shifts',
--      'attendance_employees','employee_campus_assignments');            -- expect 6
--   select tablename, rowsecurity from pg_tables
--     where schemaname='public' and tablename in
--     ('attendance_roles','attendance_settings','campuses','campus_shifts',
--      'attendance_employees','employee_campus_assignments');            -- all rowsecurity = true
--   select count(*) from attendance_settings;                            -- expect 17
