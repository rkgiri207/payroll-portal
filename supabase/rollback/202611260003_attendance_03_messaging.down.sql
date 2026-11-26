-- ROLLBACK for 202611260003_attendance_03_messaging.sql
-- DESTRUCTIVE: drops the three messaging tables and ALL queued/logged messages in them.
-- Do not run without explicit approval. Existing tables are untouched.
-- Run BEFORE rolling back migration 02.

begin;

drop table if exists notification_delivery_log;
drop table if exists notification_outbox;
drop table if exists whatsapp_webhook_events;

commit;
