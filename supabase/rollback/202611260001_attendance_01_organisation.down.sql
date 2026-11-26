-- ROLLBACK for 202611260001_attendance_01_organisation.sql
-- DESTRUCTIVE: drops the six attendance organisation tables and ALL data in them.
-- Do not run without explicit approval. Existing tables (users, employees, ...) are untouched.
-- Run only after rolling back any later attendance migration (02, 03, 04) that depends on these tables.

begin;

drop table if exists employee_campus_assignments;
drop table if exists attendance_employees;
drop table if exists campus_shifts;
drop table if exists campuses;
drop table if exists attendance_settings;
drop table if exists attendance_roles;

commit;

-- VERIFY: expect 0
--   select count(*) from information_schema.tables
--     where table_schema='public' and table_name in
--     ('attendance_roles','attendance_settings','campuses','campus_shifts',
--      'attendance_employees','employee_campus_assignments');
