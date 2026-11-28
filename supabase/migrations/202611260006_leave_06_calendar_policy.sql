-- Leave module, migration 06: academic years, holidays, leave types, policy and allocations.
-- ADDITIVE ONLY: new tables, one new column on my own attendance_employees table, and seed rows
-- for the four leave types. No payroll, payslip, employee or user table is altered.
-- Requires migrations 01 to 05. Apply to the TEST Supabase project only (kcpaqvuburgehzrdtygk).
-- Idempotent: safe to run twice.

begin;

-- 1. Academic years. They are also the leave years, defined by you in the app each year. -----
create table if not exists academic_years (
  id          serial primary key,
  label       text not null unique,                       -- e.g. '2026-27'
  start_date  date not null,
  end_date    date not null,
  created_at  timestamptz not null default now(),
  created_by  integer references users(id) on delete set null,
  constraint academic_years_dates_ok check (end_date > start_date),
  -- Two academic years may never overlap.
  constraint academic_years_no_overlap exclude using gist (daterange(start_date, end_date, '[]') with &&)
);

-- 2. Holidays. Nothing counts until it is CONFIRMED by an admin. -------------------------------
--    kind:  HOLIDAY             a closure for all staff
--           VACATION            a school vacation; staff flagged "reports during vacations" still work
--           WEEKLY_OFF          e.g. a second Saturday; closure for all staff
--           OPTIONAL            informational only; never a closure
--           SPECIAL_WORKING_DAY a normally-off day that is worked
create table if not exists holidays (
  id               serial primary key,
  academic_year_id integer not null references academic_years(id) on delete restrict,
  campus_id        integer references campuses(id) on delete cascade,    -- null = every campus
  name             text not null check (nullif(btrim(name), '') is not null),
  kind             text not null check (kind in ('HOLIDAY','VACATION','WEEKLY_OFF','OPTIONAL','SPECIAL_WORKING_DAY')),
  start_date       date not null,
  end_date         date not null,
  status           text not null default 'DRAFT' check (status in ('DRAFT', 'CONFIRMED')),
  source           text,                                                 -- where the date came from
  confirmed_by     integer references users(id) on delete set null,
  confirmed_at     timestamptz,
  created_at       timestamptz not null default now(),
  created_by       integer references users(id) on delete set null,
  constraint holidays_dates_ok check (end_date >= start_date),
  constraint holidays_confirmed_ok check (status = 'DRAFT' or confirmed_at is not null)
);
create unique index if not exists holidays_unique_idx
  on holidays (academic_year_id, coalesce(campus_id, 0), start_date, end_date, name);
create index if not exists holidays_lookup_idx on holidays (academic_year_id, start_date, end_date);

-- A holiday must fall inside its academic year.
create or replace function holidays_in_year_guard() returns trigger
language plpgsql set search_path = public as $$
declare y academic_years%rowtype;
begin
  select * into y from academic_years where id = new.academic_year_id;
  if new.start_date < y.start_date or new.end_date > y.end_date then
    raise exception 'holiday % (% to %) is outside academic year % (% to %)',
      new.name, new.start_date, new.end_date, y.label, y.start_date, y.end_date;
  end if;
  return new;
end $$;

drop trigger if exists holidays_in_year_guard_trg on holidays;
create trigger holidays_in_year_guard_trg
  before insert or update on holidays
  for each row execute function holidays_in_year_guard();

-- 3. Some staff report during school vacations (my own table, additive column). ----------------
alter table attendance_employees
  add column if not exists reports_during_vacations boolean not null default false;

-- 4. Leave types ---------------------------------------------------------------------------------
create table if not exists leave_types (
  id             serial primary key,
  code           text not null unique,
  name           text not null,
  is_paid        boolean not null default true,
  tracks_balance boolean not null default true,        -- false: no balance, never runs out (unpaid leave)
  is_active      boolean not null default true,
  sort_order     integer not null default 0
);

insert into leave_types (code, name, is_paid, tracks_balance, sort_order) values
  ('CASUAL', 'Casual Leave', true,  true,  1),
  ('SICK',   'Sick Leave',   true,  true,  2),
  ('EARNED', 'Earned Leave', true,  true,  3),
  ('UNPAID', 'Unpaid Leave', false, false, 4)
on conflict (code) do nothing;

-- 5. Leave policy: one row per leave type per academic year, edited by admins in the app. -------
--    Defaults are deliberately inert: nothing is credited until you set it.
create table if not exists leave_policies (
  id                       serial primary key,
  leave_type_id            integer not null references leave_types(id) on delete restrict,
  academic_year_id         integer not null references academic_years(id) on delete restrict,
  credit_mode              text not null default 'MANUAL' check (credit_mode in ('UPFRONT', 'MONTHLY', 'MANUAL')),
  default_annual_days      numeric(5,1) not null default 0 check (default_annual_days >= 0),
  carry_forward_mode       text not null default 'NONE' check (carry_forward_mode in ('NONE', 'LIMIT', 'ALL')),
  carry_forward_limit      numeric(5,1) check (carry_forward_limit is null or carry_forward_limit >= 0),
  encashment_allowed       boolean not null default false,
  encashment_limit_days    numeric(5,1) check (encashment_limit_days is null or encashment_limit_days >= 0),
  insufficient_balance     text not null default 'LOP' check (insufficient_balance in ('REJECT', 'LOP', 'NEGATIVE')),
  allow_half_day           boolean not null default true,
  min_notice_days          integer not null default 0 check (min_notice_days >= 0),
  max_consecutive_days     integer check (max_consecutive_days is null or max_consecutive_days > 0),
  updated_at               timestamptz not null default now(),
  updated_by               integer references users(id) on delete set null,
  constraint leave_policies_unique unique (leave_type_id, academic_year_id),
  constraint leave_policies_limit_ok check (carry_forward_mode <> 'LIMIT' or carry_forward_limit is not null)
);

-- 6. Leave allocation per employee, per leave type, per academic year. ------------------------
--    The *_override columns let one employee differ from the policy (null = use the policy).
create table if not exists leave_allocations (
  id                     serial primary key,
  employee_id            integer not null references employees(id) on delete restrict,
  leave_type_id          integer not null references leave_types(id) on delete restrict,
  academic_year_id       integer not null references academic_years(id) on delete restrict,
  annual_days            numeric(5,1) not null default 0 check (annual_days >= 0),
  credit_mode_override   text check (credit_mode_override in ('UPFRONT', 'MONTHLY', 'MANUAL')),
  carry_forward_override text check (carry_forward_override in ('NONE', 'LIMIT', 'ALL')),
  carry_forward_limit_override numeric(5,1) check (carry_forward_limit_override is null or carry_forward_limit_override >= 0),
  updated_at             timestamptz not null default now(),
  updated_by             integer references users(id) on delete set null,
  constraint leave_allocations_unique unique (employee_id, leave_type_id, academic_year_id),
  constraint leave_allocations_limit_ok check (carry_forward_override <> 'LIMIT' or carry_forward_limit_override is not null)
);
create index if not exists leave_allocations_year_idx on leave_allocations (academic_year_id, leave_type_id);

-- 7. Row Level Security: no browser access. -----------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['academic_years', 'holidays', 'leave_types', 'leave_policies', 'leave_allocations'] loop
    execute format('alter table %I enable row level security', t);
    execute format('revoke all on table %I from anon, authenticated', t);
    execute format('drop policy if exists "no browser access" on %I', t);
    execute format(
      'create policy "no browser access" on %I for all to anon, authenticated using (false) with check (false)', t);
  end loop;
end $$;

revoke all on sequence academic_years_id_seq    from anon, authenticated;
revoke all on sequence holidays_id_seq          from anon, authenticated;
revoke all on sequence leave_types_id_seq       from anon, authenticated;
revoke all on sequence leave_policies_id_seq    from anon, authenticated;
revoke all on sequence leave_allocations_id_seq from anon, authenticated;

commit;
