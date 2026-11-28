-- ROLLBACK for 202611260007_leave_07_requests_ledger.sql
-- DESTRUCTIVE: drops every leave and permission request, the leave ledger (all balances!), the
-- form links and the pending-decision table, and removes the settings rows this migration added.
-- Do not run without explicit approval. Run BEFORE rolling back migration 06.

begin;

drop view  if exists leave_balances;
drop table if exists director_pending_input;
drop table if exists leave_ledger;
drop table if exists leave_request_days;
drop table if exists permission_requests;
drop table if exists leave_requests;
drop table if exists form_tokens;

drop function if exists leave_request_release_capacity();
drop function if exists leave_day_cap_guard();
drop function if exists leave_request_guard();
drop function if exists permission_request_guard();
drop function if exists attendance_is_director(integer);

delete from attendance_settings where key in (
  'leave_cap_per_campus_per_day', 'form_token_ttl_minutes', 'permission_max_minutes',
  'permission_max_per_month', 'template_leave_request', 'template_permission_request',
  'template_leave_decision', 'template_permission_decision');

commit;
