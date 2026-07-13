#!/usr/bin/env bash
# OtterBridge - start the MCP browser-agent server (macOS / Linux) — by wen-da-ng.
# Loads the WebSocket bridge (ws://localhost:8765) and the standard MCP
# streamable-HTTP endpoint (http://localhost:8000/mcp).
#
# Prerequisites (one time):
#   1. ./bootstrap.sh                         (installs uv + Python + deps)
#   2. Load the unpacked extension in Chrome  (chrome://extensions ->
#      Developer mode -> Load unpacked -> ./extension)
#
# Usage:  ./start.sh            # HTTP transport (Claude Code / Inspector)
#         ./start.sh --stdio    # stdio transport (rarely run by hand; Claude
#                               # Desktop launches this itself — see README)
set -euo pipefail
cd "$(dirname "$0")"

PY=".venv/bin/python"
if [ ! -x "$PY" ]; then
  echo "venv python not found at $PY - run ./bootstrap.sh first" >&2
  exit 1
fi

echo "Starting OtterBridge MCP server..."
echo "  WebSocket bridge : ws://localhost:8765"
echo "  MCP endpoint     : http://localhost:8000/mcp"
echo "  Audit log        : server/agent_actions.log"
echo "(Ctrl+C to stop)"

exec "$PY" server/server.py "$@"
