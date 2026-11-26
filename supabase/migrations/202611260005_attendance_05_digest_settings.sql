-- Attendance module, migration 05: settings rows for the digest summary and the sweeper.
-- ADDITIVE ONLY: inserts three rows into attendance_settings; no table or column is altered.
-- Requires migration 01. Apply to the TEST Supabase project only (kcpaqvuburgehzrdtygk).
-- Idempotent: safe to run twice (existing rows are left as they are).

begin;

insert into attendance_settings (key, value, description) values
  ('template_digest',     '"attendance_digest"'::jsonb, 'Approved template name: digest summary'),
  ('digest_last_sent_at', 'null'::jsonb,                'Internal: when the last digest summary was queued'),
  ('sweeper_last_run_at', 'null'::jsonb,                'Internal: when the background sweeper last ran')
on conflict (key) do nothing;

commit;

-- VERIFY (expect 3, then 20):
--   select count(*) from attendance_settings
--     where key in ('template_digest','digest_last_sent_at','sweeper_last_run_at');
--   select count(*) from attendance_settings;
