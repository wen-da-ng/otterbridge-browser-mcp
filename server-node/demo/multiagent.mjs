// Live multi-agent / multi-group demo.
// Opens N independent MCP client sessions against the running OtterBridge server
// (http://127.0.0.1:8000/mcp). Each session = a distinct agent = its own colored
// Chrome tab group. They then drive their own tabs CONCURRENTLY, proving the
// server routes parallel sessions to separate tabs without focus-fighting.
//
// Run (with the server up): node demo/multiagent.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { setTimeout as sleep } from "node:timers/promises";

const AGENTS = [
  { name: "shopper-1", kw: "thinkpad t14" },
  { name: "shopper-2", kw: "macbook air m2" },
  { name: "shopper-3", kw: "dell xps 13" },
];

const firstText = (r) => r.content.find((b) => b.type === "text")?.text ?? "";
const call = (c, name, args = {}) => c.callTool({ name, arguments: args }).then(firstText);

async function mk(name) {
  const c = new Client({ name, version: "1.0.0" });
  await c.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8000/mcp")));
  return c;
}

async function run() {
  console.log(`Connecting ${AGENTS.length} independent agent sessions...`);
  const clients = [];
  for (const a of AGENTS) clients.push(await mk(a.name)); // sequential so agent numbers are stable

  // Each agent opens its own tab (its own group), staggered so you can watch
  // the colored groups appear one by one in the tab strip.
  for (let i = 0; i < clients.length; i++) {
    const out = await call(clients[i], "open_tab", {
      url: `https://shopee.com.my/search?keyword=${encodeURIComponent(AGENTS[i].kw)}`,
    });
    console.log(`[${AGENTS[i].name}] ${out}`);
    await sleep(600);
  }

  // Confirm each agent sees only its own tab (per-session isolation, live).
  for (let i = 0; i < clients.length; i++) {
    const tabs = JSON.parse(await call(clients[i], "list_tabs"));
    console.log(`[${AGENTS[i].name}] owns ${tabs.length} tab(s): ${tabs.map((t) => t.title).join(" | ")}`);
  }

  // Now all agents act AT THE SAME TIME (Promise.all): scroll + read, several
  // rounds. With >1 agent active, none steals focus — they work in parallel.
  for (let round = 1; round <= 4; round++) {
    await Promise.all(clients.map((c) => call(c, "scroll", { delta_y: 700 })));
    console.log(`round ${round}: all ${clients.length} agents scrolled simultaneously`);
    await sleep(400);
  }
  const titles = await Promise.all(clients.map((c) => call(c, "read_page").then((p) => JSON.parse(p).title)));
  titles.forEach((t, i) => console.log(`[${AGENTS[i].name}] final page: ${t}`));

  console.log("\nDone. Tabs/groups left open in Chrome for inspection. Closing agent sessions.");
  await Promise.all(clients.map((c) => c.close()));
}

run().catch((e) => { console.error("demo error:", e); process.exit(1); });
