param(
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

corepack pnpm --filter @workspace/payroll-portal build

if ($DryRun) {
    npx wrangler deploy --dry-run
} else {
    npx wrangler deploy
}