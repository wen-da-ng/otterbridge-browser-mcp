// Site rules: the "always ask" round-trip. The fake extension treats every
// tab as a site set to "ask": actions come back as { siteAsk } (not done)
// until they carry siteApproved, or gated + gatedBy "user" (a person approved
// that very action at the danger gate). The server must ask the user — even
// with Full Auto on or BROWSER_AGENT_GATE=false — and deny when it can't ask.
// (block / read-only are enforced in the extension: see the live checks.)
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { useTempHome, connectFakeExtension, httpTransport } from "./_ext.mjs";

useTempHome();
process.env.OTTERBRIDGE_WS_PORT ??= "18765";
const WS_PORT = Number(process.env.OTTERBRIDGE_WS_PORT);

let pass = 0, fail = 0;
const ok = (n, c, e = "") => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n} ${e}`); } };
const firstText = (r) => r.content.find((c) => c.type === "text")?.text ?? "";
const J = JSON.stringify;

// ----- the fake extension -----
const HOST = "bank.example";
const ELEMENTS = [
  { text: "Home", tag: "a" },
  { text: "Delete account", tag: "button" },
];
const ACTIONS = new Set(["click", "fill_element", "press_key", "type_text", "navigate", "scroll", "select_option"]);
let approvalMode = "ask";
let nextTab = 100;
const sent = []; // { action, p }

function ext(action, p) {
  sent.push({ action, p });
  if (action === "get_approval_mode") return { mode: approvalMode };
  if (action === "open_tab") return { tabId: nextTab++, url: `https://${HOST}/`, windowId: 1, label: "Otter · rules 1" };
  if (action === "read_page") {
    if (p.tabId === 999) {
      throw new Error("Otter's site rules block AI agents on blocked.example. The user can change this in the Otter popup.");
    }
    return { url: `https://${HOST}/`, title: "Bank", text: "Balance" };
  }
  // The extension's rule for an "ask" site.
  if (ACTIONS.has(action) && !(p.siteApproved === true || (p.gated === true && p.gatedBy === "user"))) {
    return { siteAsk: { host: HOST, pattern: HOST } };
  }
  switch (action) {
    case "locate_element": { const el = ELEMENTS[p.index]; return el ? { found: true, ...el, x: 1, y: 1 } : { found: false }; }
    case "resolve_element": {
      const i = ELEMENTS.findIndex((e) => e.text === p.text);
      return i >= 0 ? { found: true, index: i, ...ELEMENTS[i], x: 1, y: 1 } : { found: false };
    }
    case "hit_test": return { text: "Home", tag: "a" };
    case "enter_target": return { labels: [] };
    case "click": return "Clicked at (1, 1)";
    case "navigate": return `Navigated to ${p.url}`;
    case "fill_element": return `Filled element ${p.index}`;
    case "press_key": return `Pressed ${p.key}`;
    case "scroll": return "Scrolled";
    default: throw new Error(`Unknown action: ${action}`);
  }
}

// ----- AI apps: one that shows prompts (the test answers), one that can't -----
const prompts = [];
let answer = "accept";
async function mkClient({ elicit = true } = {}) {
  const client = new Client({ name: "rules-test", version: "1.0.0" }, elicit ? { capabilities: { elicitation: {} } } : {});
  if (elicit) {
    client.setRequestHandler(ElicitRequestSchema, async (req) => {
      prompts.push(req.params.message);
      return answer === "accept" ? { action: "accept", content: {} } : { action: answer };
    });
  }
  await client.connect(await httpTransport());
  return client;
}
const sitePrompts = () => prompts.filter((m) => m.includes('"always ask"'));

async function withServer(env, fn) {
  const proc = spawn("node", ["dist/index.js"], {
    cwd: process.cwd(),
    env: { ...process.env, BROWSER_AGENT_GATE_FALLBACK: "deny", ...env },
    stdio: ["ignore", "ignore", "ignore"],
  });
  try {
    await sleep(1200);
    const ext1 = await connectFakeExtension(WS_PORT, { onCommand: ext });
    await fn();
    ext1.ws.close();
  } finally {
    proc.kill();
    await sleep(500);
  }
}

async function main() {
  await withServer({ BROWSER_AGENT_GATE: "elicit" }, async () => {
    const c = await mkClient();
    const call = (name, args = {}) => c.callTool({ name, arguments: args });
    const openTab = async () => Number(/Opened tab (\d+)/.exec(firstText(await call("open_tab", { url: `https://${HOST}/` })))[1]);
    const clicksOn = (tab) => sent.filter((s) => s.action === "click" && s.p.tabId === tab);

    // --- approve -> resent with siteApproved, done ---
    const t1 = await openTab();
    let r = await call("click_element", { index: 0 });
    ok("an action on an 'ask' site asks the user", sitePrompts().length === 1 && sitePrompts()[0].startsWith(`${HOST} is set to "always ask" in Otter.`), J(prompts));
    const c1 = clicksOn(t1);
    ok("...approved -> resent with siteApproved and done", !r.isError && firstText(r).startsWith("Clicked") && c1.length === 2 && c1[1].p.siteApproved === true && !c1[0].p.siteApproved, J(c1.map((s) => s.p.siteApproved)));

    // --- reads never ask ---
    let n = prompts.length;
    r = await call("read_page", {});
    ok("reading an 'ask' site doesn't ask", !r.isError && prompts.length === n, firstText(r));

    // --- within 5 minutes: no new prompt ---
    r = await call("click_element", { index: 0 });
    ok("a second action in that tab within 5 minutes doesn't ask again", !r.isError && prompts.length === n && clicksOn(t1).at(-1).p.siteApproved === true, J(prompts.slice(n)));

    // --- another tab: asks again ---
    const t2 = await openTab();
    n = prompts.length;
    r = await call("click_element", { index: 0, tab: t2 });
    ok("the same site in another tab asks again", !r.isError && sitePrompts().length === 2 && prompts.length === n + 1, J(prompts.slice(n)));

    // --- deny ---
    const t3 = await openTab();
    answer = "decline";
    r = await call("click_element", { index: 0, tab: t3 });
    ok("declined -> 'Action denied by user', nothing done", r.isError && firstText(r).includes(`Action denied by user: ${HOST} is set to always ask.`) && !clicksOn(t3).some((s) => s.p.siteApproved), firstText(r));
    answer = "accept";

    // --- a person approving the destructive click itself is enough ---
    const t4 = await openTab();
    n = prompts.length;
    r = await call("click_element", { index: 1, tab: t4 });
    const del = clicksOn(t4);
    ok("a click the user approved at the danger gate isn't asked about again", !r.isError && prompts.length === n + 1 && /Delete account/.test(prompts.at(-1)) && del.length === 1 && del[0].p.gated === true && del[0].p.gatedBy === "user", J({ prompts: prompts.slice(n), del: del.map((s) => s.p) }));

    // --- Full Auto on: still asks ---
    approvalMode = "auto";
    const t5 = await openTab();
    n = prompts.length;
    r = await call("click_element", { index: 0, tab: t5 });
    ok("Full Auto on -> an 'ask' site still asks", !r.isError && prompts.length === n + 1 && prompts.at(-1).includes('"always ask"'), J(prompts.slice(n)));
    const t6 = await openTab();
    n = prompts.length;
    r = await call("click_element", { index: 1, tab: t6 });
    const auto = clicksOn(t6);
    ok("Full Auto on -> a destructive click there asks too (auto-approval isn't the user's)", !r.isError && prompts.length === n + 1 && prompts.at(-1).includes('"always ask"') && auto[0].p.gated === true && auto[0].p.gatedBy === undefined && auto.at(-1).p.siteApproved === true, J({ prompts: prompts.slice(n), clicks: auto.map((s) => s.p) }));
    approvalMode = "ask";

    // --- run_script: one prompt for the whole replay ---
    const t7 = await openTab();
    n = prompts.length;
    r = await call("run_script", {
      tab: t7,
      steps: [
        { action: "navigate", url: `https://${HOST}/accounts` },
        { action: "click", target: { text: "Home" } },
        { action: "fill", target: { text: "Home" }, text: "x" },
        { action: "press_key", key: "Tab" },
        { action: "scroll", delta_y: 300 },
      ],
    });
    const run = JSON.parse(firstText(r));
    ok("run_script with 5 steps on an 'ask' site -> one prompt", run.ok === true && run.steps_run === 5 && prompts.length === n + 1, J({ run, prompts: prompts.slice(n) }));

    // --- blocked: the extension's refusal reaches the model, and the log ---
    r = await call("read_page", { tab: 999 });
    ok("a blocked site's refusal comes back as an error", r.isError && firstText(r).startsWith("Otter's site rules block AI agents on blocked.example."), firstText(r));
    await c.close();

    // --- an app that can't show prompts: denied, never the fallback ---
    const mute = await mkClient({ elicit: false });
    const t8 = Number(/Opened tab (\d+)/.exec(firstText(await mute.callTool({ name: "open_tab", arguments: { url: `https://${HOST}/` } })))[1]);
    r = await mute.callTool({ name: "click_element", arguments: { index: 0, tab: t8 } });
    ok("an app that can't ask -> denied", r.isError && firstText(r).includes("Action denied by user") && !clicksOn(t8).some((s) => s.p.siteApproved), firstText(r));
    await mute.close();

    await sleep(300);
    const log = await readFile(join(process.cwd(), "agent_actions.log"), "utf-8");
    ok("site decisions are audited (allowed / denied / blocked)",
      [`${HOST}: allowed"`, `${HOST}: denied"`, `${HOST}: allowed (approved earlier)"`, "blocked.example: blocked (read_page)"].every((s) => log.includes(s)));
  });

  // --- BROWSER_AGENT_GATE=false: still asks ---
  await withServer({ BROWSER_AGENT_GATE: "false" }, async () => {
    const c = await mkClient();
    const t = Number(/Opened tab (\d+)/.exec(firstText(await c.callTool({ name: "open_tab", arguments: { url: `https://${HOST}/` } })))[1]);
    const n = prompts.length;
    const r = await c.callTool({ name: "click_element", arguments: { index: 1, tab: t } });
    ok("BROWSER_AGENT_GATE=false -> an 'ask' site still asks", !r.isError && prompts.length === n + 1 && prompts.at(-1).includes('"always ask"'), J(prompts.slice(n)));
    await c.close();
  });

  console.log(`\n[test] ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error("harness error:", e); process.exit(2); });
