// Multi-tab / per-session routing tests. One fake extension (one WS) serves
// two MCP sessions, mirroring reality: many agents, one extension, many tabs.
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { WebSocket } from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

let pass = 0, fail = 0;
const ok = (n, c, e = "") => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n} ${e}`); } };
const firstText = (r) => r.content.find((c) => c.type === "text")?.text ?? "";
const tabIdOf = (t) => { const m = /Opened tab (\d+)/.exec(t); return m ? Number(m[1]) : null; };

// ---- fake extension: stateful tabs + per-agent groups ----
let nextTabId = 100, nextGroup = 1, activeUrl = "about:blank#active";
const tabs = new Map();   // tabId -> { url, agentId }
const groups = new Map(); // agentId -> groupId
function handleExt(action, p) {
  switch (action) {
    case "open_tab": {
      const id = nextTabId++;
      if (!groups.has(p.agentId)) groups.set(p.agentId, nextGroup++);
      tabs.set(id, { url: p.url || "about:blank", agentId: p.agentId });
      return { tabId: id, url: p.url || "about:blank", title: "T", groupId: groups.get(p.agentId) };
    }
    case "list_tabs": {
      const out = [];
      for (const [id, t] of tabs) if (t.agentId === p.agentId) out.push({ tabId: id, title: "T", url: t.url, active: false });
      return out;
    }
    case "close_tab": { tabs.delete(p.tabId); return { closed: p.tabId }; }
    case "navigate": {
      if (p.tabId != null && tabs.has(p.tabId)) tabs.get(p.tabId).url = p.url; else activeUrl = p.url;
      return `Navigated to ${p.url}`;
    }
    case "read_page": {
      const url = p.tabId != null && tabs.has(p.tabId) ? tabs.get(p.tabId).url : activeUrl;
      return { url, title: "T", text: "x" };
    }
    default: return "ok";
  }
}

async function mkClient() {
  const client = new Client({ name: "mt", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8000/mcp")));
  return client;
}
const call = async (c, name, args = {}) => firstText(await c.callTool({ name, arguments: args }));

async function main() {
  const proc = spawn("node", ["dist/index.js"], { cwd: process.cwd(), stdio: ["ignore", "ignore", "ignore"] });
  try {
    await sleep(1200);
    const ext = new WebSocket("ws://localhost:8765");
    ext.on("message", (raw) => {
      const { id, action, params } = JSON.parse(raw.toString());
      let result = null, error = null;
      try { result = handleExt(action, params || {}); } catch (e) { error = e.message; }
      ext.send(JSON.stringify({ id, result, error }));
    });
    await new Promise((res, rej) => { ext.on("open", res); ext.on("error", rej); });

    // Two independent MCP sessions (= two agents).
    const A = await mkClient();
    const B = await mkClient();

    // A opens a tab -> becomes A's current tab; read_page (no tab arg) routes to it.
    const a1 = tabIdOf(await call(A, "open_tab", { url: "https://a1.test" }));
    ok("open_tab returns a tab id", a1 != null, `id=${a1}`);
    ok("read_page defaults to session current tab", (await call(A, "read_page")).includes("a1.test"));

    // A opens a second tab -> current switches; explicit handle still reaches the first.
    const a2 = tabIdOf(await call(A, "open_tab", { url: "https://a2.test" }));
    ok("current tab follows latest open_tab", (await call(A, "read_page")).includes("a2.test"));
    ok("explicit tab handle targets a specific tab", (await call(A, "read_page", { tab: a1 })).includes("a1.test"));

    // navigate an explicit tab; verify only that tab changed.
    await call(A, "navigate", { url: "https://a1b.test", tab: a1 });
    ok("navigate honors explicit tab", (await call(A, "read_page", { tab: a1 })).includes("a1b.test"));
    ok("other tab untouched by targeted navigate", (await call(A, "read_page", { tab: a2 })).includes("a2.test"));

    // use_tab switches the default.
    await call(A, "use_tab", { tab: a1 });
    ok("use_tab changes the default target", (await call(A, "read_page")).includes("a1b.test"));

    // A sees its 2 tabs.
    const aList = JSON.parse(await call(A, "list_tabs"));
    ok("list_tabs shows this session's 2 tabs", aList.length === 2, `got ${aList.length}`);

    // B is isolated: its own tab, its own group; list_tabs shows only B's.
    await call(B, "open_tab", { url: "https://b1.test" });
    ok("session B current tab is its own", (await call(B, "read_page")).includes("b1.test"));
    const bList = JSON.parse(await call(B, "list_tabs"));
    ok("session B list_tabs isolated from A", bList.length === 1 && bList[0].url.includes("b1.test"), `got ${JSON.stringify(bList)}`);
    ok("A still sees only its own 2 tabs", JSON.parse(await call(A, "list_tabs")).length === 2);

    // close a tab.
    await call(A, "close_tab", { tab: a2 });
    ok("close_tab removes a tab", JSON.parse(await call(A, "list_tabs")).length === 1);

    await A.close(); await B.close();
    console.log(`\n[test] ${pass} passed, ${fail} failed`);
  } finally {
    proc.kill();
  }
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error("harness error:", e); process.exit(2); });
