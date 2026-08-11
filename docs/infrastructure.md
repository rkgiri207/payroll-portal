# DEV Supabase Infrastructure

## Architecture

The application remains a pnpm monorepo: React/Vite in `artifacts/payroll-portal`,
Express in `artifacts/api-server`, and Drizzle/PostgreSQL schema and access in
`lib/db`. Administrator authentication is application-owned (bcrypt passwords,
Express sessions, and a PostgreSQL session table); Supabase Auth is not used.

Stage 3 creates PDFs and ZIP files in the authenticated browser. It persists only
generation status in PostgreSQL, so the `payslips` bucket is reserved for future
server-side persistence and is not used yet.

## Required Environment

Copy `.env.example` to a local `.env` and replace every bracketed placeholder.
Use credentials from the DEV Supabase project only.

- `NODE_ENV`: `development` or `production`.
- `PORT`: API/Vite port, normally `5000` locally.
- `APP_BASE_URL`: exact browser origin, without a trailing path.
- `BASE_PATH`: Vite base path, normally `/`.
- `DATABASE_URL`: DEV Supabase PostgreSQL connection or pooler URL with TLS.
- `DB_POOL_MAX`: optional backend connection pool limit.
- `SUPABASE_URL`: DEV project URL.
- `SUPABASE_ANON_KEY`: retained for standard Supabase configuration; never used for privileged operations.
- `SUPABASE_SERVICE_ROLE_KEY`: server-only Storage credential.
- `SESSION_SECRET`: long random value, different for each environment.

Never prefix the service-role key with `VITE_` or expose it in frontend code.

## Database Setup

1. Create or select the DEV Supabase project and copy its pooler connection string.
2. Set `DATABASE_URL` locally. Prefer the transaction pooler for serverless hosting
   and the session/direct connection for migrations.
3. Review the current Drizzle schema in `lib/db/src/schema`.
4. On a clean DEV database, apply the reviewed migration in `drizzle` with
   `node scripts/apply-dev-migrations.mjs`. The runner refuses to proceed if any
   application table already exists and records the migration in Drizzle's journal.
5. Do not use `push-force`; do not approve destructive statements against a database
   containing data. Generate and review a new SQL migration for future schema changes.
6. Create the first administrator with a bcrypt password hash through a controlled
   SQL/admin script. Do not commit the password or hash.

Application tables are `users`, `company_settings`, `audit_logs`, `employees`,
`payroll_runs`, `payroll_records`, `payroll_column_mappings`, and
`payslip_generations`. `connect-pg-simple` creates `sessions` when the API starts.

## Storage Setup

Run `supabase/migrations/202608090001_storage_buckets.sql` in the DEV SQL editor.
It idempotently creates these private buckets:

- `company-assets`: logos, 5 MB maximum, image MIME types only.
- `payroll-files`: imported Excel workbooks, 20 MB maximum.
- `payslips`: reserved for PDF persistence, private and currently unused.

The API creates two-hour signed upload URLs only after administrator session checks.
Downloads pass through authenticated API routes using the server-only service role.
No public object URL or browser storage policy is required.

For scripted setup, `node scripts/apply-storage-migration.mjs` applies the same SQL
in a transaction and verifies that all three buckets exist and remain private.

### Restricted Windows environments

Some restricted Windows service accounts cause Node/libuv `os.userInfo()` to throw
`uv_os_get_passwd ENOMEM` even when memory is available. This occurs below pnpm and
Drizzle. Preload `scripts/windows-userinfo-shim.cjs` with `NODE_OPTIONS=--require=...`
only in that environment; normal developer and deployment environments do not need it.

## Existing Object Migration

Replit objects are not copied automatically because this repository contains no
source credentials or object inventory. Export each existing logo/workbook, upload
it into the matching DEV bucket under `uploads/`, then update stored paths to:

`/objects/company-assets/uploads/<logo-file>`

`/objects/payroll-files/uploads/<workbook-file>`

Back up the database first and verify each path before changing rows. Legacy paths
without a bucket segment remain readable when the object has been copied into the
bucket implied by its use.

## Run And Verify

```sh
pnpm install
pnpm typecheck
pnpm build
pnpm --filter @workspace/api-server start
```

For frontend development, run `pnpm --filter @workspace/payroll-portal dev` with a
separate API process or reverse proxy for `/api`. Verify `/api/healthz`, login,
company settings/logo replacement, Excel upload/validation/import/history, payslip
preview/generation/regeneration, PDF download, and ZIP download using synthetic DEV
records such as `TEST001`.

## Replit Audit And Deployment

Removed runtime dependencies: Replit Object Storage sidecar, Google Cloud Storage
adapter, Replit connector SDK, and payroll portal Vite plugins/branding. `.replit`,
`replit.md`, mockup-sandbox development plugins, catalog comments, and UI source
comments remain harmless development metadata and are not imported by the deployed
API or payroll portal runtime.

For production, create a separate Supabase project, secret set, and database review;
never reuse DEV credentials. Set `APP_BASE_URL` to the future HTTPS subdomain and
terminate TLS at the hosting proxy. DNS and WhatsApp/payment-receipt infrastructure
are outside this migration and have not been changed.
