param(
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

corepack pnpm --filter @workspace/payroll-portal build

$redirects = "artifacts/payroll-portal/dist/_redirects"

if (Test-Path $redirects) {
    Remove-Item -Force $redirects
    Write-Host "Removed generated dist/_redirects"
}

if ($DryRun) {
    Write-Host "Running Cloudflare dry-run..."
    npx wrangler deploy --dry-run
} else {
    Write-Host "Deploying to Cloudflare..."
    npx wrangler deploy
}