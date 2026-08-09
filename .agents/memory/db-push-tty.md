---
name: DB push TTY requirement
description: drizzle-kit push requires interactive TTY for new table confirmation; use raw SQL via executeSql() instead in CI/non-interactive contexts
---

# drizzle-kit push Requires TTY

## The Rule
`pnpm --filter @workspace/db run push` fails with "Interactive prompts require a TTY terminal" when run in non-interactive shells (ShellExec tool, CI, piped input).

**Why:** drizzle-kit push prompts for confirmation when adding new tables or destructive changes.

## How to Apply
For new tables: create them directly via `executeSql({ sqlQuery: "CREATE TABLE IF NOT EXISTS ..." })`.
For existing tables you're migrating: same approach.
`drizzle-kit push` works fine in the workflow/shell when run interactively by the user.

After creating tables via SQL, drizzle-kit push will succeed for future runs because the schema matches.
