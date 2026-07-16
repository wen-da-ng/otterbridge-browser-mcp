# Otter — Browser Agent · OtterBridge

A personal "Claude in Chrome"-style browser agent. The **Otter** Chrome
extension is the hands & eyes; **OtterBridge** is the standard MCP server that
any MCP client can use to drive your real Chrome — Claude Code, Claude Desktop,
MCP Inspector, or any MCP client.

_Built by **wen-da-ng** · OtterBridge_

![OtterBridge](static/otterbridge-banner.png)

> **For personal use only.** Not for publication or distribution. It operates
> your real, logged-in browser (see [Security](#security)).

**Status: complete.** Bridge, observation tools, input + animated cursor, vision
(screenshots), server-side safety, in-extension settings UI, and **multi-tab /
multi-agent** control are all implemented and verified.

## Components

| Path | What it is |
|---|---|
| `extension/` | Chrome MV3 extension — the hands & eyes. WebSocket client + `chrome.debugger` (CDP) input + animated fake cursor + a settings UI (popup + options page). |
| `server/` | **OtterBridge (Node/TypeScript)** — the MCP server. Bridges browser actions to the extension over `ws://localhost:8765`, with two transports from one codebase: **stdio** (for the `.mcpb` / Claude Desktop) and **streamable HTTP** at `http://localhost:8000/mcp` (for Claude Code, MCP Inspector). Bundles into a one-click `.mcpb`. |
| `legacy/` | The original **Python** (FastMCP) server + its setup scripts, kept as a reference/fallback. Single-tab only. See [`legacy/README.md`](legacy/README.md). |
| `agent/` | *Optional* example MCP client (LangGraph). Not needed — any MCP client can attach. Deferred. |

Run **only one** server at a time (Node **or** legacy Python) — they share the
`ws://localhost:8765` bridge and only one process can own it.

## Quick start

### Step 1 — Load the Otter extension *(everyone, one time)*

Chrome → `chrome://extensions` → enable **Developer mode** → **Load unpacked** →
select the `extension` folder. Required regardless of which client you use.

### Step 2 — Attach your MCP client

<details>
<summary><b>A · Claude Desktop</b> — the one-click <code>.mcpb</code> (recommended, no prerequisites)</summary>

Node ships **inside** Claude Desktop, so there's nothing to install or compile.
**Download `otterbridge.mcpb` from the
[Releases page](https://github.com/wen-da-ng/otterbridge-browser-mcp/releases)**
(CI builds and attaches it on every version tag), grab the committed copy at
[`server/otterbridge.mcpb`](server/otterbridge.mcpb), or build it from source:

```bash
cd server
npm ci --ignore-scripts   # reproducible install, no dependency install scripts
npm run pack              # esbuild bundle + mcpb pack → otterbridge.mcpb
```

Then double-click `server/otterbridge.mcpb` (or Claude Desktop → **Settings →
Extensions → Advanced → Install Extension**). Two checkboxes appear for the
safety gate; the defaults (approval on, fail-open off) are the safe ones. That's
it — no terminal, no config file. This is the path a non-technical user gets
when the bundle is shared with them directly.

The bundle is a single self-contained `dist/index.js` (no `node_modules` tree in
the artifact). Claude Desktop launches it over stdio and hosts the `:8765`
bridge; do **not** also run a standalone server.
</details>

<details open>
<summary><b>B · Claude Code</b> — Windows / macOS / Linux</summary>

```bash
cd server
npm ci --ignore-scripts
npm run build
npm start                 # streamable HTTP at http://localhost:8000/mcp
```

Wait for `[bridge] extension connected` (the extension auto-reconnects), then
register it once:
```
claude mcp add --transport http otterbridge http://localhost:8000/mcp
```
</details>

<details>
<summary><b>C · MCP Inspector / any other MCP client</b></summary>

Start the server (`cd server && npm start`), then point the client at the
streamable-HTTP endpoint:
```
npx @modelcontextprotocol/inspector
```
Transport `Streamable HTTP` → `http://localhost:8000/mcp`.
</details>

<details>
<summary><b>Legacy Python server</b> — reference / fallback</summary>

The original Python implementation lives in [`legacy/`](legacy/) with its own
setup scripts (`bootstrap` + `start`) and docs. It's single-tab only. See
[`legacy/README.md`](legacy/README.md).
</details>

## Tools

The 9 core tools each take an **optional `tab` id** (from `open_tab`/`list_tabs`);
omit it to use the session's current tab, or the active tab if none.

| Tool | Does |
|---|---|
| `navigate(url, tab?)` | Point a tab at a URL, wait for load. |
| `read_page(tab?)` | URL, title, visible text (≤20k chars). |
| `read_elements(tab?)` | Numbered interactive elements with center coordinates. |
| `click_element(index, tab?)` | **Preferred.** Clicks a `read_elements` entry by index; coordinate resolved in-page, so it never drifts through screenshot scaling. |
| `click(x, y, tab?)` | Animated-cursor move + trusted CDP click at raw coordinates. Destructive targets prompt for approval. |
| `type_text(text, tab?)` | Per-character typing with human-like jitter. |
| `press_key(key, tab?)` | e.g. `Enter`, `Tab`, `Escape`. |
| `scroll(delta_y, tab?)` | Vertical scroll with jittered delta. |
| `screenshot(tab?)` | JPEG image of a tab's viewport (via CDP — works on background tabs too). |

**Multi-tab / multi-agent** (Node server): each MCP **session** is an agent with
its own colored Chrome **tab group**. Manage tabs with `open_tab(url?)`,
`list_tabs()`, `use_tab(tab)`, `close_tab(tab)`. Multiple agents (sessions) can
drive multiple tabs **simultaneously** — the server routes each session's
commands to its own tab, and a single agent never steals focus from another
(background tabs are driven via CDP without activation).

## Cursor & input settings

The extension has a settings UI — the toolbar **popup** (preset switch + master
cursor toggle) and a full **options page** (right-click the icon → Options).
Tune move speed, curvature, easing, typing speed, scroll, idle drift, cursor
size/colors/glow, and visibility — with **presets** (Natural / Fast / Instant)
and a live preview. Settings sync via `chrome.storage.sync` and apply live.

## Security

- **Audit log:** every dispatched action is appended to `server/agent_actions.log`.
- **Destructive-action gate:** a `click` whose target text matches danger words
  (`buy/pay/delete/send/submit/checkout/confirm/transfer/…`) is hit-tested at
  dispatch and requires human approval via MCP elicitation. Works for every
  click — vision-mode, `read_elements`, or raw coordinates.
  - `BROWSER_AGENT_GATE=elicit` (default) | `off` (also accepts `true`/`false`)
  - `BROWSER_AGENT_GATE_FALLBACK=deny` (default) | `allow` — used only if a
    client can't show an elicitation prompt. (The `.mcpb` exposes both as
    checkboxes in Claude Desktop's settings.)
- Servers bind to **localhost only**. Never expose them on the network.
- **Bridge & endpoint are origin/host-locked** (defense against local-page
  attacks): the `ws://localhost:8765` bridge only accepts the extension
  (`chrome-extension://` origin) or non-browser clients — a web page you visit
  can't connect to eavesdrop on or displace it. The HTTP endpoint rejects
  requests whose `Host`/`Origin` isn't loopback, blocking DNS-rebinding attempts
  to drive the browser from a malicious site.
- **Supply chain:** install with `npm ci --ignore-scripts`; no production
  dependency runs install scripts, and the committed `package-lock.json` pins
  versions. The shipped `.mcpb` is a single bundled file (no loose deps).
- Runs in your **real Chrome profile** (real logins). For isolation, load the
  extension in a dedicated Chrome profile instead.
- Main residual threat is **prompt injection** from page content; keep the gate on.

## Reloading after code changes

| Changed | Do |
|---|---|
| `extension/*.js` | Reload the extension at `chrome://extensions` (↻), then refresh open tabs. |
| `server/src/*.ts` (Claude Code / Inspector) | `npm run build` in `server/`; restart the server; in Claude Code run `/mcp` to reconnect. |
| `server/src/*.ts` (Claude Desktop `.mcpb`) | Re-pack (`npm run pack` in `server/`) and reinstall the bundle. |
| `legacy/server-python/server.py` | See [`legacy/README.md`](legacy/README.md). |

## Notes & gotchas

- `chrome://` pages, the Web Store, and PDFs can't be read or clicked (they
  reject script injection).
- The **"Chrome is being debugged" banner** is cosmetic and unavoidable with
  `chrome.debugger`; websites cannot see it.
- Detection avoidance comes from running in your real browser, not the cursor
  animation.
- Some sites (e.g. Shopee) gate automated browsing of logged-out sessions behind
  an anti-bot / login wall; log in first for deep browsing.

## Roadmap

- **✅ `.mcpb` Desktop Extension** — Node/TS server in `server/`, bundled for
  double-click install in Claude Desktop, zero prerequisites.
- **✅ Multi-tab / multi-agent** — per-session tab groups + parallel control.
- **⬜ Chrome Web Store (unlisted)** — publish the extension so it installs with
  one click from a private link (no Developer mode / unpacked folder). This is
  the last manual step remaining for a non-technical user.

## Not done (optional)

- Detection refinements: brief-attach debugger, extra behavioral jitter, cursor
  overshoot. Only matters against aggressive anti-bot sites.
- The standalone LangGraph client in `agent/` (deferred — Claude Code already
  serves as a working agent client).
