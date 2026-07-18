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
let extSocket: WebSocket | null = null; // the connected extension, if any
interface Pending {
  resolve: (data: WsResponse) => void;
  timer: NodeJS.Timeout;
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

function startBridge(): Promise<void> {
  // max payload raised well above the ~1 MiB default: screenshot JPEGs of large
  // viewports easily exceed it, which otherwise closes the socket with a
  // 1009 "message too big" error mid-capture.
  const wss = new WebSocketServer({
    host: "localhost",
    port: 8765,
    maxPayload: 32 * 1024 * 1024,
    verifyClient: (info: { origin: string | undefined }) => {
      const ok = originAllowed(info.origin);
      if (!ok) log(`[bridge] rejected connection from origin: ${info.origin}`);
      return ok;
    },
  });

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
      log("[bridge] extension disconnected");
    });
    ws.on("error", (err) => log(`[bridge] socket error: ${err.message}`));
  });

  return new Promise((resolve, reject) => {
    wss.on("listening", () => {
      log("[bridge] WebSocket listening on ws://localhost:8765");
      resolve();
    });
    wss.on("error", (err: NodeJS.ErrnoException) => {
      // Most commonly EADDRINUSE: another OtterBridge instance already owns
      // :8765. Only one process can bridge the extension at a time (run EITHER
      // the HTTP server OR let Claude Desktop launch the --stdio one, not both).
      log(`[bridge] FATAL could not bind ws://localhost:8765: ${err.message}`);
      reject(err);
    });
  });
}

async function sendCmd(
  action: string,
  params?: Record<string, unknown>,
  timeoutMs = 30000,
): Promise<any> {
  if (!extSocket || extSocket.readyState !== WebSocket.OPEN) {
    throw new Error(
      "Chrome extension is not connected. Is Chrome open with the extension loaded?",
    );
  }
  await audit(action, params);
  const id = randomUUID();
  const socket = extSocket;
  const data: WsResponse = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timed out after ${timeoutMs}ms waiting for '${action}'.`));
    }, timeoutMs);
    pending.set(id, { resolve, timer });
    socket.send(JSON.stringify({ id, action, params: params ?? {} }));
  });
  if (data.error) throw new Error(data.error);
  return data.result;
}

// ===== Destructive-action gate =====
// Ask the human to approve a destructive action via MCP elicitation. Returns
// true only on explicit approval. Fail-safe on any error (client can't elicit).
async function approved(server: McpServer, message: string): Promise<boolean> {
  if (GATE_OFF) return true;
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

// One MCP session == one agent == one Chrome tab group. Each buildServer() call
// (per HTTP session, or the single stdio session) gets its own agent number.
let agentSeq = 0;

// ===== MCP server + tools =====
// A factory so each streamable-HTTP session gets its own McpServer instance
// (elicitation routes back to that session's client), while stdio uses one.
function buildServer(): McpServer {
  const server = new McpServer(
    { name: "OtterBridge", version: "0.2.0" },
    {
      instructions:
        "OtterBridge controls the user's real Chrome browser through the Otter " +
        "extension. Observe with read_page / read_elements / screenshot / " +
        "find_text; act with click_element (preferred) / fill_element / " +
        "select_option / press_key / navigate / scroll. Use wait_for for " +
        "dynamic content instead of polling screenshots. Debug web apps with " +
        "read_console / read_network / get_network_body. Open extra tabs with " +
        "open_tab (each joins this session's tab group); every tool takes an " +
        "optional 'tab' id, defaulting to this session's current tab. Built by " +
        "wen-da-ng.",
    },
  );

  // Per-session identity + owned-tab state. open_tab sets currentTab; tools
  // target `tab` ?? currentTab ?? the browser's active tab.
  const agentNum = ++agentSeq;
  const agentId = "a" + agentNum;
  const agentLabel = `Otter · agent ${agentNum}`;
  const sess: { currentTab: number | null } = { currentTab: null };
  const withTab = (tab: number | undefined, params: Record<string, unknown> = {}) => {
    const t = tab != null ? tab : sess.currentTab;
    return t != null ? { ...params, tabId: t } : params;
  };
  const TAB = {
    tab: z
      .number()
      .int()
      .optional()
      .describe(
        "Target tab id (from open_tab/list_tabs). Omit to use this session's current tab, or the active tab if none.",
      ),
  };

  server.registerTool(
    "navigate",
    {
      description: "Navigate a browser tab to a URL and wait for load.",
      inputSchema: { url: z.string(), ...TAB },
    },
    async ({ url, tab }) => text(await sendCmd("navigate", withTab(tab, { url }))),
  );

  server.registerTool(
    "go_back",
    {
      description: "Go back one step in the tab's history (like the Back button).",
      inputSchema: { ...TAB },
    },
    async ({ tab }) => text(await sendCmd("go_back", withTab(tab))),
  );

  server.registerTool(
    "go_forward",
    {
      description: "Go forward one step in the tab's history.",
      inputSchema: { ...TAB },
    },
    async ({ tab }) => text(await sendCmd("go_forward", withTab(tab))),
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
    async ({ hard, tab }) => text(await sendCmd("reload", withTab(tab, { hard }))),
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
        ...TAB,
      },
    },
    async ({ offset, max_chars, tab }) =>
      text(
        JSON.stringify(
          await sendCmd("read_page", withTab(tab, { offset, maxChars: max_chars })),
        ),
      ),
  );

  server.registerTool(
    "read_elements",
    {
      description:
        "List interactive elements on the page as numbered entries with center " +
        "coordinates. Use the coordinates with the click tool.",
      inputSchema: { ...TAB },
    },
    async ({ tab }) => text(JSON.stringify(await sendCmd("read_elements", withTab(tab)))),
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
        const info = await sendCmd("hit_test", withTab(tab, { x, y }));
        targetText = (info?.text as string) ?? "";
      } catch (e) {
        await audit("hit_test", { x, y }, `failed (${(e as Error).message}); proceeding`);
      }
      if (DANGER_RE.test(targetText)) {
        const label = targetText.trim().slice(0, 60) || `(${x}, ${y})`;
        if (!(await approved(server, `Approve clicking the '${label}' element? This looks destructive.`))) {
          return text(`Action denied by user: click on '${label}'.`);
        }
      }
      return text(await sendCmd("click", withTab(tab, { x, y })));
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
      const info = await sendCmd("locate_element", withTab(tab, { index }));
      if (!info || !info.found) {
        return text(
          `No interactive element with index ${index}. ` +
            `Call read_elements to refresh the list first.`,
        );
      }
      const targetText: string = info.text ?? "";
      if (DANGER_RE.test(targetText)) {
        const label = targetText.trim().slice(0, 60) || `element ${index}`;
        if (!(await approved(server, `Approve clicking the '${label}' element? This looks destructive.`))) {
          return text(`Action denied by user: click on '${label}'.`);
        }
      }
      // Pass index so the extension re-resolves the live position right before
      // pressing (immune to reflow during the cursor animation).
      return text(await sendCmd("click", withTab(tab, { x: info.x, y: info.y, index })));
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
      text(await sendCmd("fill_element", withTab(tab, { index, text: t }))),
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
      return text(await sendCmd("select_option", withTab(tab, { index, value, label })));
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
      return text(await sendCmd("hover", withTab(tab, { index, x, y })));
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
      text(
        await sendCmd(
          "drag",
          withTab(tab, { fromX: from_x, fromY: from_y, toX: to_x, toY: to_y }),
        ),
      ),
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
          .describe("Scroll the nth match into view (default true)."),
        ...TAB,
      },
    },
    async ({ query, nth, scroll, tab }) =>
      text(JSON.stringify(await sendCmd("find_text", withTab(tab, { query, nth, scroll })))),
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
        ...TAB,
      },
    },
    async ({ text: t, selector, timeout_ms, tab }) => {
      if (t == null && selector == null) {
        return text("Provide 'text' and/or 'selector' to wait for.");
      }
      const result = await sendCmd(
        "wait_for",
        withTab(tab, { text: t, selector, timeoutMs: timeout_ms }),
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
    async ({ text: t, tab }) => text(await sendCmd("type_text", withTab(tab, { text: t }))),
  );

  server.registerTool(
    "press_key",
    {
      description: "Press a keyboard key, e.g. 'Enter', 'Tab', 'Escape'.",
      inputSchema: { key: z.string(), ...TAB },
    },
    async ({ key, tab }) => text(await sendCmd("press_key", withTab(tab, { key }))),
  );

  server.registerTool(
    "scroll",
    {
      description: "Scroll the page vertically. Positive = down, negative = up.",
      inputSchema: { delta_y: z.number().int().default(600), ...TAB },
    },
    async ({ delta_y, tab }) => text(await sendCmd("scroll", withTab(tab, { deltaY: delta_y }))),
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
            "Capture the whole page height (capped at 8000px), not just the viewport.",
          ),
        ...TAB,
      },
    },
    async ({ full_page, tab }) => {
      const result = await sendCmd("screenshot", withTab(tab, { fullPage: full_page }));
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
      text(
        JSON.stringify(await sendCmd("read_console", withTab(tab, { level, limit, clear }))),
      ),
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
      text(
        JSON.stringify(await sendCmd("read_network", withTab(tab, { filter, limit, clear }))),
      ),
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
      text(
        JSON.stringify(
          await sendCmd("get_network_body", withTab(tab, { requestId: request_id })),
        ),
      ),
  );

  server.registerTool(
    "evaluate_js",
    {
      description:
        "Run a JavaScript expression in the page and return its result " +
        "(promises are awaited, result JSON-serialized). Doubly gated: the " +
        "Otter extension options must enable it, AND every call asks the user " +
        "for approval.",
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
      return text(JSON.stringify(await sendCmd("evaluate_js", withTab(tab, { code }))));
    },
  );

  // ===== Multi-tab management =====
  server.registerTool(
    "open_tab",
    {
      description:
        "Open a new browser tab in THIS session's tab group and make it the " +
        "session's current tab. Returns the tab id to pass as 'tab' to other tools.",
      inputSchema: { url: z.string().optional().describe("URL to load; omit for a blank tab.") },
    },
    async ({ url }) => {
      const info = await sendCmd("open_tab", { agentId, agentLabel, url });
      sess.currentTab = info.tabId;
      return text(
        `Opened tab ${info.tabId} in group "${agentLabel}"` +
          (info.url ? ` → ${info.url}` : "") +
          `. It is now this session's current tab.`,
      );
    },
  );

  server.registerTool(
    "list_tabs",
    { description: "List the tabs this session has opened (id, title, url, active)." },
    async () => text(JSON.stringify(await sendCmd("list_tabs", { agentId }))),
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
      await sendCmd("close_tab", { tabId: tab });
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

  await new Promise<void>((resolve) => http.listen(8000, "127.0.0.1", resolve));
}

main().catch((e) => {
  log(`[fatal] ${(e as Error).message}`);
  process.exit(1);
});
