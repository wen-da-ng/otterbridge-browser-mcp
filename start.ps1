# OtterBridge - start the MCP browser-agent server (by wen-da-ng).
# Loads the WebSocket bridge (ws://localhost:8765) and the standard MCP
# streamable-HTTP endpoint (http://localhost:8000/mcp).
#
# Prerequisite (one time): load the unpacked extension in Chrome -
#   chrome://extensions -> Developer mode -> Load unpacked -> .\extension
#
# Usage:  .\start.ps1
$ErrorActionPreference = "Stop"
$py = Join-Path $PSScriptRoot ".venv\Scripts\python.exe"
$server = Join-Path $PSScriptRoot "server\server.py"

if (-not (Test-Path $py)) {
    Write-Error "venv python not found at $py - create it with: uv venv"
    exit 1
}

Write-Host "Starting OtterBridge MCP server..." -ForegroundColor Cyan
Write-Host "  WebSocket bridge : ws://localhost:8765" -ForegroundColor DarkGray
Write-Host "  MCP endpoint     : http://localhost:8000/mcp" -ForegroundColor DarkGray
Write-Host "  Audit log        : server\agent_actions.log" -ForegroundColor DarkGray
Write-Host "(Ctrl+C to stop)" -ForegroundColor DarkGray

& $py $server
