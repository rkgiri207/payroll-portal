-- Run against the DEV Supabase project only. All buckets remain private.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('company-assets', 'company-assets', false, 5242880,
    array['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
  ('payroll-files', 'payroll-files', false, 20971520,
    array['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
           'application/vnd.ms-excel', 'application/octet-stream']),
  ('payslips', 'payslips', false, 20971520, array['application/pdf'])
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- No browser RLS policies are created. The API uses the service role server-side,
-- and browsers receive only short-lived signed upload URLs after admin auth.
