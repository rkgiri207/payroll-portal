-- Leave module, migration 07: leave and permission requests, the campus cap, the ledger.
-- ADDITIVE ONLY: new tables, views, functions and settings rows. Nothing existing is altered and
-- nothing in payroll or payslips is read or written.
-- Requires migrations 01 to 06. Apply to the TEST Supabase project only (kcpaqvuburgehzrdtygk).
-- Idempotent: safe to run twice.

begin;

-- 0. Who is the Director? Mirrors the portal rule: an explicit attendance role wins, otherwise an
--    active ADMIN login is the Director. Used by the database to enforce Director-only decisions.
create or replace function attendance_is_director(uid integer) returns boolean
language sql stable set search_path = public as $$
  select exists (
    select 1
      from users u
      left join attendance_roles ar on ar.user_id = u.id
     where u.id = uid
       and u.is_active
       and coalesce(ar.role, case when u.role::text = 'ADMIN' then 'DIRECTOR' end) = 'DIRECTOR');
$$;

-- 1. One-time links for the leave and permission forms (hash only, like attendance links). -----
create table if not exists form_tokens (
  id                 uuid primary key default gen_random_uuid(),
  token_hash         text not null unique,
  employee_id        integer not null references employees(id) on delete restrict,
  purpose            text not null check (purpose in ('LEAVE', 'PERMISSION')),
  created_at         timestamptz not null default now(),
  expires_at         timestamptz not null,
  used_at            timestamptz,                 -- set only when a request is ACCEPTED
  source_message_id  text
);
create unique index if not exists form_tokens_msg_idx
  on form_tokens (source_message_id) where source_message_id is not null;
create index if not exists form_tokens_employee_idx on form_tokens (employee_id, created_at desc);

-- 2. Leave requests -------------------------------------------------------------------------------
create table if not exists leave_requests (
  id                  uuid primary key default gen_random_uuid(),
  employee_id         integer not null references employees(id) on delete restrict,
  campus_id           integer not null references campuses(id) on delete restrict,   -- campus the cap counts against
  leave_type_id       integer not null references leave_types(id) on delete restrict,
  academic_year_id    integer not null references academic_years(id) on delete restrict,
  start_date          date not null,
  end_date            date not null,
  day_mode            text not null default 'FULL' check (day_mode in ('FULL', 'FIRST_HALF', 'SECOND_HALF')),
  reason              text not null check (nullif(btrim(reason), '') is not null),
  total_days          numeric(5,1) not null check (total_days > 0),     -- working days in the request
  paid_days           numeric(5,1) not null check (paid_days >= 0),     -- covered by balance
  lop_days            numeric(5,1) not null default 0 check (lop_days >= 0),  -- without pay (excess or unpaid type)
  status              text not null default 'PENDING' check (status in ('PENDING','APPROVED','REJECTED','CANCELLED')),
  submitted_via       text not null default 'WHATSAPP_LINK' check (submitted_via in ('WHATSAPP_LINK', 'MANUAL')),
  entered_by_user_id  integer references users(id) on delete set null,  -- admin who entered it, if MANUAL
  submitted_at        timestamptz not null default now(),
  decided_via         text check (decided_via in ('WEB', 'WHATSAPP', 'SYSTEM')),
  decided_by_user_id  integer references users(id) on delete set null,
  decided_at          timestamptz,
  decision_note       text,
  cancelled_at        timestamptz,
  cancelled_by        text check (cancelled_by in ('EMPLOYEE', 'DIRECTOR', 'ADMIN')),
  cancel_reason       text,
  idempotency_key     text not null unique,
  constraint leave_requests_dates_ok  check (end_date >= start_date),
  constraint leave_requests_half_ok   check (day_mode = 'FULL' or start_date = end_date),
  constraint leave_requests_split_ok  check (paid_days + lop_days = total_days)
);
create index if not exists leave_requests_status_idx   on leave_requests (status, submitted_at desc);
create index if not exists leave_requests_employee_idx on leave_requests (employee_id, start_date);
create index if not exists leave_requests_dates_idx    on leave_requests (start_date, end_date) where status in ('PENDING', 'APPROVED');

create or replace function leave_request_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'leave requests cannot be deleted; cancel them instead';
  end if;

  if tg_op = 'INSERT' then
    if not (new.status = 'PENDING' or (new.status = 'REJECTED' and new.decided_via = 'SYSTEM')) then
      raise exception 'a leave request starts as PENDING (or is rejected automatically by the system)';
    end if;
    if new.status = 'REJECTED' and nullif(btrim(coalesce(new.decision_note, '')), '') is null then
      raise exception 'an automatic rejection needs a reason';
    end if;
    return new;
  end if;

  -- UPDATE: the facts of the request are frozen.
  if (new.employee_id, new.campus_id, new.leave_type_id, new.academic_year_id, new.start_date, new.end_date,
      new.day_mode, new.reason, new.total_days, new.submitted_at, new.submitted_via, new.idempotency_key)
     is distinct from
     (old.employee_id, old.campus_id, old.leave_type_id, old.academic_year_id, old.start_date, old.end_date,
      old.day_mode, old.reason, old.total_days, old.submitted_at, old.submitted_via, old.idempotency_key) then
    raise exception 'leave request details cannot be edited';
  end if;

  -- The paid / without-pay split is fixed again at approval time, and at no other time.
  if (new.paid_days, new.lop_days) is distinct from (old.paid_days, old.lop_days)
     and not (old.status = 'PENDING' and new.status = 'APPROVED') then
    raise exception 'the paid / without-pay split can only change when a request is approved';
  end if;

  -- A decision, once made, is final.
  if old.status <> 'PENDING'
     and (new.decided_via, new.decided_by_user_id, new.decided_at, new.decision_note)
         is distinct from (old.decided_via, old.decided_by_user_id, old.decided_at, old.decision_note) then
    raise exception 'a recorded decision cannot be changed';
  end if;

  if new.status is distinct from old.status then
    if not ((old.status = 'PENDING' and new.status in ('APPROVED', 'REJECTED', 'CANCELLED'))
         or (old.status = 'APPROVED' and new.status = 'CANCELLED')) then
      raise exception 'invalid leave status change: % to %', old.status, new.status;
    end if;

    if new.status in ('APPROVED', 'REJECTED') then
      if new.decided_at is null or new.decided_via not in ('WEB', 'WHATSAPP') then
        raise exception 'a decision needs decided_at and decided_via (WEB or WHATSAPP)';
      end if;
      -- Only the Director may decide. A web decision names the Director's login, checked here.
      -- A WhatsApp decision is verified by the application against the Director's saved number.
      if new.decided_via = 'WEB' and (new.decided_by_user_id is null or not attendance_is_director(new.decided_by_user_id)) then
        raise exception 'only the Director can approve or reject leave';
      end if;
      if new.status = 'REJECTED' and nullif(btrim(coalesce(new.decision_note, '')), '') is null then
        raise exception 'rejecting needs a reason';
      end if;
    end if;

    if new.status = 'CANCELLED' and (new.cancelled_at is null or new.cancelled_by is null) then
      raise exception 'a cancellation needs cancelled_at and cancelled_by';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists leave_request_guard_trg on leave_requests;
create trigger leave_request_guard_trg
  before insert or update or delete on leave_requests
  for each row execute function leave_request_guard();

-- 3. Leave days: one row per employee per leave date. The campus cap is enforced HERE. ----------
create table if not exists leave_request_days (
  id                 bigserial primary key,
  request_id         uuid not null references leave_requests(id) on delete restrict,
  employee_id        integer not null references employees(id) on delete restrict,
  campus_id          integer not null references campuses(id) on delete restrict,
  leave_date         date not null,
  fraction           numeric(2,1) not null check (fraction in (0.5, 1.0)),
  counts_toward_cap  boolean not null default true,   -- false once rejected or cancelled
  created_at         timestamptz not null default now()
);
-- One active leave day per employee per date (no overlapping requests).
create unique index if not exists leave_request_days_employee_date_idx
  on leave_request_days (employee_id, leave_date) where counts_toward_cap;
create unique index if not exists leave_request_days_request_date_idx
  on leave_request_days (request_id, leave_date);
create index if not exists leave_request_days_cap_idx
  on leave_request_days (campus_id, leave_date) where counts_toward_cap;

-- The cap: at most N people per campus per date (setting leave_cap_per_campus_per_day, default 2).
-- Pending and approved count; rejected and cancelled do not. A per-campus-and-date lock makes
-- simultaneous submissions queue up, so the limit cannot be exceeded under concurrency.
create or replace function leave_day_cap_guard() returns trigger
language plpgsql set search_path = public as $$
declare cap integer; used integer;
begin
  if tg_op = 'DELETE' then
    raise exception 'leave day rows cannot be deleted';
  end if;

  if tg_op = 'UPDATE' then
    if (new.request_id, new.employee_id, new.campus_id, new.leave_date, new.fraction)
       is distinct from (old.request_id, old.employee_id, old.campus_id, old.leave_date, old.fraction) then
      raise exception 'leave day rows cannot be edited';
    end if;
    if new.counts_toward_cap and not old.counts_toward_cap then
      raise exception 'a released leave day cannot be re-activated; submit a new request';
    end if;
    return new;
  end if;

  if new.counts_toward_cap then
    perform pg_advisory_xact_lock(hashtextextended('leave-cap:' || new.campus_id::text || ':' || new.leave_date::text, 0));
    select coalesce((select (value #>> '{}')::integer from attendance_settings where key = 'leave_cap_per_campus_per_day'), 2)
      into cap;
    select count(*) into used
      from leave_request_days
     where campus_id = new.campus_id and leave_date = new.leave_date and counts_toward_cap;
    if used >= cap then
      raise exception 'LEAVE_CAP_EXCEEDED: campus % already has % leave applications on %', new.campus_id, used, new.leave_date
        using errcode = 'LC001';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists leave_day_cap_guard_trg on leave_request_days;
create trigger leave_day_cap_guard_trg
  before insert or update or delete on leave_request_days
  for each row execute function leave_day_cap_guard();

-- Rejecting or cancelling a request releases its capacity in the same transaction.
create or replace function leave_request_release_capacity() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.status in ('REJECTED', 'CANCELLED') and old.status is distinct from new.status then
    update leave_request_days set counts_toward_cap = false where request_id = new.id and counts_toward_cap;
  end if;
  return null;
end $$;

drop trigger if exists leave_request_release_capacity_trg on leave_requests;
create trigger leave_request_release_capacity_trg
  after update on leave_requests
  for each row execute function leave_request_release_capacity();

-- 4. The leave ledger: the only source of truth for balances. Append-only. ----------------------
--    Credits are positive, deductions negative. A balance is the SUM, never a count of requests.
create table if not exists leave_ledger (
  id                bigserial primary key,
  employee_id       integer not null references employees(id) on delete restrict,
  leave_type_id     integer not null references leave_types(id) on delete restrict,
  academic_year_id  integer not null references academic_years(id) on delete restrict,
  entry_type        text not null check (entry_type in
                      ('OPENING','CREDIT','DEDUCTION','REVERSAL','ADJUSTMENT','CARRY_FORWARD','LAPSE','ENCASHMENT')),
  amount            numeric(6,1) not null check (amount <> 0),
  effective_date    date not null,
  request_id        uuid references leave_requests(id) on delete restrict,
  period            text check (period is null or period ~ '^[0-9]{4}-[0-9]{2}$'),   -- monthly credits: 'YYYY-MM'
  reason            text,
  created_by        integer references users(id) on delete set null,
  created_at        timestamptz not null default now(),
  constraint leave_ledger_sign_ok check (
       (entry_type in ('OPENING', 'CREDIT', 'CARRY_FORWARD', 'REVERSAL') and amount > 0)
    or (entry_type in ('DEDUCTION', 'LAPSE', 'ENCASHMENT') and amount < 0)
    or entry_type = 'ADJUSTMENT'),
  constraint leave_ledger_reason_ok check (
    entry_type not in ('ADJUSTMENT', 'LAPSE', 'ENCASHMENT') or nullif(btrim(coalesce(reason, '')), '') is not null),
  constraint leave_ledger_request_ok check ((entry_type in ('DEDUCTION', 'REVERSAL')) = (request_id is not null))
);
-- A request is deducted at most once and reversed at most once.
create unique index if not exists leave_ledger_request_entry_idx
  on leave_ledger (request_id, entry_type) where request_id is not null;
-- Monthly credits and carry-forwards post once per period (safe to re-run the credit job).
create unique index if not exists leave_ledger_period_idx
  on leave_ledger (employee_id, leave_type_id, academic_year_id, entry_type, period)
  where period is not null and entry_type in ('CREDIT', 'CARRY_FORWARD');
-- One opening balance per employee, type and year.
create unique index if not exists leave_ledger_opening_idx
  on leave_ledger (employee_id, leave_type_id, academic_year_id) where entry_type = 'OPENING';
create index if not exists leave_ledger_balance_idx on leave_ledger (employee_id, leave_type_id, academic_year_id);

drop trigger if exists leave_ledger_guard_trg on leave_ledger;
create trigger leave_ledger_guard_trg
  before update or delete on leave_ledger
  for each row execute function attendance_block_mutation();

create or replace view leave_balances as
  select employee_id, leave_type_id, academic_year_id,
         sum(amount)::numeric(8,1) as balance, count(*)::integer as entries
    from leave_ledger
   group by employee_id, leave_type_id, academic_year_id;
revoke all on leave_balances from anon, authenticated;

-- 5. Permission requests (short time off). Separate from leave; no balance. --------------------
create table if not exists permission_requests (
  id                  uuid primary key default gen_random_uuid(),
  employee_id         integer not null references employees(id) on delete restrict,
  campus_id           integer not null references campuses(id) on delete restrict,
  permission_date     date not null,
  start_time          time not null,
  end_time            time not null,
  reason              text not null check (nullif(btrim(reason), '') is not null),
  status              text not null default 'PENDING' check (status in ('PENDING','APPROVED','REJECTED','CANCELLED')),
  submitted_via       text not null default 'WHATSAPP_LINK' check (submitted_via in ('WHATSAPP_LINK', 'MANUAL')),
  entered_by_user_id  integer references users(id) on delete set null,
  submitted_at        timestamptz not null default now(),
  decided_via         text check (decided_via in ('WEB', 'WHATSAPP')),
  decided_by_user_id  integer references users(id) on delete set null,
  decided_at          timestamptz,
  decision_note       text,
  cancelled_at        timestamptz,
  cancelled_by        text check (cancelled_by in ('EMPLOYEE', 'DIRECTOR', 'ADMIN')),
  cancel_reason       text,
  idempotency_key     text not null unique,
  constraint permission_requests_times_ok check (end_time > start_time)
);
create index if not exists permission_requests_status_idx   on permission_requests (status, submitted_at desc);
create index if not exists permission_requests_employee_idx on permission_requests (employee_id, permission_date);

create or replace function permission_request_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'permission requests cannot be deleted; cancel them instead';
  end if;
  if tg_op = 'INSERT' then
    if new.status <> 'PENDING' then
      raise exception 'a permission request starts as PENDING';
    end if;
    return new;
  end if;

  if (new.employee_id, new.campus_id, new.permission_date, new.start_time, new.end_time, new.reason,
      new.submitted_at, new.submitted_via, new.idempotency_key)
     is distinct from
     (old.employee_id, old.campus_id, old.permission_date, old.start_time, old.end_time, old.reason,
      old.submitted_at, old.submitted_via, old.idempotency_key) then
    raise exception 'permission request details cannot be edited';
  end if;

  if old.status <> 'PENDING'
     and (new.decided_via, new.decided_by_user_id, new.decided_at, new.decision_note)
         is distinct from (old.decided_via, old.decided_by_user_id, old.decided_at, old.decision_note) then
    raise exception 'a recorded decision cannot be changed';
  end if;

  if new.status is distinct from old.status then
    if not ((old.status = 'PENDING' and new.status in ('APPROVED', 'REJECTED', 'CANCELLED'))
         or (old.status = 'APPROVED' and new.status = 'CANCELLED')) then
      raise exception 'invalid permission status change: % to %', old.status, new.status;
    end if;
    if new.status in ('APPROVED', 'REJECTED') then
      if new.decided_at is null or new.decided_via is null then
        raise exception 'a decision needs decided_at and decided_via';
      end if;
      if new.decided_via = 'WEB' and (new.decided_by_user_id is null or not attendance_is_director(new.decided_by_user_id)) then
        raise exception 'only the Director can approve or reject permissions';
      end if;
      if new.status = 'REJECTED' and nullif(btrim(coalesce(new.decision_note, '')), '') is null then
        raise exception 'rejecting needs a reason';
      end if;
    end if;
    if new.status = 'CANCELLED' and (new.cancelled_at is null or new.cancelled_by is null) then
      raise exception 'a cancellation needs cancelled_at and cancelled_by';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists permission_request_guard_trg on permission_requests;
create trigger permission_request_guard_trg
  before insert or update or delete on permission_requests
  for each row execute function permission_request_guard();

-- 6. WhatsApp: after the Director taps Reject, the next message is the reason. -------------------
create table if not exists director_pending_input (
  id            uuid primary key default gen_random_uuid(),
  request_kind  text not null check (request_kind in ('LEAVE', 'PERMISSION')),
  request_id    uuid not null,
  action        text not null check (action in ('REJECT')),
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null,
  consumed_at   timestamptz
);
create index if not exists director_pending_input_open_idx
  on director_pending_input (expires_at) where consumed_at is null;

-- 7. Settings (all editable in the app) -------------------------------------------------------------
insert into attendance_settings (key, value, description) values
  ('leave_cap_per_campus_per_day', '2'::jsonb,
     'Maximum employees on leave (pending plus approved) per campus per date'),
  ('form_token_ttl_minutes', '30'::jsonb,
     'How long a leave or permission form link works'),
  ('permission_max_minutes', 'null'::jsonb,
     'Longest single permission in minutes (empty = no limit)'),
  ('permission_max_per_month', 'null'::jsonb,
     'Most permissions per employee per month (empty = no limit)'),
  ('template_leave_request', '"leave_request"'::jsonb,
     'Approved template name: leave request to the Director (with Approve / Reject buttons)'),
  ('template_permission_request', '"permission_request"'::jsonb,
     'Approved template name: permission request to the Director (with Approve / Reject buttons)'),
  ('template_leave_decision', '"leave_decision"'::jsonb,
     'Approved template name: leave decision to the employee'),
  ('template_permission_decision', '"permission_decision"'::jsonb,
     'Approved template name: permission decision to the employee')
on conflict (key) do nothing;

-- 8. Row Level Security: no browser access. ---------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'form_tokens', 'leave_requests', 'leave_request_days', 'leave_ledger',
    'permission_requests', 'director_pending_input'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format('revoke all on table %I from anon, authenticated', t);
    execute format('drop policy if exists "no browser access" on %I', t);
    execute format(
      'create policy "no browser access" on %I for all to anon, authenticated using (false) with check (false)', t);
  end loop;
end $$;

revoke all on sequence leave_request_days_id_seq from anon, authenticated;
revoke all on sequence leave_ledger_id_seq       from anon, authenticated;

commit;
