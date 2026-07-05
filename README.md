# Otter — Browser Agent · OtterBridge

A personal "Claude in Chrome"-style browser agent. The **Otter** Chrome
extension is the hands & eyes; **OtterBridge** is the standard MCP server that
any MCP client can use to drive your real Chrome — Claude Code, Claude Cowork,
MCP Inspector, or a LangGraph/Ollama agent loop.

_Built by **wen-da-ng** · OtterBridge_

> **For personal use only.** Not for publication or distribution. It operates
> your real, logged-in browser (see [Security](#security)).

**Status: complete.** Bridge, observation tools, input + animated cursor,
vision (screenshots), and server-side safety are all implemented and verified.

## Components

| Path | What it is |
|---|---|
| `extension/` | Chrome MV3 extension — the hands & eyes. WebSocket client + `chrome.debugger` (CDP) input + animated fake cursor. |
| `server/` | **OtterBridge** — standard MCP server (FastMCP, streamable HTTP at `http://localhost:8000/mcp`) bridging tools to the extension over `ws://localhost:8765`. |
| `agent/` | *Optional* example MCP client (LangGraph). Not needed — any MCP client can attach. Deferred. |

## Quick start

1. **Install deps** (one time — into the `.venv`):
   ```
   uv pip install -r requirements.txt
   ```
2. **Load the extension** (one time): Chrome → `chrome://extensions` → enable
   **Developer mode** → **Load unpacked** → select `.\extension`.
3. **Start the server:**
   ```
   .\start.ps1
   ```
   Wait for `[bridge] extension connected` (the extension auto-reconnects).
4. **Attach a client:**
   - **Claude Code:** `claude mcp add --transport http otterbridge http://localhost:8000/mcp`
   - **MCP Inspector:** `npx @modelcontextprotocol/inspector` → Transport `Streamable HTTP` → `http://localhost:8000/mcp`
   - **Any MCP client:** streamable HTTP at `http://localhost:8000/mcp`

## Tools

| Tool | Does |
|---|---|
| `navigate(url)` | Point the active tab at a URL, wait for load. |
| `read_page()` | URL, title, visible text (≤20k chars) + `devicePixelRatio`. |
| `read_elements()` | Numbered interactive elements with center coordinates. |
| `click_element(index)` | **Preferred.** Clicks a `read_elements` entry by index; coordinate is resolved in-page, so it never drifts through screenshot scaling. |
| `click(x, y)` | Animated-cursor move + trusted CDP click at raw coordinates. Destructive targets prompt for approval. |
| `type_text(text)` | Per-character typing with human-like jitter. |
| `press_key(key)` | e.g. `Enter`, `Tab`, `Escape`. |
| `scroll(delta_y)` | Vertical scroll with jittered delta. |
| `screenshot()` | JPEG image of the viewport for *seeing* the page. For precise clicks use `read_elements` + `click_element`. |

## Security

- **Audit log:** every dispatched action is appended to `server/agent_actions.log`.
- **Destructive-action gate:** a `click` whose target text matches danger words
  (`buy/pay/delete/send/submit/checkout/confirm/transfer/…`) is hit-tested at
  dispatch and requires human approval via MCP elicitation. Works for every
  click — vision-mode, `read_elements`, or raw coordinates.
  - `BROWSER_AGENT_GATE=elicit` (default) | `off`
  - `BROWSER_AGENT_GATE_FALLBACK=deny` (default) | `allow` — used only if a
    client can't show an elicitation prompt.
- Servers bind to **localhost only**. Never expose them on the network.
- Runs in your **real Chrome profile** (real logins). For isolation, load the
  extension in a dedicated Chrome profile instead.
- Main residual threat is **prompt injection** from page content; keep the gate on.

## Reloading after code changes

| Changed | Do |
|---|---|
| `extension/*.js` | Reload the extension at `chrome://extensions` (↻). |
| `server/server.py` | Restart the server; in Claude Code run `/mcp` to reconnect. |

## Notes & gotchas

- Tools act on the **focused Chrome tab**. `chrome://` pages, the Web Store, and
  PDFs can't be read or clicked (they reject script injection).
- The **"Chrome is being debugged" banner** is cosmetic and unavoidable with
  `chrome.debugger`; websites cannot see it.
- Detection avoidance comes from running in your real browser, not the cursor
  animation. See `browser-agent-dev-guide.md` §10.

## Not done (optional)

- §10 detection refinements: brief-attach debugger, extra behavioral jitter,
  cursor overshoot. Only matters against aggressive anti-bot sites.
- The standalone LangGraph client in `agent/` (deferred — Claude Code already
  serves as a working agent client).
