#!/usr/bin/env bash
# OtterBridge one-time setup (macOS / Linux) — by wen-da-ng.
# Installs uv if needed, then creates the .venv with Python 3.12 and installs
# the pinned deps. You do NOT need Python pre-installed: uv downloads it.
#
# Usage:  ./bootstrap.sh
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v uv >/dev/null 2>&1; then
  echo "Installing uv (fast Python package/-runtime manager)..."
  curl -LsSf https://astral.sh/uv/install.sh | sh
  # The installer drops uv here; make it visible to THIS shell session.
  export PATH="$HOME/.local/bin:$PATH"
fi
command -v uv >/dev/null 2>&1 || {
  echo "uv is still not on PATH. Open a new terminal, or see https://docs.astral.sh/uv/" >&2
  exit 1
}

echo "Creating .venv with Python 3.12 (uv downloads the interpreter if missing)..."
uv venv --python 3.12

echo "Installing dependencies (mcp, websockets)..."
uv pip install -r requirements.txt

echo
echo "Done. Start the server with:  ./start.sh"
