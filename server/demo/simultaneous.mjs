// Drive N existing tabs SIMULTANEOUSLY from N independent agent sessions.
// Each session binds to a pre-existing tab id (via use_tab) and then all agents
// scroll their tab at the same time (Promise.all), on repeat, so you can watch
// three separate windows move in lockstep.
//
// Run (server up): node demo/simultaneous.mjs [tabId1 tabId2 ...]
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { setTimeout as sleep } from "node:timers/promises";

// Default to the tabs opened by the earlier multi-agent demo; override via argv.
const TAB_IDS = (process.argv.slice(2).map(Number).filter(Boolean));
const TABS = TAB_IDS.length ? TAB_IDS : [2105239105, 2105239108, 2105239111];
const ROUNDS = 30;

const firstText = (r) => r.content.find((b) => b.type === "text")?.text ?? "";
const call = (c, name, args = {}) => c.callTool({ name, arguments: args }).then(firstText);

async function mk(name) {
  const c = new Client({ name, version: "1.0.0" });
  await c.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8000/mcp")));
  return c;
}

async function run() {
  const clients = [];
  for (let i = 0; i < TABS.length; i++) {
    const c = await mk(`driver-${i + 1}`);
    // Validate the tab still exists and bind it as this session's current tab.
    let title;
    try { title = JSON.parse(await call(c, "read_page", { tab: TABS[i] })).title; }
    catch (e) { console.log(`tab ${TABS[i]}: NOT reachable (${e.message}) — skipping`); continue; }
    await call(c, "use_tab", { tab: TABS[i] });
    clients.push({ c, id: TABS[i], title });
    console.log(`driver-${i + 1} bound tab ${TABS[i]} → ${title}`);
  }
  if (!clients.length) { console.log("No reachable tabs. Pass ids: node demo/simultaneous.mjs <id> <id> <id>"); return; }

  console.log(`\nScrolling ${clients.length} tabs simultaneously for ${ROUNDS} rounds — watch all windows...`);
  for (let r = 0; r < ROUNDS; r++) {
    const dir = r % 6 < 3 ? 600 : -600; // 3 down, 3 up, repeat — obvious motion
    await Promise.all(clients.map(({ c }) => call(c, "scroll", { delta_y: dir })));
    if (r % 3 === 0) console.log(`round ${r + 1}/${ROUNDS} (${dir > 0 ? "down" : "up"})`);
    await sleep(450);
  }

  console.log("\nDone. Closing driver sessions (tabs stay open).");
  await Promise.all(clients.map(({ c }) => c.close()));
}

run().catch((e) => { console.error("demo error:", e); process.exit(1); });
