"""OtterBridge - browser-agent MCP server.

A standard MCP server (streamable HTTP transport) that exposes browser
actions as MCP tools and bridges them to the Otter Chrome extension over a
localhost WebSocket. Any MCP client can attach:

    http://localhost:8000/mcp

Verified against mcp==1.28.1 (FastMCP.run_streamable_http_async, default
host 127.0.0.1, port 8000, path /mcp).

Part of the Otter browser-agent project. Author: wen-da-ng (OtterBridge).
"""
import asyncio
import base64
import json
import os
import re
import sys
import uuid
from datetime import datetime, timezone

import websockets
from mcp.server.fastmcp import Context, FastMCP, Image
from pydantic import BaseModel


# All diagnostics go to STDERR, never STDOUT. In --stdio mode STDOUT is the MCP
# transport channel, so a stray print there corrupts the protocol. STDERR is
# safe in both modes (Claude Desktop captures it to mcp-server-OtterBridge.log).
def log(*args) -> None:
    print(*args, file=sys.stderr, flush=True)

mcp = FastMCP(
    "OtterBridge",
    instructions=(
        "OtterBridge controls the user's real Chrome browser through the Otter "
        "extension. Observe with read_page / read_elements, then act with "
        "click_element (preferred) / type_text / press_key / navigate / scroll. "
        "Built by wen-da-ng."
    ),
)

# ===== Phase 6: safety =====
# Audit log — every dispatched action is appended here (guide section 9:
# the WebSocket bridge is the natural choke point for accountability).
AUDIT_LOG = os.path.join(os.path.dirname(os.path.abspath(__file__)), "agent_actions.log")

# Words that mark a click target as destructive / committing. Clicks landing
# on an element whose text matches trigger a human-approval prompt.
DANGER_RE = re.compile(
    r"\b(buy|purchase|pay|checkout|order|place\s+order|delete|remove|"
    r"send|submit|confirm|transfer|withdraw|post|publish|unsubscribe)\b",
    re.IGNORECASE,
)

# Gate behavior, tunable via env:
#   BROWSER_AGENT_GATE=elicit (default) | off
#   BROWSER_AGENT_GATE_FALLBACK=deny (default) | allow   # used if the client
#       cannot show an elicitation prompt (fail-safe = deny).
GATE_MODE = os.environ.get("BROWSER_AGENT_GATE", "elicit").lower()
GATE_FALLBACK = os.environ.get("BROWSER_AGENT_GATE_FALLBACK", "deny").lower()


def audit(action: str, params: dict | None = None, note: str = "") -> None:
    line = json.dumps({
        "ts": datetime.now(timezone.utc).isoformat(),
        "action": action,
        "params": params or {},
        "note": note,
    })
    log(f"[audit] {line}")
    try:
        with open(AUDIT_LOG, "a", encoding="utf-8") as fh:
            fh.write(line + "\n")
    except OSError as e:
        log(f"[audit] WARNING could not write log: {e}")


class Confirm(BaseModel):
    """Approve or decline the pending destructive browser action."""


async def approved(ctx: Context, message: str) -> bool:
    """Ask the human to approve a destructive action via MCP elicitation.
    Returns True only on explicit approval. Fail-safe on any error."""
    if GATE_MODE == "off":
        return True
    try:
        res = await ctx.elicit(message=message, schema=Confirm)
    except Exception as e:  # client can't elicit (unsupported / no prompt UI)
        audit("gate", note=f"elicit-unavailable ({e}); fallback={GATE_FALLBACK}")
        return GATE_FALLBACK == "allow"
    ok = getattr(res, "action", None) == "accept"
    audit("gate", note=f"user {'approved' if ok else 'denied'}: {message}")
    return ok

# ===== WebSocket bridge =====
ext_socket = None            # the connected extension, if any
pending: dict[str, asyncio.Future] = {}


def _origin_allowed(origin) -> bool:
    # Only the Otter extension (chrome-extension:// Origin) or a non-browser
    # local client (no Origin header) may attach. A web page the user visits can
    # otherwise open ws://localhost:8765 and displace the extension —
    # intercepting agent commands (incl. typed secrets) and feeding back
    # fabricated page data. Any http(s) page Origin is rejected.
    return origin is None or origin.startswith("chrome-extension://")


async def ws_handler(ws):
    global ext_socket
    origin = ws.request.headers.get("Origin")
    if not _origin_allowed(origin):
        log(f"[bridge] rejected connection from origin: {origin}")
        await ws.close(code=1008, reason="origin not allowed")
        return
    ext_socket = ws
    log("[bridge] extension connected")
    try:
        async for msg in ws:
            data = json.loads(msg)
            fut = pending.pop(data.get("id"), None)
            if fut and not fut.done():
                fut.set_result(data)
    finally:
        if ext_socket is ws:
            ext_socket = None
        log("[bridge] extension disconnected")


async def send_cmd(action: str, params: dict | None = None, timeout: float = 30):
    if ext_socket is None:
        raise RuntimeError(
            "Chrome extension is not connected. Is Chrome open with the "
            "extension loaded?"
        )
    audit(action, params)
    fut = asyncio.get_event_loop().create_future()
    cmd_id = str(uuid.uuid4())
    pending[cmd_id] = fut
    await ext_socket.send(json.dumps({
        "id": cmd_id, "action": action, "params": params or {},
    }))
    try:
        resp = await asyncio.wait_for(fut, timeout=timeout)
    finally:
        pending.pop(cmd_id, None)
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
async def click(x: int, y: int, ctx: Context) -> str:
    """Move the cursor with a human-like animation to viewport
    coordinates (x, y) and click there. Destructive targets (buy, pay,
    delete, send, submit, ...) require human approval before dispatch."""
    # Hit-test the actual element at (x, y) so the gate works for every
    # click — vision-mode, read_elements, or raw coordinates alike.
    try:
        info = await send_cmd("hit_test", {"x": x, "y": y})
        text = (info or {}).get("text", "")
    except Exception as e:
        audit("hit_test", {"x": x, "y": y}, note=f"failed ({e}); proceeding")
        text = ""
    if DANGER_RE.search(text):
        label = text.strip()[:60] or f"({x}, {y})"
        if not await approved(
            ctx, f"Approve clicking the '{label}' element? This looks destructive."
        ):
            return f"Action denied by user: click on '{label}'."
    return await send_cmd("click", {"x": x, "y": y})


@mcp.tool()
async def click_element(index: int, ctx: Context) -> str:
    """Click the interactive element with the given index from read_elements.

    PREFERRED over click(x, y): the coordinate is resolved inside the page,
    so it can't drift through screenshot scaling. Call read_elements first to
    get indices, then click_element(index)."""
    info = await send_cmd("locate_element", {"index": index})
    if not info or not info.get("found"):
        return (f"No interactive element with index {index}. "
                f"Call read_elements to refresh the list first.")
    text = info.get("text", "")
    if DANGER_RE.search(text):
        label = text.strip()[:60] or f"element {index}"
        if not await approved(
            ctx, f"Approve clicking the '{label}' element? This looks destructive."
        ):
            return f"Action denied by user: click on '{label}'."
    # Pass index so the extension re-resolves the live position right before
    # pressing (immune to reflow during the cursor animation).
    return await send_cmd("click", {"x": info["x"], "y": info["y"], "index": index})


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
async def screenshot() -> Image:
    """Capture the visible viewport as an image you can see.

    Use screenshots to understand the page and decide WHAT to act on, then
    click via read_elements + click_element(index) for pixel-accurate clicks.
    (Coordinates eyeballed off an image can drift; index-based clicking does
    not.)"""
    result = await send_cmd("screenshot")
    audit("screenshot", note=(
        f"viewport={result.get('width')}x{result.get('height')} "
        f"dpr={result.get('dpr')} "
        f"captured={result.get('capturedWidth')}x{result.get('capturedHeight')}"
    ))
    fmt = result.get("format", "png")
    return Image(data=base64.b64decode(result["base64"]), format=fmt)


# ===== Run both servers =====
# Two transports, one codebase. In BOTH modes we host the WebSocket bridge on
# :8765 so the Otter extension can attach; only the MCP-client-facing transport
# differs:
#   (default)  streamable HTTP at http://localhost:8000/mcp  — for Claude Code,
#              MCP Inspector, or any HTTP MCP client you start the server for.
#   --stdio    stdio transport — for Claude Desktop, which LAUNCHES this script
#              itself (via claude_desktop_config.json) and speaks over stdio.
#              STDOUT is the protocol channel here; keep all logging on STDERR.
async def main():
    use_stdio = "--stdio" in sys.argv
    # max_size raised well above the 1 MiB default: screenshot PNGs of large
    # viewports easily exceed it, which otherwise closes the socket with a
    # 1009 "message too big" error mid-capture.
    try:
        await websockets.serve(ws_handler, "localhost", 8765, max_size=32 * 1024 * 1024)
        log("[bridge] WebSocket listening on ws://localhost:8765")
    except OSError as e:
        # Most commonly: another OtterBridge instance already owns :8765. Only
        # one process can bridge the extension at a time (run EITHER the HTTP
        # server OR let Claude Desktop launch the --stdio one, not both).
        log(f"[bridge] FATAL could not bind ws://localhost:8765: {e}")
        raise
    if use_stdio:
        log("[bridge] MCP transport: stdio (Claude Desktop)")
        await mcp.run_stdio_async()
    else:
        log("[bridge] MCP transport: streamable HTTP at http://localhost:8000/mcp")
        await run_http_guarded()


async def run_http_guarded():
    """Serve the streamable-HTTP app with a Host allowlist (DNS-rebinding
    defense). A malicious site can rebind its name to 127.0.0.1 and reach this
    endpoint same-origin (bypassing CORS), then drive the browser via MCP tools;
    the rebound request still carries the attacker's name in the Host header, so
    we reject any Host that isn't loopback. Replaces mcp.run_streamable_http_async()
    (same app, host, and port) with the middleware added."""
    import uvicorn
    from starlette.middleware.trustedhost import TrustedHostMiddleware

    app = mcp.streamable_http_app()
    # TrustedHostMiddleware compares the Host header (port stripped) to this list.
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=["localhost", "127.0.0.1"])
    config = uvicorn.Config(
        app,
        host=mcp.settings.host,
        port=mcp.settings.port,
        log_level="warning",
    )
    await uvicorn.Server(config).serve()


if __name__ == "__main__":
    asyncio.run(main())
