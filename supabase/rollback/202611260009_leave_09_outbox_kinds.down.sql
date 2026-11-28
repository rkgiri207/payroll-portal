-- ROLLBACK for 202611260009_leave_09_outbox_kinds.sql
-- Restores the original list of message kinds. A row using one of the four new kinds would stop
-- the original constraint from being restored, so those outbox rows (leave messages, which are a
-- log of what was queued or sent) are DELETED first, with their delivery history.
-- Do not run without explicit approval. Run BEFORE rolling back migrations 08 to 06 if you are
-- rolling back the whole leave module.

begin;

delete from notification_delivery_log
 where outbox_id in (select id from notification_outbox
                      where kind in ('LEAVE_INFO','LEAVE_DECISION','PERMISSION_DECISION','DIRECTOR_INFO'));
delete from notification_outbox
 where kind in ('LEAVE_INFO','LEAVE_DECISION','PERMISSION_DECISION','DIRECTOR_INFO');

alter table notification_outbox drop constraint if exists notification_outbox_kind_check;
alter table notification_outbox add constraint notification_outbox_kind_check check (kind in
  ('LINK','CHECKIN_CONFIRM','CHECKOUT_CONFIRM','FAILED_VERIFICATION','TOKEN_LOCKED',
   'HELP','COMING_SOON','CAMPUS_CHOICE',
   'DIRECTOR_CHECKIN','DIRECTOR_CHECKOUT','DIRECTOR_LATE','DIRECTOR_EXCEPTION',
   'DIRECTOR_MISSING_OUT','DIRECTOR_DIGEST',
   'DIRECTOR_LEAVE_REQUEST','DIRECTOR_PERMISSION_REQUEST'));

commit;
