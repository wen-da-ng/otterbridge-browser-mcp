// End-to-end smoke test for the Node OtterBridge server.
// Spawns the built server (HTTP mode), fakes the Chrome extension over the
// WebSocket bridge with canned responses, and drives the MCP tools over HTTP.
// Verifies the 9 tools, image content, and BOTH destructive-gate branches.
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { WebSocket } from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} ${extra}`); }
};

// 1x1 JPEG (base64), enough to prove the image block round-trips.
const TINY_JPEG =
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAAAP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AfwD/2Q==";

// --- canned "extension" over the WS bridge -------------------------------
const ELEMENTS = [
  { index: 0, tag: "a", text: "Home", x: 10, y: 10 },
  { index: 1, tag: "button", text: "Submit order", x: 20, y: 20 },
];
function handleExtension(action, p) {
  switch (action) {
    case "ping": return { pong: true, ts: 1 };
    case "navigate": return `Navigated to ${p.url}`;
    case "read_page": return { url: "https://example.com", title: "Example", text: "hello world" };
    case "read_elements": return ELEMENTS;
    case "hit_test": {
      const el = ELEMENTS.find((e) => e.x === p.x && e.y === p.y);
      return { text: el?.text ?? "", tag: el?.tag ?? "" };
    }
    case "locate_element": {
      const el = ELEMENTS[p.index];
      return el ? { found: true, text: el.text, x: el.x, y: el.y } : { found: false };
    }
    case "click": return `Clicked at (${p.x}, ${p.y})`;
    case "type_text": return `Typed ${(p.text || "").length} chars`;
    case "press_key": return `Pressed ${p.key}`;
    case "scroll": return "Scrolled";
    case "screenshot":
      return { base64: TINY_JPEG, format: "jpeg", width: 800, height: 600, dpr: 1, capturedWidth: 800, capturedHeight: 600 };
    default: throw new Error(`Unknown action: ${action}`);
  }
}

async function mkClient({ elicit }) {
  const caps = elicit ? { capabilities: { elicitation: {} } } : {};
  const client = new Client({ name: "smoketest", version: "1.0.0" }, caps);
  if (elicit) {
    client.setRequestHandler(ElicitRequestSchema, async () => ({ action: "accept", content: {} }));
  }
  const transport = new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8000/mcp"));
  await client.connect(transport);
  return client;
}
const firstText = (r) => r.content.find((c) => c.type === "text")?.text ?? "";

async function main() {
  const proc = spawn("node", ["dist/index.js"], {
    cwd: process.cwd(),
    env: { ...process.env, BROWSER_AGENT_GATE: "elicit", BROWSER_AGENT_GATE_FALLBACK: "deny" },
    stdio: ["ignore", "inherit", "inherit"],
  });

  try {
    await sleep(1200); // let both ports bind

    // Fake extension attaches to the bridge.
    const ext = new WebSocket("ws://localhost:8765");
    ext.on("message", (raw) => {
      const { id, action, params } = JSON.parse(raw.toString());
      let result = null, error = null;
      try { result = handleExtension(action, params || {}); }
      catch (e) { error = e.message; }
      ext.send(JSON.stringify({ id, result, error }));
    });
    await new Promise((res, rej) => { ext.on("open", res); ext.on("error", rej); });
    console.log("[test] fake extension connected to bridge");

    // --- MCP client that CAN elicit (approves destructive) ---
    const client = await mkClient({ elicit: true });

    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    const expected = ["click", "click_element", "navigate", "press_key", "read_elements", "read_page", "screenshot", "scroll", "type_text"];
    ok("tools/list has all 9 tools", JSON.stringify(tools) === JSON.stringify(expected), `got ${JSON.stringify(tools)}`);

    const rp = await client.callTool({ name: "read_page", arguments: {} });
    ok("read_page returns JSON text", firstText(rp).includes("example.com"));

    const nav = await client.callTool({ name: "navigate", arguments: { url: "https://x.test" } });
    ok("navigate", firstText(nav) === "Navigated to https://x.test");

    const ss = await client.callTool({ name: "screenshot", arguments: {} });
    const img = ss.content.find((c) => c.type === "image");
    ok("screenshot returns image/jpeg block", img && img.mimeType === "image/jpeg" && img.data === TINY_JPEG);

    const safe = await client.callTool({ name: "click_element", arguments: { index: 0 } });
    ok("click_element safe (Home) clicks without gate", firstText(safe) === "Clicked at (10, 10)");

    const dangerApproved = await client.callTool({ name: "click_element", arguments: { index: 1 } });
    ok("click_element destructive + elicit-accept -> clicks", firstText(dangerApproved) === "Clicked at (20, 20)", `got "${firstText(dangerApproved)}"`);

    const missing = await client.callTool({ name: "click_element", arguments: { index: 99 } });
    ok("click_element missing index -> guidance", firstText(missing).startsWith("No interactive element"));

    const rawClickDanger = await client.callTool({ name: "click", arguments: { x: 20, y: 20 } });
    ok("click(x,y) on destructive + elicit-accept -> clicks", firstText(rawClickDanger) === "Clicked at (20, 20)");

    const typed = await client.callTool({ name: "type_text", arguments: { text: "hello" } });
    ok("type_text", firstText(typed) === "Typed 5 chars");

    const scrolled = await client.callTool({ name: "scroll", arguments: {} });
    ok("scroll default", firstText(scrolled) === "Scrolled");

    await client.close();

    // --- MCP client that CANNOT elicit (fail-safe deny) ---
    const noElicit = await mkClient({ elicit: false });
    const denied = await noElicit.callTool({ name: "click_element", arguments: { index: 1 } });
    ok("destructive + no elicitation -> fail-safe DENY", firstText(denied).startsWith("Action denied by user"), `got "${firstText(denied)}"`);
    await noElicit.close();

    console.log(`\n[test] ${pass} passed, ${fail} failed`);
  } finally {
    proc.kill();
  }
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error("[test] harness error:", e); process.exit(2); });
