-- Attendance module, migration 04: audit log and the private selfie bucket.
-- ADDITIVE ONLY: one new table and one new storage bucket; nothing existing is altered.
-- Requires migration 02 (it reuses the append-only guard function created there).
-- Apply to the TEST Supabase project only (kcpaqvuburgehzrdtygk).
-- Idempotent: safe to run twice.

begin;

-- 1. Attendance audit log: who did what, when, old and new value, reason ------
-- Append-only (updates and deletes are blocked by the same guard used for adjustments).
-- Also records every selfie view (action = 'SELFIE_VIEWED').
create table if not exists attendance_audit_log (
  id                 bigserial primary key,
  at                 timestamptz not null default now(),
  actor_type         text not null check (actor_type in ('USER', 'EMPLOYEE', 'SYSTEM', 'WEBHOOK')),
  actor_user_id      integer references users(id) on delete set null,
  actor_employee_id  integer references employees(id) on delete set null,
  action             text not null check (nullif(btrim(action), '') is not null),
  entity_type        text,
  entity_id          text,
  old_value          jsonb,
  new_value          jsonb,
  reason             text
);
create index if not exists attendance_audit_log_at_idx     on attendance_audit_log (at desc);
create index if not exists attendance_audit_log_entity_idx on attendance_audit_log (entity_type, entity_id);
create index if not exists attendance_audit_log_actor_idx  on attendance_audit_log (actor_user_id, at desc);

drop trigger if exists attendance_audit_log_guard_trg on attendance_audit_log;
create trigger attendance_audit_log_guard_trg
  before update or delete on attendance_audit_log
  for each row execute function attendance_block_mutation();

alter table attendance_audit_log enable row level security;
revoke all on table attendance_audit_log from anon, authenticated;
drop policy if exists "no browser access" on attendance_audit_log;
create policy "no browser access" on attendance_audit_log
  for all to anon, authenticated using (false) with check (false);
revoke all on sequence attendance_audit_log_id_seq from anon, authenticated;

-- 2. Private bucket for selfies -------------------------------------------------
-- Private: no public URLs. The API (server-side service role) uploads, and admins
-- view only through short-lived signed URLs, each view written to the audit log.
-- No storage policies are created, so browsers have no direct access.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('attendance-selfies', 'attendance-selfies', false, 1048576,
        array['image/jpeg', 'image/webp'])
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

commit;
