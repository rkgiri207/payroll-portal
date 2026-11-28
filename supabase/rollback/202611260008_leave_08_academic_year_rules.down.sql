-- ROLLBACK for 202611260008_leave_08_academic_year_rules.sql
-- Removes the academic-year guards and the setting. It also DROPS the column
-- attendance_events.outside_academic_year, which loses the "outside academic year" flag on any
-- records that carry it (the attendance records themselves are kept).
-- Do not run without explicit approval. Run BEFORE rolling back migration 07.

begin;

drop trigger if exists academic_year_dates_guard_trg on academic_years;
drop trigger if exists permission_in_year_guard_trg on permission_requests;
drop trigger if exists leave_ledger_in_year_guard_trg on leave_ledger;
drop trigger if exists leave_request_in_year_guard_trg on leave_requests;

drop function if exists academic_year_dates_guard();
drop function if exists permission_in_year_guard();
drop function if exists leave_ledger_in_year_guard();
drop function if exists leave_request_in_year_guard();

alter table attendance_events drop column if exists outside_academic_year;
delete from attendance_settings where key = 'allow_attendance_outside_academic_year';

commit;
