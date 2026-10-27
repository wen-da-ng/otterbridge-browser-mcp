#!/usr/bin/env node
/**
 * OtterBridge - browser-agent MCP server (Node/TypeScript port).
 *
 * A standard MCP server that exposes browser actions as MCP tools and bridges
 * them to the Otter Chrome extension over a localhost WebSocket. Two transports,
 * one codebase:
 *
 *   (default)  streamable HTTP at http://localhost:8000/mcp  - Claude Code,
 *              MCP Inspector, or any HTTP MCP client you start the server for.
 *   --stdio    stdio transport - Claude Desktop / the .mcpb bundle, which
 *              LAUNCHES this script itself and speaks over stdio.
 *
 * Both modes host the ws://localhost:8765 bridge the Otter extension attaches
 * to. The WebSocket protocol is byte-compatible with the Python server, so the
 * same unchanged extension works against either.
 *
 * Verified against @modelcontextprotocol/sdk 1.29.0.
 *
 * Part of the Otter browser-agent project. Author: wen-da-ng (OtterBridge).
 */
import { randomUUID } from "node:crypto";
import { appendFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { WebSocket, WebSocketServer } from "ws";

// ---------------------------------------------------------------------------
// Logging. All diagnostics go to STDERR, never STDOUT. In --stdio mode STDOUT
// is the MCP transport channel, so a stray write there corrupts the protocol.
// STDERR is safe in both modes (Claude Desktop captures it to
// mcp-server-OtterBridge.log).
// ---------------------------------------------------------------------------
function log(...args: unknown[]): void {
  console.error(...args);
}

const __dirname = dirname(fileURLToPath(import.meta.url));

// ===== Phase 6: safety =====
// Audit log - every dispatched action is appended here. The WebSocket bridge
// is the natural choke point for accountability.
const AUDIT_LOG = join(__dirname, "..", "agent_actions.log");

// Words that mark a click target as destructive / committing. Clicks landing
// on an element whose text matches trigger a human-approval prompt.
const DANGER_RE =
  /\b(buy|purchase|pay|checkout|order|place\s+order|delete|remove|send|submit|confirm|transfer|withdraw|post|publish|unsubscribe)\b/i;

// Gate behavior, tunable via env. Both a human-readable form and a boolean-ish
// form are accepted, so the same server works from a shell (elicit/off,
// deny/allow) and from the .mcpb manifest, where user_config booleans
// substitute as the strings "true"/"false":
//   BROWSER_AGENT_GATE=elicit (default) | off | true | false
//       -> gate is OFF only for: off | false | 0 | no
//   BROWSER_AGENT_GATE_FALLBACK=deny (default) | allow | false | true
//       -> used when the client can't show an approval prompt (fail-safe=deny).
//          allow ONLY for: allow | true | 1 | yes
const gateRaw = (process.env.BROWSER_AGENT_GATE ?? "elicit").toLowerCase();
const GATE_OFF = ["off", "false", "0", "no"].includes(gateRaw);
const fallbackRaw = (process.env.BROWSER_AGENT_GATE_FALLBACK ?? "deny").toLowerCase();
const FALLBACK_ALLOW = ["allow", "true", "1", "yes"].includes(fallbackRaw);

async function audit(
  action: string,
  params?: Record<string, unknown>,
  note = "",
): Promise<void> {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    action,
    params: params ?? {},
    note,
  });
  log(`[audit] ${line}`);
  try {
    await appendFile(AUDIT_LOG, line + "\n", "utf-8");
  } catch (e) {
    log(`[audit] WARNING could not write log: ${(e as Error).message}`);
  }
}

// ===== WebSocket bridge =====
// Several MCP clients (Claude Code + Claude Desktop, background sessions in
// other projects, ...) each launch their own server process. Each process binds
// the first free port in this range; the extension keeps one socket per port,
// so every server reaches the same browser and none of them fails to start.
// The extension scans the same range (extension/background.js BRIDGE_PORTS).
// OTTERBRIDGE_WS_PORT moves the base of the range — tests use one far OUTSIDE
// it so the user's real extension never attaches to a test server.
const BASE_PORT = Number(process.env.OTTERBRIDGE_WS_PORT) || 8765;
const BRIDGE_PORTS = Array.from({ length: 10 }, (_, i) => BASE_PORT + i);
let bridgePort: number | null = null;

let extSocket: WebSocket | null = null; // the connected extension, if any
interface Pending {
  resolve: (data: WsResponse) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  socket: WebSocket;
}
interface WsResponse {
  id: string;
  result?: unknown;
  error?: string;
}
const pending = new Map<string, Pending>();

// Only the Otter extension (or a non-browser local client) may attach to the
// bridge. A web page the user visits can otherwise open ws://localhost:8765 and
// displace the extension — intercepting agent commands (incl. typed secrets)
// and feeding back fabricated page data. The extension connects with a
// `chrome-extension://` Origin; native clients (tests, echo harness) send none.
// Any http(s) page Origin is rejected.
function originAllowed(origin: string | undefined): boolean {
  if (!origin) return true; // non-browser client (no Origin header)
  return origin.startsWith("chrome-extension://");
}

// Bind one port; resolves with the server, rejects (and cleans up) on error.
function bindBridge(port: number): Promise<WebSocketServer> {
  return new Promise((resolve, reject) => {
    // max payload raised well above the ~1 MiB default: screenshot JPEGs of
    // large viewports easily exceed it, which otherwise closes the socket with
    // a 1009 "message too big" error mid-capture.
    const wss = new WebSocketServer({
      host: "localhost",
      port,
      maxPayload: 32 * 1024 * 1024,
      verifyClient: (info: { origin: string | undefined }) => {
        const ok = originAllowed(info.origin);
        if (!ok) log(`[bridge] rejected connection from origin: ${info.origin}`);
        return ok;
      },
    });
    wss.once("listening", () => resolve(wss));
    wss.once("error", (err) => {
      wss.close();
      reject(err);
    });
  });
}

async function startBridge(): Promise<void> {
  let wss: WebSocketServer | null = null;
  let lastErr: Error | null = null;
  for (const port of BRIDGE_PORTS) {
    try {
      wss = await bindBridge(port);
      bridgePort = port;
      break;
    } catch (e) {
      lastErr = e as Error; // EADDRINUSE: another OtterBridge client owns it
    }
  }
  if (!wss) {
    const range = BRIDGE_PORTS.length > 1
      ? `${BRIDGE_PORTS[0]}-${BRIDGE_PORTS[BRIDGE_PORTS.length - 1]}`
      : String(BRIDGE_PORTS[0]);
    log(`[bridge] FATAL could not bind any ws://localhost:${range}: ${lastErr?.message}`);
    throw lastErr ?? new Error("no bridge port available");
  }
  log(`[bridge] WebSocket listening on ws://localhost:${bridgePort}`);

  wss.on("connection", (ws) => {
    extSocket = ws;
    log("[bridge] extension connected");
    ws.on("message", (raw) => {
      let data: WsResponse;
      try {
        data = JSON.parse(raw.toString());
      } catch {
        return; // ignore non-JSON frames
      }
      const entry = pending.get(data.id);
      if (entry) {
        clearTimeout(entry.timer);
        pending.delete(data.id);
        entry.resolve(data);
      }
    });
    ws.on("close", () => {
      if (extSocket === ws) extSocket = null;
      // Fail in-flight commands now instead of letting each sit out its timeout.
      for (const [id, entry] of pending) {
        if (entry.socket !== ws) continue;
        clearTimeout(entry.timer);
        pending.delete(id);
        entry.reject(new Error("Chrome extension disconnected mid-command."));
      }
      log("[bridge] extension disconnected");
    });
    ws.on("error", (err) => log(`[bridge] socket error: ${err.message}`));
  });
}

// The extension rescans the port range every few seconds, so a freshly started
// server can see its first tool call before the extension has attached. Give it
// a short grace period rather than failing that call outright.
async function waitForExtension(ms = 6000): Promise<WebSocket> {
  const deadline = Date.now() + ms;
  while (!extSocket || extSocket.readyState !== WebSocket.OPEN) {
    if (Date.now() >= deadline) {
      throw new Error(
        "Chrome extension is not connected. Is Chrome open with the extension loaded?",
      );
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return extSocket;
}

async function sendCmd(
  action: string,
  params?: Record<string, unknown>,
  timeoutMs = 30000,
  logged = true,
): Promise<any> {
  const socket = await waitForExtension();
  if (logged) await audit(action, params);
  const id = randomUUID();
  const data: WsResponse = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timed out after ${timeoutMs}ms waiting for '${action}'.`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer, socket });
    socket.send(JSON.stringify({ id, action, params: params ?? {} }));
  });
  if (data.error) throw new Error(data.error);
  return data.result;
}

// ===== Destructive-action gate =====
// Full Auto is a USER switch in the extension popup — deliberately not
// reachable through any tool, so a prompt-injected agent can't turn off its
// own approvals. Read fresh on every gate so flipping it applies immediately to
// every connected client. Anything but an explicit "auto" means ask.
async function fullAuto(): Promise<boolean> {
  try {
    const r = await sendCmd("get_approval_mode", undefined, 3000, false);
    return r?.mode === "auto";
  } catch {
    return false;
  }
}

// Ask the human to approve a destructive action via MCP elicitation. Returns
// true only on explicit approval. Fail-safe on any error (client can't elicit).
async function approved(server: McpServer, message: string): Promise<boolean> {
  if (GATE_OFF) return true;
  if (await fullAuto()) {
    await audit("gate", undefined, `auto-approved (Full Auto): ${message}`);
    return true;
  }
  try {
    const res = await server.server.elicitInput({
      message,
      // Empty object schema: the confirm is the accept/decline action itself,
      // mirroring the Python server's empty Confirm model.
      requestedSchema: { type: "object", properties: {} },
    });
    const ok = res.action === "accept";
    await audit("gate", undefined, `user ${ok ? "approved" : "denied"}: ${message}`);
    return ok;
  } catch (e) {
    // Client can't elicit (unsupported / no prompt UI).
    await audit(
      "gate",
      undefined,
      `elicit-unavailable (${(e as Error).message}); fallback=${FALLBACK_ALLOW ? "allow" : "deny"}`,
    );
    return FALLBACK_ALLOW;
  }
}

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });

// One MCP session == one agent == one Chrome window holding one tab group. Each
// buildServer() call (per HTTP session, or the single stdio session) gets its
// own agent id. Ids are random, not sequential: several server processes share
// one extension, and a restarted server must not inherit a stale "a1" window.
const CLIENT_NAMES: Record<string, string> = {
  "claude-code": "Claude Code",
  "claude-ai": "Claude Desktop",
};

// ===== MCP server + tools =====
// A factory so each streamable-HTTP session gets its own McpServer instance
// (elicitation routes back to that session's client), while stdio uses one.
function buildServer(): McpServer {
  const server = new McpServer(
    { name: "otterbridge-browser-mcp", version: "0.4.0" },
    {
      instructions:
        "OtterBridge controls the user's real Chrome browser through the Otter " +
        "extension. Observe with read_page / read_elements / screenshot / " +
        "find_text; act with click_element (preferred) / fill_element / " +
        "select_option / press_key / navigate / scroll. Use wait_for for " +
        "dynamic content instead of polling screenshots. Replay a previously " +
        "completed flow at full speed with run_script (durable selector/text " +
        "targets + {{placeholder}} vars — record after finishing a flow " +
        "interactively). Debug web apps with " +
        "read_console / read_network / get_network_body. This session works " +
        "in its OWN Chrome window and tab group, created automatically on the " +
        "first tool call; open_tab adds more tabs to it. Every tool takes an " +
        "optional 'tab' id, defaulting to this session's current tab. The " +
        "user's own tabs are read-only: get_user_tab returns the tab they are " +
        "looking at, for read_page / read_elements / find_text / screenshot. " +
        "Built by wen-da-ng.",
    },
  );

  // Per-session identity + owned-tab state. Every command carries agentId so
  // the extension can confine actions to this session's own window/group.
  const agentId = randomUUID().slice(0, 8);
  const clientName = () => {
    const n = server.server.getClientVersion()?.name;
    return n ? (CLIENT_NAMES[n] ?? n) : undefined;
  };
  const sess: { currentTab: number | null } = { currentTab: null };

  // open_tab is the ONLY way a session gets a tab, and the extension always
  // places it in the session's own window + group. With no current tab, the
  // first tool call opens one rather than falling back to whatever tab the
  // user happens to have active.
  const openSessionTab = async (url?: string) => {
    const info = await sendCmd("open_tab", { agentId, clientName: clientName(), url });
    sess.currentTab = info.tabId;
    return info;
  };
  let opening: Promise<number> | null = null; // dedupes concurrent first calls
  const ensureTab = async (): Promise<number> => {
    if (sess.currentTab != null) return sess.currentTab;
    opening ??= openSessionTab()
      .then((i) => i.tabId as number)
      .finally(() => {
        opening = null;
      });
    return opening;
  };

  // Dispatch a tab-scoped command: explicit `tab`, else the session's tab.
  const act = async (
    action: string,
    tab: number | undefined,
    params: Record<string, unknown> = {},
    timeoutMs?: number,
  ): Promise<any> => {
    const tabId = tab ?? (await ensureTab());
    try {
      return await sendCmd(action, { ...params, agentId, tabId }, timeoutMs);
    } catch (e) {
      const msg = (e as Error).message;
      if (tab == null && /^Tab \d+ not found/.test(msg)) {
        // The user closed the session's tab (or its window). Forget it so the
        // next call opens a fresh one — but say so: the page state is gone.
        sess.currentTab = null;
        throw new Error(
          `${msg} The session's tab is gone; the next call opens a fresh one in ` +
            `the session window (or call open_tab with a URL).`,
        );
      }
      throw e;
    }
  };

  const TAB = {
    tab: z
      .number()
      .int()
      .optional()
      .describe(
        "Target tab id (from open_tab/list_tabs). Omit to use this session's current tab (opened automatically in the session's own window).",
      ),
  };
  // Read-only tools may also target the user's own tab via get_user_tab.
  const READ_TAB = {
    tab: z
      .number()
      .int()
      .optional()
      .describe(
        "Target tab id: one of this session's tabs (open_tab/list_tabs), or the user's tab from get_user_tab (read-only). Omit to use this session's current tab.",
      ),
  };

  // Gate + press a click atomically with respect to the destructive-action
  // check. The danger check runs on `expectText`; the click is dispatched with
  // that same text so the extension REFUSES to press if the live element no
  // longer matches (returning { changed }). If it changed, we re-gate the
  // element that is actually there now — the gate can never approve one element
  // while a reflow swaps in another. Fail-safe: a target that keeps changing is
  // aborted rather than pressed. Used by both click and click_element.
  const gatedClick = async (
    tab: number | undefined,
    target: { index?: number; x?: number; y?: number },
    initialText: string,
    fast = false,
    background = false,
  ): Promise<string> => {
    let expectText = initialText ?? "";
    for (let attempt = 0; attempt < 4; attempt++) {
      if (DANGER_RE.test(expectText)) {
        const label =
          expectText.trim().slice(0, 60) ||
          (target.index != null ? `element ${target.index}` : `(${target.x}, ${target.y})`);
        if (!(await approved(server, `Approve clicking the '${label}' element? This looks destructive.`))) {
          return `Action denied by user: click on '${label}'.`;
        }
      }
      const res = await act("click", tab, { ...target, expectText, fast, background });
      if (res && typeof res === "object" && res.changed) {
        // The element under the pointer changed after the gate decision. Never
        // press an ungated target — re-gate whatever is actually there now.
        const actual = (res.actualText as string) ?? "";
        await audit(
          "click",
          target as Record<string, unknown>,
          `target changed from '${expectText}' to '${actual}' before press; re-gating`,
        );
        if (actual === expectText) {
          return "Click aborted: could not confirm the target element. Re-read elements and retry.";
        }
        expectText = actual;
        continue;
      }
      return typeof res === "string" ? res : `Clicked at (${res.x}, ${res.y})`;
    }
    return "Click aborted: the target element kept changing under the pointer. Re-read elements and retry.";
  };

  server.registerTool(
    "navigate",
    {
      description: "Navigate a browser tab to a URL and wait for load.",
      inputSchema: { url: z.string(), ...TAB },
    },
    async ({ url, tab }) => text(await act("navigate", tab, { url })),
  );

  server.registerTool(
    "go_back",
    {
      description: "Go back one step in the tab's history (like the Back button).",
      inputSchema: { ...TAB },
    },
    async ({ tab }) => text(await act("go_back", tab)),
  );

  server.registerTool(
    "go_forward",
    {
      description: "Go forward one step in the tab's history.",
      inputSchema: { ...TAB },
    },
    async ({ tab }) => text(await act("go_forward", tab)),
  );

  server.registerTool(
    "reload",
    {
      description: "Reload the tab. Set hard=true to bypass the HTTP cache.",
      inputSchema: {
        hard: z.boolean().optional().describe("Bypass the cache (like Ctrl+Shift+R)."),
        ...TAB,
      },
    },
    async ({ hard, tab }) => text(await act("reload", tab, { hard })),
  );

  server.registerTool(
    "read_page",
    {
      description:
        "Read a tab: URL, title, and visible text. Long pages paginate: the " +
        "result carries total_chars; pass offset to read the next chunk.",
      inputSchema: {
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Character offset into the page text (default 0)."),
        max_chars: z
          .number()
          .int()
          .min(1)
          .max(100000)
          .optional()
          .describe("Max characters to return (default 20000)."),
        ...READ_TAB,
      },
    },
    async ({ offset, max_chars, tab }) =>
      text(JSON.stringify(await act("read_page", tab, { offset, maxChars: max_chars }))),
  );

  server.registerTool(
    "read_elements",
    {
      description:
        "List interactive elements on the page as numbered entries with center " +
        "coordinates. Use the coordinates with the click tool.",
      inputSchema: { ...READ_TAB },
    },
    async ({ tab }) => text(JSON.stringify(await act("read_elements", tab))),
  );

  server.registerTool(
    "click",
    {
      description:
        "Move the cursor with a human-like animation to viewport coordinates " +
        "(x, y) and click there. Destructive targets (buy, pay, delete, send, " +
        "submit, ...) require human approval before dispatch.",
      inputSchema: { x: z.number().int(), y: z.number().int(), ...TAB },
    },
    async ({ x, y, tab }) => {
      // Hit-test the actual element at (x, y) so the gate works for every
      // click - vision-mode, read_elements, or raw coordinates alike.
      let targetText = "";
      try {
        const info = await act("hit_test", tab, { x, y });
        targetText = (info?.text as string) ?? "";
      } catch (e) {
        await audit("hit_test", { x, y }, `failed (${(e as Error).message}); proceeding`);
      }
      return text(await gatedClick(tab, { x, y }, targetText));
    },
  );

  server.registerTool(
    "click_element",
    {
      description:
        "Click the interactive element with the given index from read_elements.\n\n" +
        "PREFERRED over click(x, y): the coordinate is resolved inside the page, " +
        "so it can't drift through screenshot scaling. Call read_elements first " +
        "to get indices, then click_element(index).",
      inputSchema: { index: z.number().int(), ...TAB },
    },
    async ({ index, tab }) => {
      const info = await act("locate_element", tab, { index });
      if (!info || !info.found) {
        return text(
          `No interactive element with index ${index}. ` +
            `Call read_elements to refresh the list first.`,
        );
      }
      // gatedClick passes the index through to the extension, which re-resolves
      // the live position right before pressing (immune to reflow during the
      // cursor animation) and re-gates via `expectText` if it changed.
      return text(await gatedClick(tab, { index }, info.text ?? ""));
    },
  );

  server.registerTool(
    "fill_element",
    {
      description:
        "Focus the interactive element with the given read_elements index, " +
        "select its current content, and type the text over it with human-like " +
        "keystrokes. Empty text clears the field.\n\n" +
        "PREFERRED over click + type_text for form inputs: focusing and " +
        "clearing are atomic, so the text can't land in the wrong field.",
      inputSchema: {
        index: z.number().int().describe("Element index from read_elements."),
        text: z.string().describe("Text to type; empty string clears the field."),
        ...TAB,
      },
    },
    async ({ index, text: t, tab }) =>
      text(await act("fill_element", tab, { index, text: t })),
  );

  server.registerTool(
    "select_option",
    {
      description:
        "Pick an option in a native <select> dropdown by value or visible " +
        "label (native dropdowns can't be driven by clicks). On no match, the " +
        "error lists the available options.",
      inputSchema: {
        index: z.number().int().describe("read_elements index of the <select> element."),
        value: z.string().optional().describe("Option value attribute (exact match)."),
        label: z.string().optional().describe("Visible option text (exact, then substring match)."),
        ...TAB,
      },
    },
    async ({ index, value, label, tab }) => {
      if (value == null && label == null) {
        return text("Provide 'value' or 'label' to pick an option.");
      }
      return text(await act("select_option", tab, { index, value, label }));
    },
  );

  server.registerTool(
    "hover",
    {
      description:
        "Move the cursor to an element (by read_elements index) or to viewport " +
        "coordinates and hover there — triggers :hover styles, tooltips, and " +
        "hover-opened menus. Prefer index over raw coordinates.",
      inputSchema: {
        index: z.number().int().optional().describe("Element index from read_elements (preferred)."),
        x: z.number().int().optional().describe("Viewport x, if no index is given."),
        y: z.number().int().optional().describe("Viewport y, if no index is given."),
        ...TAB,
      },
    },
    async ({ index, x, y, tab }) => {
      if (index == null && (x == null || y == null)) {
        return text("Provide 'index', or both 'x' and 'y'.");
      }
      return text(await act("hover", tab, { index, x, y }));
    },
  );

  server.registerTool(
    "drag",
    {
      description:
        "Press the mouse at (from_x, from_y), glide to (to_x, to_y) with the " +
        "button held, and release — for sliders, sortable lists, canvas tools. " +
        "(HTML5 draggable=\"true\" native drag-and-drop may not respond to " +
        "synthetic events.)",
      inputSchema: {
        from_x: z.number().int(),
        from_y: z.number().int(),
        to_x: z.number().int(),
        to_y: z.number().int(),
        ...TAB,
      },
    },
    async ({ from_x, from_y, to_x, to_y, tab }) =>
      text(await act("drag", tab, { fromX: from_x, fromY: from_y, toX: to_x, toY: to_y })),
  );

  server.registerTool(
    "find_text",
    {
      description:
        "Search the page's visible text (case-insensitive) and return up to 50 " +
        "matches with center coordinates and surrounding context. By default " +
        "scrolls the first match into view — coordinates are post-scroll, so " +
        "they can be clicked directly.",
      inputSchema: {
        query: z.string().describe("Text to find."),
        nth: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Which match to scroll into view (default 0 = first)."),
        scroll: z
          .boolean()
          .optional()
          .describe("Scroll the nth match into view (default true; never on the user's tab)."),
        ...READ_TAB,
      },
    },
    async ({ query, nth, scroll, tab }) =>
      text(JSON.stringify(await act("find_text", tab, { query, nth, scroll }))),
  );

  server.registerTool(
    "wait_for",
    {
      description:
        "Wait until the page contains the given text (case-insensitive) and/or " +
        "an element matching the CSS selector appears. Use after actions that " +
        "load content dynamically instead of polling with screenshots.",
      inputSchema: {
        text: z.string().optional().describe("Visible text to wait for."),
        selector: z.string().optional().describe("CSS selector to wait for."),
        timeout_ms: z
          .number()
          .int()
          .min(100)
          .max(60000)
          .optional()
          .describe("Max wait in milliseconds (default 10000)."),
        ...READ_TAB,
      },
    },
    async ({ text: t, selector, timeout_ms, tab }) => {
      if (t == null && selector == null) {
        return text("Provide 'text' and/or 'selector' to wait for.");
      }
      const result = await act(
        "wait_for",
        tab,
        { text: t, selector, timeoutMs: timeout_ms },
        (timeout_ms ?? 10000) + 15000, // bridge timeout must outlast the poll
      );
      return text(JSON.stringify(result));
    },
  );

  server.registerTool(
    "type_text",
    {
      description: "Type text into the currently focused element.",
      inputSchema: { text: z.string(), ...TAB },
    },
    async ({ text: t, tab }) => text(await act("type_text", tab, { text: t })),
  );

  server.registerTool(
    "press_key",
    {
      description: "Press a keyboard key, e.g. 'Enter', 'Tab', 'Escape'.",
      inputSchema: { key: z.string(), ...TAB },
    },
    async ({ key, tab }) => text(await act("press_key", tab, { key })),
  );

  server.registerTool(
    "scroll",
    {
      description: "Scroll the page vertically. Positive = down, negative = up.",
      inputSchema: { delta_y: z.number().int().default(600), ...TAB },
    },
    async ({ delta_y, tab }) => text(await act("scroll", tab, { deltaY: delta_y })),
  );

  server.registerTool(
    "screenshot",
    {
      description:
        "Capture the visible viewport as an image you can see.\n\n" +
        "Use screenshots to understand the page and decide WHAT to act on, then " +
        "click via read_elements + click_element(index) for pixel-accurate " +
        "clicks. (Coordinates eyeballed off an image can drift; index-based " +
        "clicking does not.)",
      inputSchema: {
        full_page: z
          .boolean()
          .optional()
          .describe(
            "Capture the whole page height (capped at 8000px), not just the viewport. Not available on the user's tab.",
          ),
        ...READ_TAB,
      },
    },
    async ({ full_page, tab }) => {
      const result = await act("screenshot", tab, { fullPage: full_page });
      await audit(
        "screenshot",
        undefined,
        `viewport=${result.width}x${result.height} dpr=${result.dpr} ` +
          `captured=${result.capturedWidth}x${result.capturedHeight}`,
      );
      const fmt = (result.format as string) ?? "png";
      return {
        content: [
          {
            type: "image" as const,
            data: result.base64 as string,
            mimeType: `image/${fmt}`,
          },
        ],
      };
    },
  );

  // ===== Web-dev debugging (CDP capture) =====
  server.registerTool(
    "read_console",
    {
      description:
        "Read the tab's captured console output: console.* calls, uncaught " +
        "exceptions, and browser log entries (newest last, 500-entry ring " +
        "buffer). Capture starts when the tab first gets CDP attention " +
        "(open_tab attaches immediately); reload the tab to capture a full " +
        "page load.",
      inputSchema: {
        level: z
          .string()
          .optional()
          .describe("Filter by level: log | info | warning | error | debug."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .describe("Max entries to return (default 50)."),
        clear: z.boolean().optional().describe("Clear the buffer after reading."),
        ...TAB,
      },
    },
    async ({ level, limit, clear, tab }) =>
      text(JSON.stringify(await act("read_console", tab, { level, limit, clear }))),
  );

  server.registerTool(
    "read_network",
    {
      description:
        "List the tab's captured network requests (URL, method, status, type, " +
        "size; newest last, 300-entry ring buffer). Use get_network_body with " +
        "a requestId to fetch a response body. Capture starts when the tab " +
        "first gets CDP attention; reload the tab to capture a full page load.",
      inputSchema: {
        filter: z
          .string()
          .optional()
          .describe("Substring match on the URL, or a resource type (xhr, fetch, script, document, ...)."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(300)
          .optional()
          .describe("Max requests to return (default 50)."),
        clear: z.boolean().optional().describe("Clear the buffer after reading."),
        ...TAB,
      },
    },
    async ({ filter, limit, clear, tab }) =>
      text(JSON.stringify(await act("read_network", tab, { filter, limit, clear }))),
  );

  server.registerTool(
    "get_network_body",
    {
      description:
        "Fetch the response body of a captured network request (requestId from " +
        "read_network). Truncated at 50k chars; binary bodies come back " +
        "base64-encoded. Fails if Chrome has already evicted the body from its " +
        "cache.",
      inputSchema: {
        request_id: z.string().describe("requestId from read_network."),
        ...TAB,
      },
    },
    async ({ request_id, tab }) =>
      text(JSON.stringify(await act("get_network_body", tab, { requestId: request_id }))),
  );

  server.registerTool(
    "evaluate_js",
    {
      description:
        "Run a JavaScript expression in the page and return its result " +
        "(promises are awaited, result JSON-serialized). Doubly gated: the " +
        "Otter extension options must enable it, AND every call asks the user " +
        "for approval (unless the user switched the extension to Full Auto).",
      inputSchema: {
        code: z.string().describe("JavaScript expression to evaluate in the page."),
        ...TAB,
      },
    },
    async ({ code, tab }) => {
      const preview = code.length > 200 ? code.slice(0, 200) + "…" : code;
      if (!(await approved(server, `Approve running JavaScript in the page?\n\n${preview}`))) {
        return text("Action denied by user: evaluate_js.");
      }
      return text(JSON.stringify(await act("evaluate_js", tab, { code })));
    },
  );

  // ===== Script replay =====
  // One MCP call executes a whole recorded action sequence at native speed —
  // no model round-trip between steps. Elements are addressed by durable
  // descriptors (CSS selector / visible text), never by session-specific
  // indices, so a script recorded today replays tomorrow. String fields may
  // carry {{placeholders}} substituted from `vars` at call time, which is how
  // one recorded flow serves ever-changing inputs. The destructive-action
  // gate applies to every click step exactly as in interactive mode.
  const StepTarget = z.object({
    selector: z.string().optional().describe("CSS selector for the element (most durable)."),
    text: z.string().optional().describe("Visible text / label / placeholder / aria-label. Exact match wins over prefix over substring."),
    tag: z.string().optional().describe("Restrict to a tag, e.g. 'button', 'input', 'a'."),
    nth: z.number().int().min(0).optional().describe("Which match to use when several remain (default 0)."),
  });
  const Step = z.object({
    action: z.enum(["navigate", "click", "fill", "select", "type_text", "press_key", "scroll", "wait_for", "drag"]),
    url: z.string().optional().describe("navigate: URL to load."),
    target: StepTarget.optional().describe("click / fill / select: which element."),
    x: z.number().int().optional().describe("click: viewport x when no durable target exists (LAST resort — coordinates break on layout changes)."),
    y: z.number().int().optional().describe("click: viewport y when no durable target exists."),
    from_x: z.number().int().optional().describe("drag: start x."),
    from_y: z.number().int().optional().describe("drag: start y."),
    to_x: z.number().int().optional().describe("drag: end x."),
    to_y: z.number().int().optional().describe("drag: end y."),
    text: z.string().optional().describe("fill / type_text: text to type. wait_for: page text to wait for."),
    key: z.string().optional().describe("press_key: key name, e.g. 'Enter', 'Tab', 'Escape'."),
    value: z.string().optional().describe("select: option value attribute."),
    label: z.string().optional().describe("select: option visible label."),
    delta_y: z.number().int().optional().describe("scroll: pixels (positive = down)."),
    selector: z.string().optional().describe("wait_for: CSS selector to wait for."),
    timeout_ms: z.number().int().min(100).max(60000).optional().describe("wait_for: max wait (default 10000). click/fill/select: how long to wait for the target element to appear (default 8000)."),
    pause_ms: z.number().int().min(0).max(30000).optional().describe("Fixed pause AFTER this step (animations, debounced saves)."),
    optional: z.boolean().optional().describe("Continue with the next step even if this one fails."),
  });

  server.registerTool(
    "run_script",
    {
      description:
        "Replay a recorded browser flow in ONE call at full speed — no " +
        "per-step round-trips. Use this when repeating a flow you (or a saved " +
        "skill) already completed interactively.\n\n" +
        "Recording: after finishing a flow with the interactive tools, save " +
        "the equivalent steps with DURABLE targets — CSS selectors and/or " +
        "visible text, never read_elements indices — and insert wait_for " +
        "steps wherever the page loads content dynamically. Put every " +
        "run-specific value (dates, descriptions, amounts, ...) behind a " +
        "{{placeholder}} and supply fresh values via 'vars' on each replay.\n\n" +
        "Failure handling: the script stops at the first failed non-optional " +
        "step and returns per-step results. Take over with the interactive " +
        "tools from where it stopped, finish the task, then update the saved " +
        "script. Destructive clicks (buy, pay, send, delete, submit, ...) " +
        "still require human approval, exactly as in interactive mode.",
      inputSchema: {
        steps: z.array(Step).min(1).describe("Action sequence to execute in order."),
        vars: z
          .record(z.string(), z.string())
          .optional()
          .describe("Values substituted into {{placeholders}} in url / text / value / label / key / selector fields."),
        fast: z
          .boolean()
          .optional()
          .describe("Skip cursor animation and typing delays (default true)."),
        background: z
          .boolean()
          .optional()
          .describe(
            "Run silently: never bring the target tab to the front, so the user " +
              "can keep working in other tabs, windows, or apps (default false).",
          ),
        ...TAB,
      },
    },
    async ({ steps, vars, fast, background, tab }) => {
      const v = vars ?? {};
      const speed = fast !== false;
      const bg = background === true;
      const missing = new Set<string>();
      const sub = (s: string | undefined): string | undefined =>
        s == null
          ? undefined
          : s.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (m, name: string) => {
              if (v[name] === undefined) {
                missing.add(name);
                return m;
              }
              return v[name];
            });
      const resolved = steps.map((st) => ({
        ...st,
        url: sub(st.url),
        text: sub(st.text),
        key: sub(st.key),
        value: sub(st.value),
        label: sub(st.label),
        selector: sub(st.selector),
        target: st.target
          ? { ...st.target, selector: sub(st.target.selector), text: sub(st.target.text) }
          : undefined,
      }));
      if (missing.size) {
        return text(
          JSON.stringify({
            ok: false,
            error: `Unresolved placeholders: ${[...missing].join(", ")}. Pass values for them in 'vars'.`,
          }),
        );
      }

      await audit("run_script", {
        steps: resolved.length,
        vars: Object.keys(v),
        fast: speed,
        background: bg,
      });
      // Every dispatched command carries the background flag so the extension
      // never activates the tab mid-script.
      const ap = (action: string, params: Record<string, unknown>, timeoutMs?: number) =>
        act(action, tab, { ...params, background: bg }, timeoutMs);

      // Implicit wait on element resolution (Selenium's implicit-wait
      // semantics). Single-page apps routinely satisfy a wait_for on a
      // heading one frame before the controls below it mount, so a target
      // that resolves on the very first try is the exception, not the rule.
      // Poll until the element appears rather than failing on a race.
      const resolveTarget = async (
        t: { selector?: string; text?: string; tag?: string; nth?: number },
        timeoutMs: number,
      ): Promise<any> => {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
          const el = await ap(
            "resolve_element",
            { selector: t.selector, text: t.text, tag: t.tag, nth: t.nth },
          );
          if (el && el.found) return el;
          if (Date.now() >= deadline) return el;
          await new Promise((r) => setTimeout(r, 200));
        }
      };
      type StepResult = {
        step: number;
        action: string;
        ok: boolean;
        ms: number;
        result?: unknown;
        error?: string;
      };
      const results: StepResult[] = [];
      const t0 = Date.now();
      let failed: number | null = null;

      for (let i = 0; i < resolved.length; i++) {
        const st = resolved[i];
        const s0 = Date.now();
        try {
          let out: unknown;
          switch (st.action) {
            case "navigate": {
              if (!st.url) throw new Error("navigate needs 'url'.");
              out = await ap("navigate", { url: st.url });
              break;
            }
            case "wait_for": {
              if (st.text == null && st.selector == null) {
                throw new Error("wait_for needs 'text' and/or 'selector'.");
              }
              const r = await ap(
                "wait_for",
                { text: st.text, selector: st.selector, timeoutMs: st.timeout_ms },
                (st.timeout_ms ?? 10000) + 15000,
              );
              if (!r.found) throw new Error(`wait_for timed out after ${r.elapsed_ms}ms.`);
              out = `found after ${r.elapsed_ms}ms`;
              break;
            }
            case "drag": {
              if (st.from_x == null || st.from_y == null || st.to_x == null || st.to_y == null) {
                throw new Error("drag needs from_x, from_y, to_x, to_y.");
              }
              out = await ap(
                "drag",
                { fromX: st.from_x, fromY: st.from_y, toX: st.to_x, toY: st.to_y, fast: speed },
              );
              break;
            }
            case "click":
            case "fill":
            case "select": {
              if (st.action === "click" && !st.target && st.x != null && st.y != null) {
                // Coordinate click for elements with no durable descriptor
                // (icon-only buttons). Same gate as interactive click: hit-test
                // the live element so the danger check still applies.
                let targetText = "";
                try {
                  const hit = await ap("hit_test", { x: st.x, y: st.y });
                  targetText = (hit?.text as string) ?? "";
                } catch (_) { /* proceed ungated-texted; gatedClick re-checks */ }
                const r = await gatedClick(tab, { x: st.x, y: st.y }, targetText, speed, bg);
                if (/^(Action denied|Click aborted)/.test(r)) throw new Error(r);
                out = r;
                break;
              }
              if (!st.target || (st.target.selector == null && st.target.text == null)) {
                throw new Error(`${st.action} needs a 'target' with selector and/or text (or x/y for click).`);
              }
              const el = await resolveTarget(st.target, st.timeout_ms ?? 8000);
              if (!el || !el.found) {
                throw new Error(
                  `No element matches target ${JSON.stringify(st.target)} ` +
                    `after waiting ${st.timeout_ms ?? 8000}ms.`,
                );
              }
              if (st.action === "click") {
                const r = await gatedClick(tab, { index: el.index }, el.text ?? "", speed, bg);
                if (/^(Action denied|Click aborted)/.test(r)) throw new Error(r);
                out = r;
              } else if (st.action === "fill") {
                if (st.text == null) throw new Error("fill needs 'text'.");
                out = await ap(
                  "fill_element",
                  { index: el.index, text: st.text, fast: speed },
                );
              } else {
                if (st.value == null && st.label == null) {
                  throw new Error("select needs 'value' or 'label'.");
                }
                out = await ap(
                  "select_option",
                  { index: el.index, value: st.value, label: st.label },
                );
              }
              break;
            }
            case "type_text": {
              if (st.text == null) throw new Error("type_text needs 'text'.");
              out = await ap("type_text", { text: st.text, fast: speed });
              break;
            }
            case "press_key": {
              if (!st.key) throw new Error("press_key needs 'key'.");
              out = await ap("press_key", { key: st.key });
              break;
            }
            case "scroll": {
              out = await ap("scroll", { deltaY: st.delta_y });
              break;
            }
          }
          if (st.pause_ms) await new Promise((r) => setTimeout(r, st.pause_ms));
          results.push({ step: i, action: st.action, ok: true, ms: Date.now() - s0, result: out });
        } catch (e) {
          results.push({
            step: i,
            action: st.action,
            ok: false,
            ms: Date.now() - s0,
            error: (e as Error).message,
          });
          if (!st.optional) {
            failed = i;
            break;
          }
        }
      }

      return text(
        JSON.stringify({
          ok: failed == null,
          steps_run: results.length,
          total_steps: resolved.length,
          elapsed_ms: Date.now() - t0,
          ...(failed != null
            ? {
                failed_step: failed,
                hint:
                  "Script stopped at the failed step. Take over with the interactive tools " +
                  "(screenshot / read_elements) from the current page state, finish the task, " +
                  "then update the saved script so the next replay succeeds.",
              }
            : {}),
          results,
        }),
      );
    },
  );

  // ===== Multi-tab management =====
  server.registerTool(
    "open_tab",
    {
      description:
        "Open a new browser tab in THIS session's own Chrome window and tab " +
        "group (the window is created on first use) and make it the session's " +
        "current tab. Returns the tab id to pass as 'tab' to other tools.",
      inputSchema: { url: z.string().optional().describe("URL to load; omit for a blank tab.") },
    },
    async ({ url }) => {
      const info = await openSessionTab(url);
      return text(
        `Opened tab ${info.tabId} in group "${info.label}" (window ${info.windowId})` +
          (info.url ? ` → ${info.url}` : "") +
          `. It is now this session's current tab.`,
      );
    },
  );

  server.registerTool(
    "list_tabs",
    { description: "List the tabs in this session's window (id, title, url, active)." },
    async () => text(JSON.stringify(await sendCmd("list_tabs", { agentId }))),
  );

  server.registerTool(
    "get_user_tab",
    {
      description:
        "Get the tab the USER is currently looking at (outside this session's " +
        "window). Use only when the user asks about what they have open. The " +
        "returned id works with read-only tools: read_page, read_elements, " +
        "find_text, wait_for, screenshot. Acting on it (click, type, navigate, " +
        "...) is refused — open_tab the URL to work with it.",
    },
    async () => text(JSON.stringify(await sendCmd("user_tab", { agentId }))),
  );

  server.registerTool(
    "use_tab",
    {
      description: "Set this session's current tab (subsequent tools default to it).",
      inputSchema: { tab: z.number().int().describe("Tab id from open_tab/list_tabs.") },
    },
    async ({ tab }) => {
      sess.currentTab = tab;
      return text(`Current tab set to ${tab}.`);
    },
  );

  server.registerTool(
    "close_tab",
    {
      description: "Close a tab this session opened.",
      inputSchema: { tab: z.number().int().describe("Tab id to close.") },
    },
    async ({ tab }) => {
      await sendCmd("close_tab", { agentId, tabId: tab });
      if (sess.currentTab === tab) sess.currentTab = null;
      return text(`Closed tab ${tab}.`);
    },
  );

  return server;
}

// ===== Run =====
async function main(): Promise<void> {
  const useStdio = process.argv.includes("--stdio");

  // Bind the bridge first; if :8765 is taken, fail before touching the MCP
  // transport (a second instance can't bridge the extension anyway).
  await startBridge();

  if (useStdio) {
    log("[bridge] MCP transport: stdio (Claude Desktop)");
    const server = buildServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
  } else {
    log("[bridge] MCP transport: streamable HTTP at http://localhost:8000/mcp");
    await startHttp();
  }
}

// Streamable HTTP transport for Claude Code / MCP Inspector. Imported lazily so
// stdio mode (the .mcpb path) never pulls in the HTTP stack.
async function startHttp(): Promise<void> {
  const { createServer } = await import("node:http");
  const { StreamableHTTPServerTransport } = await import(
    "@modelcontextprotocol/sdk/server/streamableHttp.js"
  );
  const { isInitializeRequest } = await import("@modelcontextprotocol/sdk/types.js");

  const transports = new Map<string, InstanceType<typeof StreamableHTTPServerTransport>>();

  const readBody = (req: import("node:http").IncomingMessage): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c as Buffer));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf-8");
        if (!raw) return resolve(undefined);
        try {
          resolve(JSON.parse(raw));
        } catch (e) {
          reject(e);
        }
      });
      req.on("error", reject);
    });

  // DNS-rebinding defense: a malicious site can rebind its name to 127.0.0.1 and
  // reach this endpoint same-origin (bypassing CORS), then drive the browser via
  // MCP tools. The rebound request still carries the attacker's name in Host, and
  // a browser page carries its site in Origin — so allowlist both to loopback.
  const ALLOWED_HOSTS = new Set(["127.0.0.1:8000", "localhost:8000"]);
  const hostOk = (h: string | undefined) => !h || ALLOWED_HOSTS.has(h);
  const originOk = (o: string | undefined) =>
    !o || /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(o);

  const http = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost:8000");
    if (url.pathname !== "/mcp") {
      res.writeHead(404).end();
      return;
    }

    if (!hostOk(req.headers.host) || !originOk(req.headers.origin)) {
      log(`[http] rejected request host=${req.headers.host} origin=${req.headers.origin}`);
      res
        .writeHead(403, { "Content-Type": "application/json" })
        .end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Forbidden" }, id: null }));
      return;
    }

    try {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      let transport = sessionId ? transports.get(sessionId) : undefined;

      if (!transport) {
        const body = req.method === "POST" ? await readBody(req) : undefined;
        if (req.method === "POST" && isInitializeRequest(body)) {
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (id: string) => {
              transports.set(id, transport!);
            },
          });
          transport.onclose = () => {
            if (transport!.sessionId) transports.delete(transport!.sessionId);
          };
          await buildServer().connect(transport);
          await transport.handleRequest(req, res, body);
          return;
        }
        res
          .writeHead(400, { "Content-Type": "application/json" })
          .end(
            JSON.stringify({
              jsonrpc: "2.0",
              error: { code: -32000, message: "Bad Request: no valid session" },
              id: null,
            }),
          );
        return;
      }

      const body = req.method === "POST" ? await readBody(req) : undefined;
      await transport.handleRequest(req, res, body);
    } catch (e) {
      log(`[http] request error: ${(e as Error).message}`);
      if (!res.headersSent) res.writeHead(500).end();
    }
  });

  await new Promise<void>((resolve, reject) => {
    // One HTTP server already serves any number of sessions, so a second one
    // has no reason to exist: point the client at the running one instead.
    http.once("error", (err) => {
      log(
        `[http] FATAL could not bind http://localhost:8000/mcp: ${err.message} ` +
          `(another OtterBridge HTTP server is probably running — connect to it instead)`,
      );
      reject(err);
    });
    http.listen(8000, "127.0.0.1", resolve);
  });
}

main().catch((e) => {
  log(`[fatal] ${(e as Error).message}`);
  process.exit(1);
});
