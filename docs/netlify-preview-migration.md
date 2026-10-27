# Isolated Netlify preview migration

## Scope and safety boundary

This configuration is for a separate Netlify preview site and an approved
non-production Supabase project only. It does not deploy, modify, or proxy the
existing Cloudflare or Render production services. Keep the current production
stack available as the rollback system until a separately approved cutover.

The application remains a Vite SPA plus an Express API. Netlify runs the
Express application as a standard Node serverless function; it is not a
Supabase Edge Function. The existing `src/index.ts` listener is intentionally
not used by the Netlify function, which imports `src/app.ts` through
`netlify/functions/api.ts`.

## Request routing

```text
browser
  |-- /api/* --> Netlify rewrite --> api function --> existing Express /api router
  |-- /p/*   --> Netlify rewrite --> api function --> existing public-payslip router
  `-- /*     --> Vite dist/index.html --> client-side routes

api function --> PostgreSQL through DATABASE_URL
             --> private Supabase Storage through server-only service-role access
             --> Meta Graph API only when the unchanged WhatsApp routes are called
```

The `/api/*` and `/p/*` rules precede the SPA fallback in `netlify.toml`.
They are rewrites (`200`), so browser-visible URLs, method, query string,
cookie behavior, and Express route mounts are retained.

## Required Netlify preview configuration

1. Create a new Netlify site from a separate branch or a deploy preview. Do
   not attach the production domain.
2. Use the repository root as the base directory. `netlify.toml` supplies the
   build command, Vite publish directory, function directory, rewrites, and
   bundled font inclusion.
3. Use Node `22.14.0` (also recorded in `.nvmrc`) and Corepack. The lockfile
   specifies pnpm `11.20.0`.
4. Configure the variables listed below in the Netlify preview environment.
   Never use production values in a preview site.
5. Do not configure a deploy hook, production-domain alias, or automatic
   promotion as part of this migration work.

Required application variable names:

- `NODE_ENV`, `APP_BASE_URL`, `DATABASE_URL`, `DB_POOL_MAX`
- `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
- `SESSION_SECRET`, `LOG_LEVEL`
- `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`,
  `WHATSAPP_GRAPH_API_VERSION`, `WHATSAPP_PAYSLIP_TEMPLATE_LANGUAGE`,
  `WHATSAPP_PAYSLIP_URL_BUTTON_INDEX`, `WHATSAPP_PAYSLIP_CTA_TYPE`, and
  `WHATSAPP_PAYSLIP_URL_PARAMETER_MODE`

`PORT` is required only by the persistent local server entry point, not by
Netlify Functions. `DEV_ADMIN_EMAIL` and `DEV_ADMIN_PASSWORD` are development
script credentials and should not be supplied to a deploy unless those scripts
are explicitly being run in an isolated environment. `TEST_PAYSLIP_FIXTURE` is
optional and only enables fixture-dependent formula testing.

## Supabase preview requirements

- Use a separate project, or an approved isolated database restored from an
  encrypted, access-controlled, anonymized backup.
- Apply reviewed Drizzle and Storage migrations only to that isolated project.
- Create the three private buckets: `company-assets`, `payroll-files`, and
  `payslips`; preserve the server-only service-role access model.
- Provision the PostgreSQL session table through the existing application
  startup behavior, then verify session persistence across separate function
  invocations.
- Do not expose `DATABASE_URL` or `SUPABASE_SERVICE_ROLE_KEY` to Vite/browser
  code. No `VITE_` form of either secret is permitted.

## Local commands

```text
corepack pnpm install --frozen-lockfile
corepack pnpm typecheck
corepack pnpm --filter @workspace/payroll-portal build
corepack pnpm --filter @workspace/api-server build
corepack pnpm --filter @workspace/api-server test
```

The test command uses Node's test runner through the already-declared `tsx`
development dependency. It does not call external APIs. Integration tests need
an explicitly approved isolated environment and must use mocked Meta responses.

On the restricted Windows environment documented in `infrastructure.md`, preload
the existing compatibility shim for the test process:

```powershell
$env:NODE_OPTIONS = "--require=$((Resolve-Path 'scripts\windows-userinfo-shim.cjs').Path)"
corepack pnpm --filter @workspace/api-server test
```

## Local verification results

| Check | Result | Notes |
| --- | --- | --- |
| Working tree baseline | Passed | Started clean at `main` / `e99aee6`; existing work was not overwritten. |
| Node runtime | Passed | Local Node is `22.14.0`, matching `.nvmrc`. |
| Netlify route/static configuration check | Passed | Verified the API, public-payslip, and SPA rewrite targets without starting services. |
| `git diff --check` | Passed | No whitespace errors. |
| Frozen-lockfile installation | Passed | pnpm `11.20.0` installed the existing lockfile without lockfile changes. |
| API React type declaration | Fixed | `@workspace/api-server` now directly declares the existing catalog `@types/react` package; the lockfile importer was updated without version changes. |
| Root typecheck | Passed | All workspace library, frontend, API, mockup, and script TypeScript checks passed. |
| Frontend production build | Passed | Built Vite output successfully; Rollup reported only its existing large-chunk warning. |
| API production build | Passed | Built the Express Node bundle successfully. |
| API Node tests | Passed | 17 passed, 0 failed, 1 skipped because `TEST_PAYSLIP_FIXTURE` was not configured. WhatsApp calls were mocked. |
| Netlify Function, Supabase, Storage, PostgreSQL, and Meta integration checks | Not run | They require a separately approved isolated environment; no external service was contacted. |

## Preview verification plan

1. Build the preview site and verify the published directory contains the Vite
   application and local font files.
2. Confirm `/api/healthz`, login/logout, session renewal, anonymous rejection,
   and HTTPS cookie attributes.
3. Exercise employee changes, workbook parse/validate/import, payroll history,
   cancellation, and record deletion using synthetic data only.
4. Upload a test logo and workbook; verify they remain private and that only an
   authenticated session can obtain upload/download access.
5. Generate, preview, download, bulk-export, and share synthetic payslips.
   Verify `/p/:token` expiry, revocation, response headers, and access counts.
6. Run mocked WhatsApp contract tests only. Do not call Meta or alter the
   existing template, payload, route, deduplication, logging, or configuration.
7. Test SPA deep links, direct `/api/*` and `/p/*` requests, cold starts,
   concurrent sessions, and PostgreSQL pool limits.

## Production cutover and rollback (documentation only)

Before any future approval, capture verified backups and object inventory,
complete a rehearsal, freeze writes, validate data/object checksums, and obtain
named approval for DNS and secrets. Cut over only after the preview verification
plan passes. Retain Cloudflare + Render unchanged as rollback. If critical
checks fail, restore traffic to the existing production routing; do not attempt
schema, data, or WhatsApp changes during rollback.

## Known limitations and decisions pending

- Netlify/preview behavior has not been executed in this workspace yet.
- Function cold-start, session-store, database-pool, PDF-font, and streaming
  behavior require an isolated environment test.
- Existing public payslip links and sessions need an explicit cutover policy.
- The production Supabase RLS state, Storage inventory, data source, and
  approved backup/restore process are not represented in this repository.
- No scheduled cleanup exists: expired share cleanup remains lazy/manual.
