// Flow recorder tools: record_flow / flows / run_flow against a fake
// extension that keeps the recording and the saved flows in memory.
// Checks the approvals, that recorded values stay out of tool results and
// the audit log, and the replay rules (vars, sensitive steps, from_step).
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
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

// Values "typed" while recording: they must never reach a tool result
// (except flows get) or the audit log.
const SECRET_EMAIL = `rec-${randomBytes(6).toString("hex")}@example.com`;
const OTHER_EMAIL = `run-${randomBytes(6).toString("hex")}@example.com`;

// ----- the fake extension -----
const USER_TAB = { tabId: 7, title: "Lunch menu", url: "https://shop.example.com/menu", readOnly: true };
const AGENT_TAB = 42;
let recording = null;    // { tabId, steps } while recording
let flows = {};          // name -> flow
let pwFilled = false;    // field_filled's answer for the password field
const seen = [];         // { action, p } of every command
const PAGE = {
  'input[name="email"]': { index: 1, text: "", tag: "input" },
  "#city": { index: 2, text: "", tag: "input" },
  'input[name="password"]': { index: 3, text: "password", tag: "input" },
  "Place order": { index: 4, text: "Place order", tag: "button" },
};
const RECORDED = {
  v: 1, name: "Lunch menu 2026-11-21", createdAt: "2026-11-21T09:00:00.000Z", startUrl: USER_TAB.url,
  steps: [
    { action: "navigate", url: USER_TAB.url },
    { action: "fill", target: { selector: 'input[name="email"]', label: "Email" }, text: "{{email}}" },
    { action: "fill", target: { selector: 'input[name="password"]', label: "Password" }, sensitive: true },
    { action: "press_key", key: "Enter" },
  ],
  vars: { email: SECRET_EMAIL },
};

function ext(action, p) {
  seen.push({ action, p });
  switch (action) {
    case "get_approval_mode": return { mode: "ask" };
    case "user_tab": return USER_TAB;
    case "open_tab": return { tabId: AGENT_TAB, url: "about:blank", windowId: 1, label: "Otter · flows-test 1" };
    case "rec_status":
      return recording ? { recording: true, host: "shop.example.com", steps: 4, tabId: recording.tabId } : { recording: false };
    case "rec_start":
      if (recording) throw new Error("Already recording.");
      recording = { tabId: p.tabId };
      return { recording: true, host: "shop.example.com", steps: 1 };
    case "rec_stop": {
      if (!recording) throw new Error("Nothing is being recorded.");
      recording = null;
      const flow = { ...RECORDED, name: p.name || RECORDED.name };
      flows[flow.name] = flow;
      return { flow, warnings: [] };
    }
    case "rec_discard": { const was = !!recording; recording = null; return { discarded: was }; }
    case "flows_list":
      return Object.values(flows).map((f) => ({ name: f.name, steps: f.steps.length, startUrl: "shop.example.com", vars: Object.keys(f.vars || {}), createdAt: f.createdAt }));
    case "flows_get":
      if (!flows[p.name]) throw new Error(`No saved flow named "${p.name}". Call flows(action='list') to see them.`);
      return flows[p.name];
    case "flows_save":
      if (flows[p.flow.name] && p.replace !== true) return { exists: true, name: p.flow.name };
      { const replaced = !!flows[p.flow.name]; flows[p.flow.name] = p.flow; return { saved: p.flow.name, replaced }; }
    case "flows_delete": delete flows[p.name]; return { deleted: p.name };
    // page commands (replay)
    case "navigate": return `Navigated to ${p.url}`;
    case "resolve_element": {
      const el = PAGE[p.selector] || PAGE[p.text];
      return el ? { found: true, matches: 1, x: 10, y: 10, ...el } : { found: false };
    }
    case "fill_element": return `Filled element ${p.index} with ${(p.text || "").length} chars`;
    case "field_filled": return { filled: pwFilled };
    case "enter_target": return { labels: [] };
    case "press_key": return `Pressed ${p.key}`;
    case "click": return "Clicked at (10, 10)";
    default: throw new Error(`Unknown action: ${action}`);
  }
}

// ----- an AI app that shows prompts; the test decides the answers -----
const prompts = [];
let answer = "accept";
async function mkClient() {
  const client = new Client({ name: "flows-test", version: "1.0.0" }, { capabilities: { elicitation: {} } });
  client.setRequestHandler(ElicitRequestSchema, async (req) => {
    prompts.push(req.params.message);
    return answer === "accept" ? { action: "accept", content: {} } : { action: answer };
  });
  await client.connect(await httpTransport());
  return client;
}

async function main() {
  const proc = spawn("node", ["dist/index.js"], {
    cwd: process.cwd(),
    env: { ...process.env, BROWSER_AGENT_GATE: "elicit", BROWSER_AGENT_GATE_FALLBACK: "deny" },
    stdio: ["ignore", "ignore", "ignore"],
  });
  try {
    await sleep(1200);
    await connectFakeExtension(WS_PORT, { onCommand: ext });
    const c = await mkClient();
    const call = (name, args = {}) => c.callTool({ name, arguments: args });
    const since = (n) => seen.slice(n).map((s) => s.action);

    // ===== record_flow =====
    answer = "decline";
    let n = seen.length;
    let r = firstText(await call("record_flow", { action: "start" }));
    ok("record_flow start asks the user first", prompts.length === 1 && prompts[0].includes('"Lunch menu"') && prompts[0].includes("shop.example.com") && prompts[0].includes("never passwords"), J(prompts));
    ok("...declined -> denied, nothing recorded", r.startsWith("Action denied by user") && !since(n).includes("rec_start") && recording === null, r);

    answer = "accept";
    n = seen.length;
    r = firstText(await call("record_flow", { action: "start" }));
    const started = seen.slice(n).find((s) => s.action === "rec_start");
    ok("...approved -> records the user's tab", started && started.p.tabId === USER_TAB.tabId && r.startsWith("Recording"), r);
    ok("...and doesn't open an agent tab for it", !since(n).includes("open_tab"), J(since(n)));

    const prompted = prompts.length;
    r = firstText(await call("record_flow", { action: "start" }));
    ok("start while recording -> says so, no prompt", r.startsWith("Already recording") && prompts.length === prompted, r);

    const st = JSON.parse(firstText(await call("record_flow", { action: "status" })));
    ok("status -> recording, host, step count", st.recording === true && st.host === "shop.example.com" && st.steps === 4, J(st));

    r = firstText(await call("record_flow", { action: "stop", name: "Order lunch" }));
    const stopped = JSON.parse(r);
    ok("stop -> name, step count, variable names, sensitive count", stopped.name === "Order lunch" && stopped.steps === 4 && J(stopped.vars) === '["email"]' && stopped.sensitive_steps === 1, r);
    ok("stop -> the steps come back", Array.isArray(stopped.recorded_steps) && stopped.recorded_steps[1].text === "{{email}}", r);
    ok("stop -> no recorded value in the result", !r.includes(SECRET_EMAIL), r);

    r = firstText(await call("record_flow", { action: "discard" }));
    ok("discard with nothing recording", r === "Nothing was being recorded.", r);

    // ===== flows =====
    const list = JSON.parse(firstText(await call("flows", { action: "list" })));
    ok("flows list -> name, steps, host, variable names", list.length === 1 && list[0].name === "Order lunch" && list[0].steps === 4 && list[0].startUrl === "shop.example.com" && J(list[0].vars) === '["email"]', J(list));
    ok("flows list shows no recorded value", !J(list).includes(SECRET_EMAIL));
    const got = JSON.parse(firstText(await call("flows", { action: "get", name: "Order lunch" })));
    ok("flows get -> the full flow, defaults included", got.vars.email === SECRET_EMAIL && got.steps.length === 4, J(got));
    const missing = await call("flows", { action: "get", name: "Nope" });
    ok("flows get of an unknown name -> error", missing.isError && firstText(missing).includes("No saved flow"), firstText(missing));

    const LUNCH = {
      name: "Lunch",
      steps: [
        { action: "navigate", url: "https://shop.example.com/menu" },
        { action: "fill", target: { selector: 'input[name="email"]', label: "Email" }, text: "{{email}}" },
        { action: "fill", target: { selector: "#city", label: "City" }, text: "{{city}}" },
        { action: "fill", target: { selector: 'input[name="password"]', label: "Password" }, sensitive: true },
        { action: "click", target: { text: "Place order", tag: "button" } },
      ],
      vars: { email: SECRET_EMAIL, city: null },
    };
    let p0 = prompts.length;
    r = firstText(await call("flows", { action: "save", flow: LUNCH }));
    ok("flows save of a new name -> saved, no prompt", r.startsWith('Saved the flow "Lunch"') && prompts.length === p0 && flows.Lunch, r);

    answer = "decline";
    p0 = prompts.length;
    r = firstText(await call("flows", { action: "save", flow: { ...LUNCH, steps: LUNCH.steps.slice(0, 2) } }));
    ok("flows save over an existing name asks to replace", prompts.length === p0 + 1 && prompts.at(-1) === 'Replace the saved flow "Lunch"?', J(prompts.at(-1)));
    ok("...declined -> not replaced", r.startsWith("Action denied by user") && flows.Lunch.steps.length === 5, r);
    answer = "accept";
    r = firstText(await call("flows", { action: "save", name: "Lunch", flow: { ...LUNCH, steps: LUNCH.steps.slice(0, 2) } }));
    ok("...approved -> replaced", r.startsWith('Replaced the flow "Lunch"') && flows.Lunch.steps.length === 2, r);
    await call("flows", { action: "save", flow: { ...LUNCH, name: "Lunch2" } }); // the full one, for run_flow
    flows.Lunch = flows.Lunch2; flows.Lunch.name = "Lunch"; delete flows.Lunch2;

    n = seen.length;
    const bad = await call("flows", { action: "save", flow: { name: "Bad", steps: [{ action: "fly" }] } });
    ok("flows save with an invalid step -> error, nothing sent", bad.isError && !since(n).includes("flows_save"), firstText(bad));
    const longName = await call("flows", { action: "save", flow: { name: "x".repeat(61), steps: LUNCH.steps } });
    ok("flows save with a name over 60 characters -> error", longName.isError && !since(n).includes("flows_save"), firstText(longName));
    const noSteps = await call("flows", { action: "save", flow: { name: "Empty", steps: [] } });
    ok("flows save with no steps -> error", noSteps.isError && !since(n).includes("flows_save"), firstText(noSteps));

    p0 = prompts.length;
    const delMissing = await call("flows", { action: "delete", name: "Nope" });
    ok("flows delete of an unknown name -> error, no prompt", delMissing.isError && prompts.length === p0, firstText(delMissing));
    answer = "decline";
    r = firstText(await call("flows", { action: "delete", name: "Order lunch" }));
    ok("flows delete asks first", prompts.at(-1) === 'Delete the saved flow "Order lunch"?', J(prompts.at(-1)));
    ok("...declined -> kept", r.startsWith("Action denied by user") && flows["Order lunch"], r);
    answer = "accept";
    r = firstText(await call("flows", { action: "delete", name: "Order lunch" }));
    ok("...approved -> deleted", r.startsWith("Deleted") && !flows["Order lunch"], r);

    // ===== run_flow =====
    n = seen.length;
    let run = JSON.parse(firstText(await call("run_flow", { name: "Lunch" })));
    ok("run_flow: a variable without a value fails before any page command", run.ok === false && /Unresolved placeholders: city/.test(run.error) && J(since(n)) === '["flows_get"]', J({ run, sent: since(n) }));

    pwFilled = false;
    n = seen.length;
    run = JSON.parse(firstText(await call("run_flow", { name: "Lunch", vars: { city: "Paris" } })));
    const sent = seen.slice(n);
    const fills = sent.filter((s) => s.action === "fill_element").map((s) => s.p.text);
    ok("run_flow uses the recorded value when vars leave it out", fills[0] === SECRET_EMAIL && fills[1] === "Paris", J(fills));
    ok("run_flow acts in the session's own tab, never the user's", sent.filter((s) => s.p.tabId != null).every((s) => s.p.tabId === AGENT_TAB) && sent.some((s) => s.action === "navigate"), J(sent.map((s) => [s.action, s.p.tabId])));
    ok("a sensitive step the browser didn't fill stops the replay", run.ok === false && run.failed_step === 3 && !sent.some((s) => s.action === "click"), J(run));
    const stopErr = run.results.at(-1).error;
    ok("...asking for the user to type it, then from_step = next", /needs a password or code/.test(stopErr) && stopErr.includes("from_step = 4"), stopErr);
    ok("...and never fills it", fills.length === 2, J(fills));
    ok("run_flow result carries no recorded value", !J(run).includes(SECRET_EMAIL), J(run));

    n = seen.length;
    run = JSON.parse(firstText(await call("run_flow", { name: "Lunch", vars: { city: "Rome", email: OTHER_EMAIL } })));
    ok("vars override the recorded values", seen.slice(n).filter((s) => s.action === "fill_element")[0]?.p.text === OTHER_EMAIL);

    pwFilled = true;
    p0 = prompts.length;
    n = seen.length;
    run = JSON.parse(firstText(await call("run_flow", { name: "Lunch", vars: { city: "Paris" }, from_step: 3 })));
    const resumed = seen.slice(n);
    ok("from_step skips the steps before it, the navigate included", !resumed.some((s) => s.action === "navigate" || s.action === "fill_element") && run.results[0].step === 3 && run.from_step === 3, J({ run, sent: resumed.map((s) => s.action) }));
    ok("a sensitive step the browser filled -> 'already filled', replay continues", run.ok === true && run.results[0].result === "already filled", J(run));
    ok("'Place order' in a flow still asks the user", prompts.length === p0 + 1 && /Place order/.test(prompts.at(-1)), J(prompts.slice(p0)));
    const click = resumed.find((s) => s.action === "click");
    ok("...and the approved click is marked gated", click && click.p.gated === true, J(click && click.p));

    run = JSON.parse(firstText(await call("run_flow", { name: "Lunch", from_step: 9 })));
    ok("from_step past the end -> error", run.ok === false && /past the last step/.test(run.error), J(run));
    const unknown = await call("run_flow", { name: "Nope" });
    ok("run_flow of an unknown flow -> error", unknown.isError && firstText(unknown).includes("No saved flow"), firstText(unknown));

    // ===== the audit log =====
    await sleep(300);
    const log = await readFile(join(process.cwd(), "agent_actions.log"), "utf-8");
    ok("the audit log never contains a recorded or typed value", !log.includes(SECRET_EMAIL) && !log.includes(OTHER_EMAIL));
    ok("...but records the replay (flow name, variable names)", log.includes('"action":"run_flow"') && log.includes('"name":"Lunch"'));

    await c.close();
    console.log(`\n[test] ${pass} passed, ${fail} failed`);
  } finally {
    proc.kill();
  }
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error("harness error:", e); process.exit(2); });
