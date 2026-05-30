# build.ps1 — One-time dependency install for flutter-mcp-server
# Run once from the flutter-mcp-server directory. No recompilation ever needed.

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

Write-Host "`nflutter-mcp-server setup" -ForegroundColor Cyan
Write-Host "=========================" -ForegroundColor Cyan

if (Test-Path "node_modules/@modelcontextprotocol") {
    Write-Host "`nDependencies already installed." -ForegroundColor Green
} else {
    Write-Host "`nInstalling dependencies (one-time)..." -ForegroundColor Yellow
    Write-Host "Tip: if this hangs, run as Administrator or add this folder to Windows Defender exclusions." -ForegroundColor DarkGray
    npm install
    Write-Host "Done." -ForegroundColor Green
}

Write-Host "`nReady! Add to claude_desktop_config.json:" -ForegroundColor Cyan
Write-Host @"
  "flutter": {
    "command": "node",
    "args": ["$PSScriptRoot\src\index.js"]
  }
"@ -ForegroundColor White
Write-Host "`nThen restart Claude Desktop." -ForegroundColor Cyan
