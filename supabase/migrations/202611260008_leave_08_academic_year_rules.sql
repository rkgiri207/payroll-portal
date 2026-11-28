-- Leave module, migration 08: everything is aligned to the ORGANISATION'S academic year.
-- The first and last day of each academic year are typed in by the admin (they need not match
-- any official calendar). These rules read those dates; no date is fixed here.
--
-- ADDITIVE: new guard functions and triggers, one new column on my own attendance_events table
-- (default false, so existing rows are untouched) and one settings row. Nothing in payroll,
-- payslips, employees or users is touched.
-- Requires migrations 01 to 07. Apply to the TEST Supabase project only (kcpaqvuburgehzrdtygk).
-- Idempotent: safe to run twice.
--
-- Error codes the app turns into plain messages:
--   LY001 leave request is not inside its academic year (or spans two years)
--   LY002 ledger entry does not belong to its academic year
--   LY003 an academic year's dates cannot change because records would fall outside
--   LY004 permission date is not inside any academic year

begin;

-- 1. A leave request must sit entirely inside its academic year. -------------------------------
create or replace function leave_request_in_year_guard() returns trigger
language plpgsql set search_path = public as $$
declare y academic_years%rowtype;
begin
  select * into y from academic_years where id = new.academic_year_id;
  if new.start_date < y.start_date or new.end_date > y.end_date then
    raise exception 'leave from % to % is not inside academic year % (% to %): please submit one request for each academic year',
      new.start_date, new.end_date, y.label, y.start_date, y.end_date
      using errcode = 'LY001';
  end if;
  return new;
end $$;

drop trigger if exists leave_request_in_year_guard_trg on leave_requests;
create trigger leave_request_in_year_guard_trg
  before insert on leave_requests
  for each row execute function leave_request_in_year_guard();

-- 2. Ledger entries belong to their academic year. ----------------------------------------------
--    * A monthly period ('YYYY-MM') must be a month of that year.
--    * Opening, credit, carry-forward and deduction entries are dated inside the year.
--      (Reversals, adjustments, lapses and encashments may be posted later, for example when a
--      leave is cancelled after the year ended, so their date is not restricted.)
--    * An entry tied to a request carries that request's year, employee and leave type.
create or replace function leave_ledger_in_year_guard() returns trigger
language plpgsql set search_path = public as $$
declare y academic_years%rowtype; r leave_requests%rowtype; month_start date; month_end date;
begin
  select * into y from academic_years where id = new.academic_year_id;

  if new.period is not null then
    month_start := to_date(new.period || '-01', 'YYYY-MM-DD');
    month_end   := (month_start + interval '1 month' - interval '1 day')::date;
    if month_end < y.start_date or month_start > y.end_date then
      raise exception 'period % is not a month of academic year % (% to %)', new.period, y.label, y.start_date, y.end_date
        using errcode = 'LY002';
    end if;
  end if;

  if new.entry_type in ('OPENING', 'CREDIT', 'CARRY_FORWARD', 'DEDUCTION')
     and (new.effective_date < y.start_date or new.effective_date > y.end_date) then
    raise exception '% entry dated % is outside academic year % (% to %)',
      new.entry_type, new.effective_date, y.label, y.start_date, y.end_date
      using errcode = 'LY002';
  end if;

  if new.request_id is not null then
    select * into r from leave_requests where id = new.request_id;
    if r.academic_year_id <> new.academic_year_id
       or r.employee_id <> new.employee_id or r.leave_type_id <> new.leave_type_id then
      raise exception 'ledger entry does not match its leave request (academic year, employee and leave type must be the same)'
        using errcode = 'LY002';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists leave_ledger_in_year_guard_trg on leave_ledger;
create trigger leave_ledger_in_year_guard_trg
  before insert on leave_ledger
  for each row execute function leave_ledger_in_year_guard();

-- 3. A permission must fall inside some academic year. -------------------------------------------
create or replace function permission_in_year_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if not exists (select 1 from academic_years where new.permission_date between start_date and end_date) then
    raise exception 'no academic year is set up for %', new.permission_date using errcode = 'LY004';
  end if;
  return new;
end $$;

drop trigger if exists permission_in_year_guard_trg on permission_requests;
create trigger permission_in_year_guard_trg
  before insert on permission_requests
  for each row execute function permission_in_year_guard();

-- 4. Changing an academic year's dates is allowed ONLY if nothing falls outside the new dates. ----
create or replace function academic_year_dates_guard() returns trigger
language plpgsql set search_path = public as $$
declare n_holidays int; n_requests int; n_ledger int; n_permissions int;
begin
  if new.start_date = old.start_date and new.end_date = old.end_date then
    return new;
  end if;

  select count(*) into n_holidays from holidays
   where academic_year_id = old.id and (start_date < new.start_date or end_date > new.end_date);
  select count(*) into n_requests from leave_requests
   where academic_year_id = old.id and (start_date < new.start_date or end_date > new.end_date);
  select count(*) into n_ledger from leave_ledger
   where academic_year_id = old.id
     and ((entry_type in ('OPENING', 'CREDIT', 'CARRY_FORWARD', 'DEDUCTION')
           and (effective_date < new.start_date or effective_date > new.end_date))
       or (period is not null
           and ((to_date(period || '-01', 'YYYY-MM-DD') + interval '1 month' - interval '1 day')::date < new.start_date
                or to_date(period || '-01', 'YYYY-MM-DD') > new.end_date)));
  select count(*) into n_permissions from permission_requests
   where permission_date between old.start_date and old.end_date
     and (permission_date < new.start_date or permission_date > new.end_date);

  if n_holidays + n_requests + n_ledger + n_permissions > 0 then
    raise exception 'these dates cannot be used for academic year %: % holiday(s), % leave request(s), % ledger entr(ies) and % permission(s) would fall outside them',
      old.label, n_holidays, n_requests, n_ledger, n_permissions
      using errcode = 'LY003';
  end if;
  return new;
end $$;

drop trigger if exists academic_year_dates_guard_trg on academic_years;
create trigger academic_year_dates_guard_trg
  before update of start_date, end_date on academic_years
  for each row execute function academic_year_dates_guard();

-- 5. Attendance outside every academic year. -----------------------------------------------------
--    Off by default: with the setting off the app refuses check-in and check-out on a date that is
--    outside every academic year. When switched on, the record is accepted and flagged here.
alter table attendance_events
  add column if not exists outside_academic_year boolean not null default false;

insert into attendance_settings (key, value, description) values
  ('allow_attendance_outside_academic_year', 'false'::jsonb,
     'Allow check-in and check-out on dates outside every academic year (flagged on the record). Off = refused.')
on conflict (key) do nothing;

commit;
