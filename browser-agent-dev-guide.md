# Browser Agent — Development Guide

Build a personal "Claude in Chrome"-style browser agent: a Chrome extension that observes and acts on web pages (with an animated, human-like cursor), exposed as an **MCP server**, driven by a **LangGraph** agent loop instead of Cowork.

> **For personal use only.** Not for publication or distribution.

---

## 1. Architecture Overview

```
┌─────────────────┐     MCP (streamable HTTP)     ┌──────────────────┐
│  LangGraph      │ ◄───────────────────────────► │  MCP Server      │
│  agent loop     │   tools: screenshot, click,   │  (Python,        │
│  ("the brain")  │   type, navigate, read_page   │   FastMCP)       │
└─────────────────┘                               └────────┬─────────┘
                                                           │ WebSocket
                                                           │ ws://localhost:8765
                                                  ┌────────▼─────────┐
                                                  │ Chrome Extension │
                                                  │ (MV3)            │
                                                  │ • background.js  │──► chrome.debugger (CDP input events)
                                                  │ • content.js     │──► fake cursor overlay + animation
                                                  └──────────────────┘
```

**Three components:**

1. **Chrome extension (Manifest V3)** — the hands and eyes. Screenshots, DOM reading, clicking, typing, scrolling, navigation. Real input goes through `chrome.debugger` (CDP), so pages can't distinguish it from a real user.
2. **MCP server (Python, FastMCP)** — the nervous system. Exposes browser actions as MCP tools; relays commands to the extension over a localhost WebSocket.
3. **LangGraph workflow** — the brain. Loads MCP tools via `langchain-mcp-adapters`, runs an agent loop: observe → decide → act → repeat. Includes a human-approval interrupt before destructive actions.

**Key design decisions:**

- **Extension path, not CDP-launch path.** We control the user's real, already-open Chrome (logged-in sessions intact) rather than launching a fresh Chrome with `--remote-debugging-port`. The extension attaches CDP per-tab via `chrome.debugger`.
- **WebSocket bridge, not Native Messaging.** The MCP server hosts a WebSocket server on `ws://localhost:8765`; the extension's service worker connects as a client and auto-reconnects. Far simpler than Chrome Native Messaging for personal use.
- **The visible cursor is theater; CDP is the real work.** The animated cursor is an injected `<div>`; the actual click is a CDP `Input.dispatchMouseEvent` timed to fire when the animation arrives. Real `mouseMoved` CDP events are fired along the path so hover states genuinely trigger. **The cursor animation is for the human watching — it is NOT what evades bot detection.** See section 10.
- **Detection avoidance comes from the browser identity, not the cursor.** The extension runs inside your real, everyday Chrome: `navigator.webdriver` is `false`, real profile/cookies/history/fingerprint, real logged-in sessions. To a detection script this is indistinguishable from you browsing, because mechanically it *is* your browser. This — not the animated cursor — is why the extension approach evades bot detection where a debug-launched or Playwright browser gets flagged. Section 10 covers this in depth and it is the reason we use the extension path over Option B.
- **v1 is text-first (DOM reading), v2 adds vision (screenshots + coordinates).** Text-only sidesteps image handling in the agent loop and is easier to debug.

---

## 2. Project Structure

```
browser-agent/
├── extension/
│   ├── manifest.json
│   ├── background.js        # service worker: WebSocket client + command dispatch + CDP
│   ├── content.js           # fake cursor overlay + bezier animation
│   └── cursor.svg           # (optional) cursor artwork
├── server/
│   ├── pyproject.toml       # deps: mcp, websockets
│   └── server.py            # FastMCP tools + WebSocket bridge
├── agent/
│   ├── pyproject.toml       # deps: langgraph, langchain-anthropic, langchain-mcp-adapters
│   └── run_agent.py         # LangGraph loop with approval interrupt
└── README.md
```

---

## 3. Build Order (do it in this sequence)

1. **Phase 1 — Bridge:** Extension + WebSocket echo test. Load the unpacked extension, run a dummy WS server, confirm connect/reconnect and round-trip messages.
2. **Phase 2 — MCP core:** Implement `navigate` and `read_page` tools. Verify with **MCP Inspector** (`npx @modelcontextprotocol/inspector`).
3. **Phase 3 — Agent:** Wire into LangGraph via `langchain-mcp-adapters`. Get a text-only agent completing a simple task ("open example.com and summarize it").
4. **Phase 4 — Cursor + input:** Add `click`, `type_text`, `scroll` via CDP; add the animated cursor overlay with hover-event trail.
5. **Phase 5 — Vision (optional v2):** Add `screenshot`; format tool results as image content blocks so the model can see pages; switch to coordinate-based clicking.
6. **Phase 6 — Safety:** Add LangGraph `interrupt()` before destructive actions (form submits, purchases, sending messages).

---

## 4. Chrome Extension

### 4.1 `extension/manifest.json`

```json
{
  "manifest_version": 3,
  "name": "My Browser Agent",
  "version": "0.1.0",
  "description": "Personal browser automation agent (MCP-driven)",
  "permissions": ["tabs", "activeTab", "scripting", "debugger", "storage"],
  "host_permissions": ["<all_urls>"],
  "background": { "service_worker": "background.js" },
  "content_scripts": [
    {
      "matches": ["<all_urls>"],
      "js": ["content.js"],
      "run_at": "document_idle"
    }
  ]
}
```

### 4.2 `extension/background.js`

Responsibilities: maintain the WebSocket connection, dispatch incoming commands, own all `chrome.debugger` (CDP) calls, orchestrate cursor animation → real click sequencing.

```javascript
// ===== WebSocket bridge =====
let ws;

function connect() {
  ws = new WebSocket("ws://localhost:8765");
  ws.onopen = () => console.log("[agent] connected to MCP bridge");
  ws.onmessage = async (e) => {
    const { id, action, params } = JSON.parse(e.data);
    let result = null, error = null;
    try {
      result = await handle(action, params || {});
    } catch (err) {
      error = err.message || String(err);
    }
    ws.send(JSON.stringify({ id, result, error }));
  };
  ws.onclose = () => setTimeout(connect, 2000); // auto-reconnect
  ws.onerror = () => ws.close();
}
connect();

// MV3 service workers can be suspended; a periodic alarm keeps reconnection alive.
chrome.alarms.create("keepalive", { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener(() => {
  if (!ws || ws.readyState === WebSocket.CLOSED) connect();
});

// ===== Small helpers =====
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ===== CDP helpers =====
const attached = new Set();

async function ensureDebugger(tabId) {
  if (attached.has(tabId)) return;
  await chrome.debugger.attach({ tabId }, "1.3");
  attached.add(tabId);
}

chrome.debugger.onDetach.addListener(({ tabId }) => attached.delete(tabId));

async function cdp(tabId, method, params) {
  await ensureDebugger(tabId);
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

// Brief-attach pattern (section 12): detach when idle to shrink the window
// in which CDP-artifact detection can observe an attached debugger.
async function detachDebugger(tabId) {
  if (!attached.has(tabId)) return;
  try { await chrome.debugger.detach({ tabId }); } catch (_) {}
  attached.delete(tabId);
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error("No active tab");
  return tab;
}

// ===== Cursor orchestration =====
// Animate the fake cursor (content script) while firing real CDP mouseMoved
// events along the same path so :hover states genuinely trigger.
async function moveWithHoverTrail(tabId, x, y) {
  // Ask content script for the sampled path points it will animate through.
  const pts = await chrome.tabs.sendMessage(tabId, {
    type: "moveCursor",
    x, y,
    samples: 12,
  });
  // pts resolves AFTER animation completes; it returns the sampled points
  // with timestamps already elapsed — so replay hover events quickly here,
  // or (better) fire them live: see content.js note on live mode.
  for (const p of pts.path) {
    await cdp(tabId, "Input.dispatchMouseEvent", {
      type: "mouseMoved", x: p.x, y: p.y,
    });
  }
}

// ===== Command handlers =====
async function handle(action, p) {
  const tab = await activeTab();

  switch (action) {
    case "navigate": {
      await chrome.tabs.update(tab.id, { url: p.url });
      await waitForLoad(tab.id);
      return `Navigated to ${p.url}`;
    }

    case "read_page": {
      const [res] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => ({
          url: location.href,
          title: document.title,
          text: document.body.innerText.slice(0, 20000),
        }),
      });
      return res.result;
    }

    case "read_elements": {
      // Simplified interactive-element map: number every clickable/typable
      // element so the model can say "click element 14".
      const [res] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          const els = document.querySelectorAll(
            "a, button, input, textarea, select, [role='button'], [onclick]"
          );
          const out = [];
          els.forEach((el, i) => {
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) return; // invisible
            out.push({
              index: i,
              tag: el.tagName.toLowerCase(),
              text: (el.innerText || el.value || el.placeholder || "")
                .trim().slice(0, 80),
              x: Math.round(r.x + r.width / 2),
              y: Math.round(r.y + r.height / 2),
            });
          });
          return out;
        },
      });
      return res.result;
    }

    case "click": {
      // p: { x, y } in CSS viewport coordinates
      await moveWithHoverTrail(tab.id, p.x, p.y);
      await chrome.tabs.sendMessage(tab.id, { type: "clickPulse" });
      await cdp(tab.id, "Input.dispatchMouseEvent", {
        type: "mousePressed", x: p.x, y: p.y, button: "left", clickCount: 1,
      });
      await cdp(tab.id, "Input.dispatchMouseEvent", {
        type: "mouseReleased", x: p.x, y: p.y, button: "left", clickCount: 1,
      });
      return `Clicked at (${p.x}, ${p.y})`;
    }

    case "type_text": {
      // Human-like typing: per-character key events with jittered timing.
      // (Instant Input.insertText dumping the whole string is a behavioral
      // tell — see section 12.) isTrusted is true for CDP key events.
      const text = p.text || "";
      for (const ch of text) {
        await cdp(tab.id, "Input.dispatchKeyEvent", { type: "keyDown", text: ch });
        await cdp(tab.id, "Input.dispatchKeyEvent", { type: "keyUp", text: ch });
        // 60–160ms between keystrokes, with occasional longer pauses
        const base = 60 + Math.random() * 100;
        const pause = Math.random() < 0.08 ? base + 200 + Math.random() * 300 : base;
        await sleep(pause);
      }
      return `Typed ${text.length} chars`;
    }

    case "press_key": {
      // e.g. Enter, Tab, Escape
      const key = p.key;
      await cdp(tab.id, "Input.dispatchKeyEvent", { type: "keyDown", key });
      await cdp(tab.id, "Input.dispatchKeyEvent", { type: "keyUp", key });
      return `Pressed ${key}`;
    }

    case "scroll": {
      // Variable increments read more naturally than fixed jumps.
      const target = p.deltaY ?? 600;
      const jitter = target * (0.85 + Math.random() * 0.3);
      await cdp(tab.id, "Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: p.x ?? 400, y: p.y ?? 300,
        deltaX: 0, deltaY: Math.round(jitter),
      });
      return "Scrolled";
    }

    case "screenshot": {
      // Returns base64 PNG data URL of the visible viewport.
      const dataUrl = await chrome.tabs.captureVisibleTab(null, {
        format: "png",
      });
      return dataUrl;
    }

    default:
      throw new Error(`Unknown action: ${action}`);
  }
}

function waitForLoad(tabId, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const timer = setTimeout(done, timeoutMs);
    function listener(id, info) {
      if (id === tabId && info.status === "complete") done();
    }
    function done() {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// Re-inject cursor position after navigation (content scripts die on nav).
let lastCursor = { x: 40, y: 40 };
chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (info.status === "complete") {
    try {
      await chrome.tabs.sendMessage(tabId, {
        type: "placeCursor", ...lastCursor,
      });
    } catch (_) { /* content script not ready / not injectable page */ }
  }
});
```

### 4.3 `extension/content.js`

The fake cursor: injected overlay, human-like Bézier + ease-in-out motion, click pulse.

```javascript
// ===== Cursor element =====
let cursor = null;

function ensureCursor() {
  if (cursor && document.documentElement.contains(cursor)) return cursor;
  cursor = document.createElement("div");
  cursor.id = "__agent_cursor";
  Object.assign(cursor.style, {
    position: "fixed",
    left: "40px",
    top: "40px",
    width: "24px",
    height: "24px",
    zIndex: "2147483647",     // stay on top of everything
    pointerEvents: "none",     // CRITICAL: real clicks must pass through it
    transition: "none",
    transform: "scale(1)",
  });
  cursor.innerHTML = `<svg viewBox="0 0 24 24" width="24" height="24">
    <path d="M4 2 L4 20 L9 15 L12 22 L15 20.5 L12 14 L19 14 Z"
          fill="#111" stroke="#fff" stroke-width="1.5"/>
  </svg>`;
  document.documentElement.appendChild(cursor);
  return cursor;
}

// ===== Human-like motion: quadratic bezier + ease-in-out =====
// Returns sampled path points so background.js can fire CDP mouseMoved
// along the same trajectory (hover states trigger for real).
function moveCursorTo(tx, ty, samples = 12) {
  return new Promise((resolve) => {
    const c = ensureCursor();
    const sx = parseFloat(c.style.left) || 0;
    const sy = parseFloat(c.style.top) || 0;
    const dist = Math.hypot(tx - sx, ty - sy);
    const duration = Math.min(1200, 200 + dist * 1.5); // farther = longer, capped

    // Control point offset perpendicular to the path → gentle arc
    const mx = (sx + tx) / 2 + (ty - sy) * 0.15;
    const my = (sy + ty) / 2 - (tx - sx) * 0.15;

    const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
    const bezier = (e) => ({
      x: (1 - e) ** 2 * sx + 2 * (1 - e) * e * mx + e * e * tx,
      y: (1 - e) ** 2 * sy + 2 * (1 - e) * e * my + e * e * ty,
    });

    const path = [];
    for (let i = 1; i <= samples; i++) {
      const p = bezier(ease(i / samples));
      path.push({ x: Math.round(p.x), y: Math.round(p.y) });
    }

    const start = performance.now();
    function frame(now) {
      const t = Math.min(1, (now - start) / duration);
      const p = bezier(ease(t));
      c.style.left = p.x + "px";
      c.style.top = p.y + "px";
      if (t < 1) requestAnimationFrame(frame);
      else resolve({ path });
    }
    requestAnimationFrame(frame);
  });
}

// ===== Click pulse (press-down effect) =====
function clickPulse() {
  const c = ensureCursor();
  c.style.transform = "scale(0.85)";
  setTimeout(() => (c.style.transform = "scale(1)"), 120);
}

// ===== Message handling =====
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "moveCursor") {
    moveCursorTo(msg.x, msg.y, msg.samples).then(sendResponse);
    return true; // async response
  }
  if (msg.type === "clickPulse") {
    clickPulse();
    sendResponse({ ok: true });
  }
  if (msg.type === "placeCursor") {
    const c = ensureCursor();
    c.style.left = msg.x + "px";
    c.style.top = msg.y + "px";
    sendResponse({ ok: true });
  }
});

ensureCursor();
```

> **Improvement (live hover mode):** in the version above, CDP `mouseMoved` events fire after the animation completes. For perfect sync, have `content.js` post each sampled point to `background.js` *during* the animation (via `chrome.runtime.sendMessage` per frame-batch), and have background fire `mouseMoved` as they arrive. Ship the simple version first.

---

## 5. MCP Server (`server/server.py`)

FastMCP tool definitions + the WebSocket bridge to the extension.

```python
import asyncio
import json
import uuid

import websockets
from mcp.server.fastmcp import FastMCP

mcp = FastMCP("browser")

# ===== WebSocket bridge =====
ext_socket = None            # the connected extension, if any
pending: dict[str, asyncio.Future] = {}

async def ws_handler(ws):
    global ext_socket
    ext_socket = ws
    print("[bridge] extension connected")
    try:
        async for msg in ws:
            data = json.loads(msg)
            fut = pending.pop(data.get("id"), None)
            if fut and not fut.done():
                fut.set_result(data)
    finally:
        if ext_socket is ws:
            ext_socket = None
        print("[bridge] extension disconnected")

async def send_cmd(action: str, params: dict | None = None, timeout: float = 30):
    if ext_socket is None:
        raise RuntimeError(
            "Chrome extension is not connected. Is Chrome open with the "
            "extension loaded?"
        )
    fut = asyncio.get_event_loop().create_future()
    cmd_id = str(uuid.uuid4())
    pending[cmd_id] = fut
    await ext_socket.send(json.dumps({
        "id": cmd_id, "action": action, "params": params or {},
    }))
    resp = await asyncio.wait_for(fut, timeout=timeout)
    if resp.get("error"):
        raise RuntimeError(resp["error"])
    return resp["result"]

# ===== MCP tools =====

@mcp.tool()
async def navigate(url: str) -> str:
    """Navigate the active browser tab to a URL and wait for load."""
    return await send_cmd("navigate", {"url": url})

@mcp.tool()
async def read_page() -> str:
    """Read the active tab: URL, title, and visible text (truncated)."""
    result = await send_cmd("read_page")
    return json.dumps(result)

@mcp.tool()
async def read_elements() -> str:
    """List interactive elements on the page as numbered entries with
    center coordinates. Use the coordinates with the click tool."""
    result = await send_cmd("read_elements")
    return json.dumps(result)

@mcp.tool()
async def click(x: int, y: int) -> str:
    """Move the cursor with a human-like animation to viewport
    coordinates (x, y) and click there."""
    return await send_cmd("click", {"x": x, "y": y})

@mcp.tool()
async def type_text(text: str) -> str:
    """Type text into the currently focused element."""
    return await send_cmd("type_text", {"text": text})

@mcp.tool()
async def press_key(key: str) -> str:
    """Press a keyboard key, e.g. 'Enter', 'Tab', 'Escape'."""
    return await send_cmd("press_key", {"key": key})

@mcp.tool()
async def scroll(delta_y: int = 600) -> str:
    """Scroll the page vertically. Positive = down, negative = up."""
    return await send_cmd("scroll", {"deltaY": delta_y})

@mcp.tool()
async def screenshot() -> str:
    """Capture the visible viewport as a base64 PNG data URL."""
    return await send_cmd("screenshot")

# ===== Run both servers =====
async def main():
    ws_server = await websockets.serve(ws_handler, "localhost", 8765)
    print("[bridge] WebSocket listening on ws://localhost:8765")
    # streamable HTTP MCP endpoint (default: http://localhost:8000/mcp)
    await mcp.run_streamable_http_async()

if __name__ == "__main__":
    asyncio.run(main())
```

`server/pyproject.toml` dependencies:

```toml
[project]
name = "browser-agent-server"
version = "0.1.0"
requires-python = ">=3.11"
dependencies = [
    "mcp>=1.0",
    "websockets>=12",
]
```

> **Note:** FastMCP API details (method names for running streamable HTTP, default ports) vary by `mcp` package version — check the installed version's docs/README and adjust `main()` accordingly. The MCP Inspector (`npx @modelcontextprotocol/inspector`) is the fastest way to verify tools work before touching LangGraph.

---

## 6. LangGraph Agent (`agent/run_agent.py`)

```python
import asyncio

from langchain_mcp_adapters.client import MultiServerMCPClient
from langgraph.prebuilt import create_react_agent
from langgraph.checkpoint.memory import MemorySaver

SYSTEM_PROMPT = """You are a browser automation agent controlling the
user's real Chrome browser through tools.

Workflow for each step:
1. Use read_page / read_elements to understand the current page.
2. Decide ONE next action (navigate, click, type_text, press_key, scroll).
3. To click something, first call read_elements, find the target element,
   then call click with its x/y coordinates.
4. After acting, re-read the page to verify the result before continuing.

Rules:
- Never submit forms, make purchases, send messages, or delete anything
  without explicit approval.
- If a page looks like a login wall or CAPTCHA, stop and report it.
- Prefer few, deliberate actions over many speculative ones.
- Pace yourself like a human: read before acting, don't fire actions
  back-to-back at machine speed. (Timing jitter is also enforced in the
  tools themselves — see section 12.)
"""

async def main():
    client = MultiServerMCPClient({
        "browser": {
            "transport": "streamable_http",
            "url": "http://localhost:8000/mcp",
        }
    })
    tools = await client.get_tools()

    agent = create_react_agent(
        "anthropic:claude-sonnet-4-6",
        tools,
        prompt=SYSTEM_PROMPT,
        checkpointer=MemorySaver(),   # enables interrupts / resumability
    )

    config = {"configurable": {"thread_id": "session-1"}}
    task = input("Task: ")
    result = await agent.ainvoke(
        {"messages": [("user", task)]},
        config=config,
    )
    print(result["messages"][-1].content)

if __name__ == "__main__":
    asyncio.run(main())
```

`agent/pyproject.toml` dependencies:

```toml
[project]
name = "browser-agent-runner"
version = "0.1.0"
requires-python = ">=3.11"
dependencies = [
    "langgraph>=0.2",
    "langchain-anthropic>=0.3",
    "langchain-mcp-adapters>=0.1",
]
```

Set `ANTHROPIC_API_KEY` in the environment before running.

### 6.1 Human-approval interrupt (Phase 6)

Replace the prebuilt ReAct agent with a custom graph when you're ready, or wrap risky tools. Pattern:

```python
from langgraph.types import interrupt

def guarded_tool(risky_tool):
    async def wrapper(*args, **kwargs):
        decision = interrupt({
            "question": f"Approve {risky_tool.name} with {kwargs}?",
        })
        if decision != "approve":
            return "Action denied by user."
        return await risky_tool.ainvoke(kwargs)
    return wrapper
```

Wrap `click` (when targeting submit buttons), `type_text` on password fields, and any tool you add later that sends/posts/pays. `interrupt()` pauses the graph; resume with `Command(resume="approve")`.

### 6.2 Vision mode (Phase 5)

The `screenshot` tool returns a base64 data URL as a *string*. For the model to actually see it, convert the tool result into an image content block on the ToolMessage. Simplest approach: a small post-processing node (or custom tool wrapper) that detects `data:image/png;base64,` results and rewrites the message content to:

```python
[
    {"type": "text", "text": "Screenshot captured:"},
    {"type": "image_url", "image_url": {"url": data_url}},
]
```

Then instruct the model to click using coordinates read from the screenshot. **Coordinate conversion gotcha:** screenshots are in physical pixels; CDP input expects CSS viewport coordinates. Divide screenshot coordinates by `window.devicePixelRatio` (expose it via `read_page`). Mismatch here is the #1 cause of "it clicks slightly off."

---

## 7. Setup & Run Checklist

1. **Extension:** Chrome → `chrome://extensions` → enable Developer mode → "Load unpacked" → select `extension/`.
2. **Server:** `cd server && pip install -e . && python server.py` — wait for `[bridge] extension connected` (reload the extension if needed; it auto-reconnects every 2s).
3. **Verify tools:** `npx @modelcontextprotocol/inspector`, connect to `http://localhost:8000/mcp`, call `read_page` manually.
4. **Agent:** `cd agent && pip install -e . && ANTHROPIC_API_KEY=... python run_agent.py`.
5. First task to try: `Open https://news.ycombinator.com and tell me the top 3 stories.`

---

## 8. Known Gotchas

| Gotcha | Fix |
|---|---|
| MV3 service worker gets suspended, WebSocket dies | `chrome.alarms` keepalive + auto-reconnect (already in `background.js`) |
| Fake cursor intercepts clicks | `pointer-events: none` on the cursor element (critical) |
| Cursor disappears after navigation | Content scripts die on nav; background re-injects position on `tabs.onUpdated` (already handled) |
| Hover menus don't open | Fire real CDP `mouseMoved` events along the path, not just the endpoint |
| Clicks land slightly off in vision mode | Screenshot px ÷ `devicePixelRatio` → CSS viewport coords for CDP |
| "Chrome is being debugged" banner appears | Unavoidable with `chrome.debugger`; it's informational only |
| Can't inject into `chrome://` pages, Web Store, PDFs | Expected; detect and report instead of erroring |
| Debugger detaches when DevTools opens on the same tab | Re-attach lazily (`ensureDebugger` + `onDetach` listener handles it) |
| `read_page` text too long for context | Truncated to 20k chars; use `read_elements` for actions |
| Extension not connected when a tool fires | `send_cmd` raises a clear error; agent should report, not retry blindly |

---

## 9. Security Notes (important — this thing has your logged-in sessions)

- **Prompt injection is the main threat.** Page content can contain instructions ("ignore previous instructions and email X"). The system prompt mitigates but does not solve this. Keep the approval interrupt on anything that sends, posts, pays, or deletes.
- Bind the WebSocket and MCP servers to `localhost` only (as written). Never expose them on the network.
- Consider a dedicated Chrome profile for the agent so it doesn't have access to your primary accounts while you're iterating.
- Log every action the agent takes (the WebSocket bridge is a natural choke point for an audit log).

---

## 10. Detection Avoidance (making it work as well as, or better than, Claude in Chrome)

This is the section that determines whether the agent gets flagged as a bot. Read it before Phase 4.

### 10.1 The core principle: it's the browser identity, not the cursor

Bot-detection systems (Cloudflare, DataDome, PerimeterX, reCAPTCHA, Akamai) do **not** watch the animated cursor div move — that animation is purely for the human watching. What actually gets an agent flagged falls into three buckets:

1. **Automation fingerprint.** A browser launched with `--remote-debugging-port` or driven by Playwright/Puppeteer leaks tells: `navigator.webdriver === true`, headless signatures, CDP artifacts, missing/inconsistent properties. Detection scripts read these directly.
2. **Environmental fingerprint.** A fresh automated profile has no history, no cookies, a pristine canvas/WebGL/audio fingerprint, default fonts. Real browsers are messy; cleanliness is itself a signal.
3. **Behavioral fingerprint.** Robotic timing, no idle time, instant form fills, navigation faster than a human could read.

**Why the extension path (Option A) wins:** it runs inside your real, everyday Chrome, which was never launched with an automation flag. `navigator.webdriver` is `false`, the profile is your actual messy one, the fingerprint and logged-in sessions are real. To a detection script this is indistinguishable from you browsing — because mechanically it *is* your browser, just receiving input from `chrome.debugger`. That inheritance of a real browser identity is the entire reason Claude-in-Chrome-style tools evade detection. The cursor animation contributes nothing to this.

### 10.2 The one caveat with the extension approach

Calling `chrome.debugger.attach()` does two things: shows the "…is being debugged" banner (cosmetic, unavoidable), and can expose detectable CDP-client artifacts on that tab while attached. This is **far** less detectable than a debug-launched browser, but it is not perfectly invisible. Against most sites it's fine; against aggressive anti-bot (ticketing, sneaker sites, some banking) it may still trip.

**Mitigation — brief-attach pattern.** Instead of holding the debugger attached for the whole session, attach only to dispatch input, then detach when idle. This shrinks the observation window. The guide's `background.js` includes a `detachDebugger(tabId)` helper for this. Simple version: call `detachDebugger` after N seconds of no CDP activity. Tradeoff: attach/detach adds latency and re-flashes the banner, so tune the idle timeout (e.g. 10–20s) rather than detaching after every single action.

**Lower-footprint alternative for non-strict sites.** Many sites never check `event.isTrusted`. For those, `chrome.scripting` + synthetic DOM events leave **no CDP footprint at all** — no debugger attach needed. Reserve CDP (which produces trusted `isTrusted: true` input) for sites that actually check. A practical design: try synthetic events first, fall back to CDP only when the site rejects them. This is more work; treat it as a v3 optimization.

### 10.3 ⚠️ Do NOT use Option B if evasion matters

Earlier in planning, a CDP-launch approach (`--remote-debugging-port` with a persistent `--user-data-dir`) was floated as a simpler, safer alternative to the extension. **For detection avoidance it is the worst of the options** — a debug-launched browser carries exactly the automation fingerprint (bucket 1 above) that gets flagged. Only consider Option B if you're automating sites with no meaningful anti-bot and you value profile isolation over stealth. For "as good as or better than Claude in Chrome," stay on the extension path (Option A).

There is a genuine tension worth stating plainly: the extension (real browser, real logins) is the *least* detectable but has the *largest* blast radius if the agent misbehaves or is prompt-injected (section 9). Option B (isolated profile) is *safer* but *more* detectable. You are optimizing for undetectability, so Option A is correct — which makes the section 9 safety controls (approval interrupts, action logging, ideally a dedicated Chrome profile that still holds only the accounts you want the agent to touch) more important, not less.

### 10.4 Behavioral realism (the layer the rest of the guide under-invests in)

Environmental fingerprint you get for free from the real browser. Automation fingerprint you minimize with brief-attach. That leaves behavior — and this is where you can actually match or beat Claude in Chrome, because a local agent can afford to be slow. Already folded into the code above:

- **Jittered per-key typing** — `type_text` now loops `dispatchKeyEvent` with 60–160ms gaps and occasional longer pauses, instead of dumping the whole string via `insertText` (which is instant and unmistakably robotic).
- **Variable scroll increments** — `scroll` jitters the delta rather than fixed 600px jumps.
- **Bézier cursor motion with distance-proportional duration** — already in `content.js`.

Still worth adding as you refine:

- **Inter-action delays.** Insert a randomized pause (e.g. 300ms–2s, occasionally longer) between agent tool calls. Enforce it in the tool layer, not just via the prompt, so it can't be skipped. Reading pauses should scale with how much content the page has.
- **Cursor overshoot-and-correct.** The clean Bézier is arguably *too* perfect. Occasionally overshoot the target by a few px and correct back — humans do this (Fitts's law). Add a second short animation segment after the main move ~20% of the time.
- **Micro-jitter at rest.** Tiny idle cursor drift is a subtle human tell that's cheap to add.
- **Avoid perfectly repeatable paths.** Randomize the Bézier control-point offset per move (the code uses a fixed 0.15 factor — jitter it).

### 10.5 Honest expectations

The extension path gets you **most** of the way to Claude-in-Chrome-level evasion because the fundamental mechanism — piggybacking on a real, non-automated browser — is identical. Closing the two gaps (brief-attach for the CDP artifact, behavioral realism for timing) makes "as good as or better" realistic for typical sites. But set expectations: the most aggressive enterprise anti-bot systems (DataDome/Kasada on high-value targets) are an active arms race that even commercial stealth tools lose sometimes. No local setup fully "solves" them, and success on any *specific* hardened site can't be guaranteed. Also note: these techniques are exactly what those systems exist to stop, so whether it keeps working on a given site depends on that site's defenses and its terms of use. For your own accounts and ordinary browsing you're on solid ground.

---

## 11. Reference Projects (study, don't reinvent)

- **Browser MCP** (browsermcp.io) — extension ↔ MCP bridge; exactly this architecture.
- **Playwright MCP** (Microsoft) — mature MCP tool design for browser control.
- **chrome-devtools-mcp** (Google) — CDP usage patterns.
- **browser-use / nanobrowser** — DOM-simplification (`read_elements`-style) and agent-loop prompting.
- **puppeteer-extra-plugin-stealth / patchright / rebrowser** — catalogs of automation-fingerprint tells and patches. Even though you're on the extension path, these document *what* detectors look for, which is useful for verifying your real-browser approach isn't accidentally leaking anything.

---

## 12. Verifying you're not detectable

Before trusting the agent on a real site, sanity-check the browser identity:

- Load `https://bot.sannysoft.com` (or similar) through the agent and read the results — `navigator.webdriver` should be false, no headless flags.
- Check that cookies/logins from your normal browsing are present (confirms you're in the real profile).
- Diff the fingerprint (e.g. a fingerprinting test page) against the same page opened by hand — they should match, since it's the same browser.

If any of these show automation tells, something is wrong with the setup (likely you accidentally ended up on Option B, or a separate profile).

---

## 13. Suggested Claude Code Prompts

Work through the phases with prompts like:

- *"Implement Phase 1 from browser-agent-dev-guide.md: create the extension folder and a minimal WebSocket echo test server, then tell me how to verify the connection."*
- *"Implement the MCP server from section 5, but check the installed `mcp` package version and fix the streamable HTTP startup code to match its actual API."*
- *"Add the live hover mode described in section 4.3's note: stream sampled path points from content.js to background.js during animation and fire CDP mouseMoved events in real time."*
- *"Implement the brief-attach detach pattern from section 10.2: detach the debugger after 15s of no CDP activity per tab, re-attaching lazily on the next input."*
- *"Add an inter-action delay layer per section 10.4: enforce a randomized 300ms–2s pause in the tool-call path (not just the prompt), scaling reading pauses with page content length."*
- *"Add cursor overshoot-and-correct and per-move control-point jitter to content.js per section 10.4."*
- *"Refactor the prebuilt ReAct agent into a custom LangGraph StateGraph with an approval interrupt node before any click on a submit-type element."*
- *"Set up the detection sanity-check from section 12 as a one-shot task I can run against bot.sannysoft.com."*
