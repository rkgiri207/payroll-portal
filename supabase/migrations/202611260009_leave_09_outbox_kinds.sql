-- Leave module, migration 09: message kinds for leave notifications.
-- The notification outbox only accepts a fixed list of message kinds. This WIDENS that list (it
-- removes no kind and changes no row), so leave messages can be queued:
--   LEAVE_INFO          a free-text reply to an employee (a full date, a refusal)
--   LEAVE_DECISION      the template telling an employee their leave was approved, not approved or cancelled
--   PERMISSION_DECISION the same for a permission request
--   DIRECTOR_INFO       a free-text confirmation to the Director after they tap a button
-- ADDITIVE: only a CHECK constraint is replaced, with a longer list. Nothing in payroll, payslips,
-- employees or users is touched.
-- Requires migrations 01 to 08. Apply to the TEST Supabase project only (kcpaqvuburgehzrdtygk).
-- Idempotent: safe to run twice.

begin;

alter table notification_outbox drop constraint if exists notification_outbox_kind_check;
alter table notification_outbox add constraint notification_outbox_kind_check check (kind in
  ('LINK','CHECKIN_CONFIRM','CHECKOUT_CONFIRM','FAILED_VERIFICATION','TOKEN_LOCKED',
   'HELP','COMING_SOON','CAMPUS_CHOICE',
   'DIRECTOR_CHECKIN','DIRECTOR_CHECKOUT','DIRECTOR_LATE','DIRECTOR_EXCEPTION',
   'DIRECTOR_MISSING_OUT','DIRECTOR_DIGEST',
   'DIRECTOR_LEAVE_REQUEST','DIRECTOR_PERMISSION_REQUEST',
   'LEAVE_INFO','LEAVE_DECISION','PERMISSION_DECISION','DIRECTOR_INFO'));

commit;
