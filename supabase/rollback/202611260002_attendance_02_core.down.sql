-- ROLLBACK for 202611260002_attendance_02_core.sql
-- DESTRUCTIVE: drops the five core attendance tables and ALL attendance data in them.
-- Do not run without explicit approval. Existing tables are untouched.
-- Run BEFORE rolling back migration 01, and after rolling back any later migration (03, 04).

begin;

drop table if exists attendance_adjustments;
drop table if exists attendance_exceptions;
drop table if exists attendance_events;
drop table if exists attendance_attempts;
drop table if exists attendance_tokens;

drop function if exists attendance_events_guard();
drop function if exists attendance_block_mutation();

commit;
