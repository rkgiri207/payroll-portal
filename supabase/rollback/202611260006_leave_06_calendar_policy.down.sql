-- ROLLBACK for 202611260006_leave_06_calendar_policy.sql
-- DESTRUCTIVE: drops the academic years, holidays, leave types, policies and allocations, and the
-- "reports during vacations" flags. Do not run without explicit approval.
-- Run AFTER rolling back migration 07 (which depends on these tables).

begin;

drop table if exists leave_allocations;
drop table if exists leave_policies;
drop table if exists leave_types;
drop table if exists holidays;
drop function if exists holidays_in_year_guard();
drop table if exists academic_years;

alter table attendance_employees drop column if exists reports_during_vacations;

commit;
