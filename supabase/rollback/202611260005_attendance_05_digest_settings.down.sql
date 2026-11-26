-- ROLLBACK for 202611260005_attendance_05_digest_settings.sql
-- Removes only the three rows migration 05 added. Do not run without explicit approval.

begin;

delete from attendance_settings
 where key in ('template_digest', 'digest_last_sent_at', 'sweeper_last_run_at');

commit;

-- VERIFY: expect 0
--   select count(*) from attendance_settings
--     where key in ('template_digest','digest_last_sent_at','sweeper_last_run_at');
