# OtterBridge one-time setup (Windows) — by wen-da-ng.
# Installs uv if needed, then creates the .venv with Python 3.12 and installs
# the pinned deps. You do NOT need Python pre-installed: uv downloads it.
#
# Usage:  .\bootstrap.ps1
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

function Have($cmd) { [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }

if (-not (Have "uv")) {
    Write-Host "Installing uv (fast Python package/-runtime manager)..." -ForegroundColor Cyan
    Invoke-RestMethod https://astral.sh/uv/install.ps1 | Invoke-Expression
    # The installer drops uv here; make it visible to THIS shell session.
    $env:Path = "$env:USERPROFILE\.local\bin;$env:Path"
}
if (-not (Have "uv")) {
    Write-Error "uv is still not on PATH. Open a new terminal, or see https://docs.astral.sh/uv/"
    exit 1
}

Write-Host "Creating .venv with Python 3.12 (uv downloads the interpreter if missing)..." -ForegroundColor Cyan
uv venv --python 3.12

Write-Host "Installing dependencies (mcp, websockets)..." -ForegroundColor Cyan
uv pip install -r requirements.txt

Write-Host "`nDone. Start the server with:  .\start.ps1" -ForegroundColor Green
