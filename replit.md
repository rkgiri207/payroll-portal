# Payroll Portal

A production-ready payroll management web application for school/business administrators. Stage 1 includes secure session-based authentication, company settings with logo upload, admin dashboard shell with audit logging, and a clean professional UI.

## Run & Operate

- `pnpm --filter @workspace/payroll-portal run dev` — run the frontend (port assigned by Replit)
- `pnpm --filter @workspace/api-server run dev` — run the API server (port 8080)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)

## Initial Admin Account

Created during Stage 1 setup:
- **Email:** `admin@payroll.local`
- **Password:** `ChangeMe123!` — **change immediately after first login**

The admin account was seeded directly via SQL. To reset a password, use a script that bcrypt-hashes the new password and updates the `users` table.

## Environment Variables / Secrets Required

| Variable | Description |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string (auto-provisioned by Replit) |
| `SESSION_SECRET` | Secret key for signing session cookies — already set |
| `DEFAULT_OBJECT_STORAGE_BUCKET_ID` | Object Storage bucket ID (auto-set by `setupObjectStorage()`) |
| `PUBLIC_OBJECT_SEARCH_PATHS` | Object Storage public search paths (auto-set) |
| `PRIVATE_OBJECT_DIR` | Object Storage private directory (auto-set) |

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- Frontend: React 19 + Vite 7, TanStack Query, wouter, shadcn/ui, Tailwind CSS 4
- API: Express 5 + session-based auth (express-session + connect-pg-simple)
- DB: PostgreSQL + Drizzle ORM
- Passwords: bcryptjs (cost factor 12)
- File storage: Replit Object Storage (GCS-backed, presigned URL uploads)
- Validation: Zod (v3), drizzle-zod
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where Things Live

- `lib/api-spec/openapi.yaml` — API contract (source of truth)
- `lib/db/src/schema/` — Database table definitions
  - `users.ts` — Admin users table
  - `companySettings.ts` — Company name/logo table
  - `auditLogs.ts` — Audit trail table
- `artifacts/api-server/src/routes/` — Express route handlers
  - `auth.ts` — Login / logout / me
  - `companySettings.ts` — Company name & logo management
  - `dashboard.ts` — Dashboard stats
  - `auditLogs.ts` — Audit log retrieval
  - `storage.ts` — Presigned URL generation + object serving
- `artifacts/api-server/src/lib/audit.ts` — Audit log utility
- `artifacts/api-server/src/middlewares/requireAuth.ts` — Session auth guard
- `artifacts/payroll-portal/src/` — React frontend

## Database Tables

| Table | Purpose |
|---|---|
| `users` | Admin accounts (id, name, email, password_hash, role, is_active, timestamps) |
| `company_settings` | Company name, logo path, contact details |
| `audit_logs` | Audit trail (action, entity, performer, timestamp) |
| `sessions` | Express session storage (managed by connect-pg-simple) |

## Architecture Decisions

- **Session-based auth (not JWT):** Server-side sessions via PostgreSQL. Simpler security model for an admin-only tool; no token refresh complexity. Sessions expire in 8 hours.
- **Object Storage for logos:** Company logo stored in Replit Object Storage via presigned URL upload. Only the object path is stored in PostgreSQL — no binary blobs in the DB.
- **Single admin role for Stage 1:** `users.role` uses a PostgreSQL enum `user_role` with value `ADMIN`. Additional roles (e.g., PAYROLL_OFFICER, EMPLOYEE) can be added to the enum without changing the schema structure.
- **Audit logging utility:** All state-changing operations call `createAuditLog()` from `src/lib/audit.ts`. Failures are caught and logged but do not block the main operation.
- **No registration endpoint:** Admin accounts are created by database insert. This is intentional for Stage 1 security.

## Product

**Stage 1 (complete):**
- Admin login/logout with secure session cookies
- Company settings (name + logo upload/remove)
- Dashboard shell (stat cards with empty states, recent activity)
- Sidebar navigation (Dashboard, Employees, Payroll, Payslips, Settings)
- Placeholder pages for Employees, Payroll, Payslips (Stages 2-4)
- Audit logging for login, logout, and settings changes

**Upcoming stages:**
- Stage 2: Employee master + Excel upload + payroll validation
- Stage 3: Payslip PDF generation + secure 7-day links
- Stage 4: WhatsApp Cloud API integration (template: `statement_available_1`)
- Stage 5: Payroll history + bulk operations + downloads
- Stage 6: Testing, security hardening, production deployment

## User Preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

- The `sessions` table is created by `connect-pg-simple` with `createTableIfMissing: true`, but needs the PostgreSQL user to have CREATE TABLE rights. If sessions don't persist, check that the `sessions` table exists: `SELECT * FROM sessions LIMIT 1;`
- After any `lib/db/src/schema/` change, run `pnpm --filter @workspace/db run push` before restarting the API server.
- After any `lib/api-spec/openapi.yaml` change, run `pnpm --filter @workspace/api-spec run codegen` before building.
- The `type: integer` in OpenAPI spec generates Zod v4 syntax (`zod.int()`) which is incompatible with the workspace's Zod v3. Use `type: number` instead for all numeric fields in the spec.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
- See the `object-storage` skill for logo upload presigned URL flow details
