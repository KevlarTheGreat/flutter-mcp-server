# build.ps1 — One-click setup and build for flutter-mcp-server
# Run from the flutter-mcp-server directory in any PowerShell terminal.

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

Write-Host "`nflutter-mcp-server build" -ForegroundColor Cyan
Write-Host "========================" -ForegroundColor Cyan

# Install deps if node_modules is missing or package.json is newer
if (-not (Test-Path "node_modules") -or
    ((Get-Item "package.json").LastWriteTime -gt (Get-Item "node_modules").LastWriteTime)) {
    Write-Host "`n[1/2] Installing dependencies..." -ForegroundColor Yellow
    npm install
} else {
    Write-Host "`n[1/2] Dependencies up to date." -ForegroundColor Green
}

# Compile TypeScript
Write-Host "`n[2/2] Compiling TypeScript..." -ForegroundColor Yellow
npx tsc

Write-Host "`nBuild complete -> dist/index.js" -ForegroundColor Green
Write-Host "Add to claude_desktop_config.json:" -ForegroundColor Cyan
Write-Host @"
  "flutter": {
    "command": "node",
    "args": ["$PSScriptRoot\dist\index.js"]
  }
"@ -ForegroundColor White
