# OtterBridge — Legacy Python server

This is the **original Python (FastMCP) implementation** of the OtterBridge MCP
server. It has been **superseded by the Node/TypeScript server in
[`../server/`](../server/)**, which is what the project uses going forward
(it bundles into a `.mcpb` for one-click Claude Desktop install, with zero
prerequisites — Node ships inside Claude Desktop; Python does not).

It's kept here as a **reference / fallback**. Same WebSocket protocol, same 9
tools, same safety model (destructive-action gate + audit log + origin/host
guards). It is **single-tab only** — the multi-tab / per-agent tab-group
features live only in the Node server.

> Run **either** the Node server **or** this one — never both at once. They
> share the `ws://localhost:8765` bridge, and only one process can own it.

## Contents

```
legacy/
├── server-python/       the FastMCP server (server.py, echo_test.py, pyproject.toml)
├── bootstrap.ps1 / .sh  one-time setup (installs uv → Python 3.12 → deps)
├── start.ps1  / .sh     launch the server
└── requirements.txt     pinned deps (mcp==1.28.1, websockets==16.0)
```

## Setup (no Python pre-installed needed)

`bootstrap` installs [uv](https://docs.astral.sh/uv/), which downloads Python
3.12 and the pinned deps into a local `.venv` here.

| OS | One-time setup | Start |
|---|---|---|
| Windows | `.\bootstrap.ps1` | `.\start.ps1` |
| macOS / Linux | `chmod +x bootstrap.sh start.sh && ./bootstrap.sh` | `./start.sh` |

Run these from **inside this `legacy/` folder**. Also load the unpacked
extension from [`../extension`](../extension) (Chrome → `chrome://extensions` →
Developer mode → Load unpacked).

- **Claude Code / MCP Inspector:** `./start.sh` (or `.\start.ps1`) → HTTP at
  `http://localhost:8000/mcp`, then `claude mcp add --transport http otterbridge http://localhost:8000/mcp`.
- **Claude Desktop (stdio):** point `claude_desktop_config.json` at this server:

  **Windows**
  ```json
  {
    "mcpServers": {
      "otterbridge": {
        "command": "C:\\path\\to\\otterbridge-browser-mcp\\legacy\\.venv\\Scripts\\python.exe",
        "args": ["C:\\path\\to\\otterbridge-browser-mcp\\legacy\\server-python\\server.py", "--stdio"]
      }
    }
  }
  ```
  **macOS / Linux**
  ```json
  {
    "mcpServers": {
      "otterbridge": {
        "command": "/path/to/otterbridge-browser-mcp/legacy/.venv/bin/python",
        "args": ["/path/to/otterbridge-browser-mcp/legacy/server-python/server.py", "--stdio"]
      }
    }
  }
  ```

For anything new, prefer the Node server in [`../server/`](../server/) — see the
root [README](../README.md).
