-- ROLLBACK for 202611260004_attendance_04_audit_and_storage.sql
-- DESTRUCTIVE: drops the attendance audit log and ALL entries in it.
-- Do not run without explicit approval. Existing tables are untouched.
-- Run BEFORE rolling back migration 02.

begin;

drop table if exists attendance_audit_log;

commit;

-- The 'attendance-selfies' bucket is NOT removed by this script. Supabase blocks deleting
-- storage buckets/objects with plain SQL. To remove it, first empty it, then delete it in
-- the Supabase dashboard (Storage) or through the Storage API. Do NOT do this while real
-- selfies you need are stored: they cannot be recovered.
