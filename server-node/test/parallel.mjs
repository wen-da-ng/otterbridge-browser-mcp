// Concurrency test: two MCP sessions issue commands SIMULTANEOUSLY (Promise.all)
// over the one WebSocket bridge. Verifies per-session tab routing holds under
// interleaving (UUID-keyed pending map + per-session currentTab) — no cross-tab
// contamination when parallel agents act at once.
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { WebSocket } from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

let pass = 0, fail = 0;
const ok = (n, c, e = "") => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n} ${e}`); } };
const firstText = (r) => r.content.find((c) => c.type === "text")?.text ?? "";
const tabIdOf = (t) => { const m = /Opened tab (\d+)/.exec(t); return m ? Number(m[1]) : null; };

// Fake extension: per-tab url state, with a small random delay per command so
// concurrent commands genuinely interleave/reorder in flight.
let nextTabId = 500, nextGroup = 1;
const tabs = new Map();
const groups = new Map();
function handleExt(action, p) {
  switch (action) {
    case "open_tab": {
      const id = nextTabId++;
      if (!groups.has(p.agentId)) groups.set(p.agentId, nextGroup++);
      tabs.set(id, { url: p.url || "about:blank", agentId: p.agentId });
      return { tabId: id, url: p.url || "about:blank", title: "T", groupId: groups.get(p.agentId) };
    }
    case "navigate":
      if (p.tabId != null && tabs.has(p.tabId)) tabs.get(p.tabId).url = p.url;
      return `Navigated to ${p.url}`;
    case "read_page": {
      const url = p.tabId != null && tabs.has(p.tabId) ? tabs.get(p.tabId).url : "about:blank";
      return { url, title: "T", text: "x" };
    }
    default: return "ok";
  }
}

async function mkClient() {
  const c = new Client({ name: "par", version: "1.0.0" });
  await c.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8000/mcp")));
  return c;
}
const call = async (c, name, args = {}) => firstText(await c.callTool({ name, arguments: args }));

async function main() {
  const proc = spawn("node", ["dist/index.js"], { cwd: process.cwd(), stdio: ["ignore", "ignore", "ignore"] });
  try {
    await sleep(1200);
    const ext = new WebSocket("ws://localhost:8765");
    ext.on("message", (raw) => {
      const { id, action, params } = JSON.parse(raw.toString());
      // Jittered async reply so in-flight commands reorder.
      const delay = 5 + Math.floor(Math.random() * 25);
      setTimeout(() => {
        let result = null, error = null;
        try { result = handleExt(action, params || {}); } catch (e) { error = e.message; }
        ext.send(JSON.stringify({ id, result, error }));
      }, delay);
    });
    await new Promise((res, rej) => { ext.on("open", res); ext.on("error", rej); });

    const A = await mkClient();
    const B = await mkClient();
    await Promise.all([call(A, "open_tab", { url: "https://a.test/0" }), call(B, "open_tab", { url: "https://b.test/0" })]);

    // 20 concurrent rounds: A and B each navigate their own tab then read it,
    // all fired together. If routing leaked, reads would see the other's url.
    let leaks = 0;
    for (let round = 0; round < 20; round++) {
      const [ra, rb] = await Promise.all([
        (async () => { await call(A, "navigate", { url: `https://a.test/${round}` }); return call(A, "read_page"); })(),
        (async () => { await call(B, "navigate", { url: `https://b.test/${round}` }); return call(B, "read_page"); })(),
      ]);
      if (!ra.includes(`a.test/${round}`)) leaks++;
      if (!rb.includes(`b.test/${round}`)) leaks++;
    }
    ok("20 concurrent A/B rounds: zero cross-tab leaks", leaks === 0, `leaks=${leaks}`);

    // Big simultaneous burst of mixed reads — each must reflect its own session.
    const burst = await Promise.all([
      call(A, "read_page"), call(B, "read_page"), call(A, "read_page"), call(B, "read_page"),
    ]);
    ok("simultaneous reads stay per-session", burst[0].includes("a.test") && burst[1].includes("b.test") && burst[2].includes("a.test") && burst[3].includes("b.test"), JSON.stringify(burst));

    await A.close(); await B.close();
    console.log(`\n[test] ${pass} passed, ${fail} failed`);
  } finally {
    proc.kill();
  }
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error("harness error:", e); process.exit(2); });
