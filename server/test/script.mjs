// Script-ready results (0.12.0): code that calls these tools (Claude Code's
// Code Mode, programmatic tool calling) can't read prose, so every failure —
// a declined approval, an aborted or refused click, a stale index, a missing
// argument, the extension's own "Cannot go back" — must come back as isError,
// and a denial must say not to retry. Successful results must not be flagged.
import { spawn } from "node:child_process";
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
const HINT = "The user declined this: stop and ask them how to continue. Don't retry it or look for another way to do it.";
const count = (s, sub) => s.split(sub).length - 1;

// ----- the fake extension -----
const ELEMENTS = [
  { text: "Home", tag: "a" },            // 0: harmless
  { text: "Delete account", tag: "button" }, // 1: destructive -> the gate asks
  { text: "Search", tag: "input" },      // 2
  { text: "Size", tag: "select" },       // 3
  { text: "Continue", tag: "button" },   // 4: covered by a cookie banner
  { text: "Archive", tag: "button" },    // 5: the extension refuses it as ungated
  { text: "", tag: "input", label: "Send to" }, // 6: an empty field whose <label> has a danger word
  { text: "Show dialog", tag: "button" }, // 7: opens a JS dialog (dialogNote)
  { text: "Freeze", tag: "button" },     // 8: a dialog Chrome didn't report (the watchdog's note)
];
const ASK_TAB = 777; // a tab on an "always ask" site
let nextTab = 100;
const sent = []; // { action, p }

// What the real extension appends after an action (afterReport / dialogNote),
// keyed by the x of a click(x, y) — for the typed "what changed" results.
const DIALOG = '→ The action opened a JavaScript confirm dialog: "Leave this page?\nChanges are lost". The page is paused until it\'s answered — call handle_dialog(accept=true|false).';
const REPORTS = {
  901: 'Clicked at (901, 1)\n→ Navigated to https://shop.example/b ("Shop (B)")',
  902: 'Clicked at (902, 1)\n→ A new page loaded at the same URL (form submitted or page reloaded): "Thanks".',
  903: 'Clicked at (903, 1)\n→ Opened a new tab (tab 321: https://pay.example/?a=(1)) — use_tab 321 to work in it.\n→ Opened a popup window (tab 322) — use_tab 322 to work in it.\n→ A download started: C:\\Users\\me\\Downloads\\invoice 7.pdf (wait_for_download to get the file).',
  904: DIALOG,
  905: 'Clicked at (905, 1)\n→ No visible change on the page.',
  906: 'Clicked at (906, 1)\n→ The page updated.\n→ Something new this server has never seen.',
  907: 'Clicked at (907, 1)\n→ The page title is now "Cart (2)".',
  908: 'Clicked at (908, 1)\n→ The tab was closed.',
};
const FROZEN = "→ The page stopped responding — most likely a JavaScript dialog (alert / confirm / prompt) is open, which pauses the page. Answer it with handle_dialog(accept=true|false) (its text couldn't be read).";

function ext(action, p) {
  sent.push({ action, p });
  if (action === "get_approval_mode") return { mode: "ask" };
  if (action === "open_tab") return { tabId: nextTab++, url: "https://shop.example/", windowId: 1, label: "Otter · script 1" };
  if (p.tabId === ASK_TAB && action === "click" && p.siteApproved !== true) {
    return { siteAsk: { host: "shop.example", pattern: "shop.example" } };
  }
  switch (action) {
    case "locate_element": { const el = ELEMENTS[p.index]; return el ? { found: true, ...el, x: 1, y: 1 } : { found: false }; }
    case "resolve_element": {
      if (p.text === "Item") return { found: true, index: 0, matches: 3, text: "Item", tag: "li", x: 1, y: 1 };
      const i = ELEMENTS.findIndex((e) => (p.text != null && (e.text === p.text || e.label === p.text)) || (p.selector != null && p.selector === `#el${ELEMENTS.indexOf(e)}`));
      return i >= 0 ? { found: true, index: i, matches: 1, ...ELEMENTS[i], x: 1, y: 1 } : { found: false };
    }
    case "hit_test": return { text: "Home", tag: "a" };
    case "enter_target": return { labels: [] };
    case "click": {
      if (p.index === 4) return { changed: true, covered: true, actualText: "Accept cookies", x: 1, y: 1 };
      if (p.index === 5 && p.gated !== true) return { changed: true, ungated: true, actualText: "Archive", x: 1, y: 1 };
      if (REPORTS[p.x]) return REPORTS[p.x];
      if (p.index === 7) return DIALOG;
      if (p.index === 8) return FROZEN;
      return "Clicked at (1, 1)";
    }
    case "navigate": return `Navigated to ${p.url}`;
    case "go_back": return "Cannot go back: no earlier history entry.";
    case "go_forward": return "Went forward to https://shop.example/c";
    case "reload": return p.hard ? "Hard-reloaded (cache bypassed)" : "Reloaded";
    case "press_key": return `Pressed ${p.key}\n→ Navigated to https://shop.example/done`;
    case "read_page": return { url: "https://shop.example/", title: "Shop", text: "Welcome", total_chars: 7, extra: { nested: [1, 2] } };
    case "read_elements": {
      const all = ELEMENTS.map((e, i) => ({ index: i, ...e, x: 1, y: 1 }));
      if (p.query === "many") return { total: 400, shown: 1, elements: all.slice(0, 1), note: "Showing 1 of 400 matching elements." };
      return all;
    }
    case "find_text": return { count: 1, matches: [{ nth: 0, x: 1, y: 2, visible: true, context: "Welcome" }] };
    case "wait_for": return { found: true, elapsed_ms: 5 };
    case "read_console": return { count: 1, entries: [{ ts: 1, level: "error", text: "boom" }] };
    case "read_network": return { count: 1, requests: [{ requestId: "r1", url: "https://shop.example/api", method: "GET", type: "Fetch", status: 200 }] };
    case "get_network_body": return { base64Encoded: false, total_chars: 2, truncated: false, body: "{}" };
    case "list_tabs": return [{ tabId: 100, title: "Shop", url: "https://shop.example/", active: true }];
    case "user_tab": return { tabId: 5, title: "Mine", url: "https://mine.example/" };
    case "select_option": return `Selected ${p.label ?? p.value}`;
    case "hover": return "Hovered";
    case "fill_element": return `Filled element ${p.index}`;
    case "screenshot": return { base64: "iVBORw0KGgo=", format: "png", width: 1, height: 1, dpr: 1, capturedWidth: 1, capturedHeight: 1 };
    default: throw new Error(`Unknown action: ${action}`);
  }
}

// ----- an AI app that shows prompts (the test answers them) -----
const prompts = [];
let answer = "accept";
async function mkClient() {
  const client = new Client({ name: "script-test", version: "1.0.0" }, { capabilities: { elicitation: {} } });
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
    // No startup grace: a profile connecting mid-test is reported (profile notes).
    env: { ...process.env, BROWSER_AGENT_GATE: "elicit", BROWSER_AGENT_GATE_FALLBACK: "deny", OTTERBRIDGE_STARTUP_GRACE_MS: "0" },
    stdio: ["ignore", "ignore", "ignore"],
  });
  try {
    await sleep(1200);
    const e = await connectFakeExtension(WS_PORT, { onCommand: ext });
    const c = await mkClient();
    const call = (name, args = {}) => c.callTool({ name, arguments: args });
    const clicks = (index) => sent.filter((s) => s.action === "click" && s.p.index === index);

    // --- successes stay successes ---
    let r = await call("read_page", {});
    ok("read_page -> not an error", !r.isError && JSON.parse(firstText(r)).title === "Shop", firstText(r));
    r = await call("click_element", { index: 0 });
    ok("a harmless click -> not an error", !r.isError && firstText(r).startsWith("Clicked"), firstText(r));
    r = await call("navigate", { url: "https://shop.example/a" });
    ok("navigate -> not an error", !r.isError && firstText(r).startsWith("Navigated to"), firstText(r));

    // --- the gate: declined ---
    answer = "decline";
    r = await call("click_element", { index: 1 });
    ok("declined click -> isError", r.isError === true, J(r));
    ok("...the text still says what was denied", firstText(r).startsWith("Action denied by user: click on 'Delete account'."), firstText(r));
    ok("...and says not to retry, once", firstText(r).endsWith(HINT) && count(firstText(r), HINT) === 1, firstText(r));
    ok("...and nothing was clicked", clicks(1).length === 0, J(clicks(1)));
    answer = "accept";

    // --- clicks the server or extension won't press ---
    r = await call("click_element", { index: 4 });
    ok("a covered target -> isError 'Click aborted'", r.isError && firstText(r).startsWith("Click aborted: the target is covered by 'Accept cookies'"), firstText(r));
    r = await call("click_element", { index: 5 });
    ok("a click the extension refuses -> isError 'Click refused'", r.isError && firstText(r).startsWith("Click refused by the browser extension"), firstText(r));
    r = await call("click_element", { index: 99 });
    ok("a stale index -> isError", r.isError && firstText(r).startsWith("No interactive element with index 99"), firstText(r));

    // --- argument mistakes ---
    r = await call("select_option", { index: 3 });
    ok("select_option without value or label -> isError", r.isError && firstText(r).startsWith("Provide 'value' or 'label'"), firstText(r));
    r = await call("hover", {});
    ok("hover without index or x/y -> isError", r.isError && firstText(r).startsWith("Provide 'index'"), firstText(r));
    r = await call("upload_file", { index: 2, files: ["relative.txt"] });
    ok("upload_file with a relative path -> isError", r.isError && firstText(r).includes("isn't an absolute path"), firstText(r));

    // --- the extension's own soft failure ---
    r = await call("go_back", {});
    ok("'Cannot go back' from the extension -> isError", r.isError && firstText(r).startsWith("Cannot go back"), firstText(r));

    // --- a thrown denial (site rule "always ask") gets the hint too ---
    answer = "decline";
    r = await call("click_element", { index: 0, tab: ASK_TAB });
    ok("a declined 'always ask' site -> isError with the hint, once", r.isError && firstText(r).startsWith("Action denied by user: shop.example is set to always ask.") && count(firstText(r), HINT) === 1, firstText(r));
    answer = "accept";

    // --- run_script ---
    r = await call("run_script", { steps: [{ action: "navigate", url: "https://shop.example/" }, { action: "click", target: { text: "Home" } }] });
    ok("a replay that finishes -> not an error", !r.isError && JSON.parse(firstText(r)).ok === true, firstText(r));

    r = await call("run_script", { steps: [{ action: "click", target: { text: "Archive" } }, { action: "click", target: { text: "Home" } }] });
    let res = JSON.parse(firstText(r));
    ok("run_script: a click the extension refuses fails the step (was counted as done)", r.isError && res.ok === false && res.failed_step === 0 && res.steps_run === 1 && /^Click refused/.test(res.results[0].error), firstText(r));

    answer = "decline";
    r = await call("run_script", { steps: [{ action: "click", target: { text: "Delete account" } }, { action: "click", target: { text: "Home" } }] });
    res = JSON.parse(firstText(r));
    answer = "accept";
    ok("run_script: a declined step -> isError, stops there", r.isError && res.ok === false && res.failed_step === 0 && res.steps_run === 1, firstText(r));
    ok("...and the hint says stop and ask, not 'finish the task'", /The user declined step 0\. Stop and ask them/.test(res.hint) && !/finish the task,/.test(res.hint), res.hint);

    r = await call("run_script", { steps: [{ action: "click", target: { text: "Nope" }, timeout_ms: 100 }] });
    res = JSON.parse(firstText(r));
    ok("run_script: a broken step keeps the take-over hint", r.isError && /Take over with the interactive tools/.test(res.hint), res.hint);

    // ===== Elements by description: 'target' instead of an index =====
    const { tools } = await c.listTools();
    const schemaOf = (n) => tools.find((t) => t.name === n)?.inputSchema ?? {};
    ok("the element tools accept 'target' and no longer require 'index'",
      ["click_element", "fill_element", "select_option", "hover", "screenshot"].every((n) => schemaOf(n).properties?.target && !(schemaOf(n).required ?? []).includes("index")),
      J(["click_element", "fill_element", "select_option", "hover", "screenshot"].map((n) => [n, schemaOf(n).required])));

    let n0 = sent.length;
    r = await call("click_element", { target: { text: "Home" } });
    let since = sent.slice(n0);
    ok("click_element by text -> clicks that element and says what matched", !r.isError && firstText(r).startsWith('Matched [0] "Home". Clicked') && since.some((s) => s.action === "click" && s.p.index === 0), firstText(r));
    ok("...without a separate locate_element round-trip", !since.some((s) => s.action === "locate_element"), J(since.map((s) => s.action)));

    r = await call("click_element", { target: { text: "Item" } });
    ok("several matches -> says how many and which was used", !r.isError && firstText(r).startsWith('Matched [0] "Item" (3 matches, used nth=0). '), firstText(r));

    // the gate applies exactly as for an index
    answer = "decline";
    n0 = prompts.length;
    r = await call("click_element", { target: { text: "Delete account" } });
    answer = "accept";
    ok("a destructive target still asks; declined -> isError, the denial text first", r.isError && prompts.length === n0 + 1 && firstText(r).startsWith("Action denied by user: click on 'Delete account'.") && clicks(1).length === 0, firstText(r));
    r = await call("click_element", { target: { text: "Delete account" } });
    ok("...approved -> clicked, marked gated", !r.isError && clicks(1).length === 1 && clicks(1)[0].p.gated === true && clicks(1)[0].p.gatedBy === "user", J(clicks(1).map((s) => s.p)));

    const t0 = Date.now();
    r = await call("click_element", { target: { text: "Nowhere" }, timeout_ms: 400 });
    ok("a target that never appears -> isError after about timeout_ms", r.isError && firstText(r).startsWith('No element matches target {"text":"Nowhere"} after waiting 400ms') && Date.now() - t0 >= 380, `${Date.now() - t0}ms ${firstText(r)}`);

    r = await call("click_element", {});
    ok("neither index nor target -> isError", r.isError && firstText(r).startsWith("Provide 'index' (from read_elements) or 'target'"), firstText(r));
    r = await call("click_element", { index: 0, target: { text: "Home" } });
    ok("both index and target -> isError", r.isError && firstText(r).startsWith("Provide either 'index' or 'target', not both."), firstText(r));
    r = await call("click_element", { target: { tag: "button" } });
    ok("a target without selector or text -> isError", r.isError && firstText(r).startsWith("Provide 'target' with a selector and/or text."), firstText(r));

    n0 = sent.length;
    r = await call("fill_element", { target: { selector: "#el2" }, text: "shoes\n" });
    since = sent.slice(n0);
    ok("fill_element by selector with a line break -> Enter checked on THAT field, then filled", !r.isError && since.some((s) => s.action === "enter_target" && s.p.index === 2) && since.some((s) => s.action === "fill_element" && s.p.index === 2) && firstText(r).startsWith('Matched [2] "Search". Filled'), firstText(r));

    r = await call("select_option", { target: { text: "Size" }, label: "M" });
    ok("select_option by text", !r.isError && firstText(r) === 'Matched [3] "Size". Selected M', firstText(r));

    n0 = sent.length;
    r = await call("hover", { target: { text: "Home" } });
    ok("hover by text -> hovers that element", !r.isError && sent.slice(n0).some((s) => s.action === "hover" && s.p.index === 0 && s.p.x == null), firstText(r));

    n0 = sent.length;
    r = await call("screenshot", { target: { text: "Search" } });
    ok("screenshot of an element by text -> captures that element", !r.isError && r.content[0].type === "image" && sent.slice(n0).some((s) => s.action === "screenshot" && s.p.index === 2), J(sent.slice(n0).map((s) => [s.action, s.p.index])));

    r = await call("click_element", { index: 0 });
    ok("click_element by index still works as before", !r.isError && firstText(r).startsWith("Clicked"), firstText(r));

    // a field found by its <label>: reported by the label, gated by its own (empty) name
    n0 = prompts.length;
    r = await call("click_element", { target: { text: "Send to" } });
    ok("a field found by its label is reported by the label", !r.isError && firstText(r).startsWith('Matched [6] "Send to". Clicked'), firstText(r));
    ok("...and a danger word in a field's label doesn't make clicking into it ask", prompts.length === n0 && clicks(6).length === 1 && clicks(6)[0].p.expectText === "" && !clicks(6)[0].p.gated, J(clicks(6).map((s) => s.p)));

    // ===== Typed results: structuredContent + outputSchema =====
    const TYPED = ["read_page", "read_elements", "find_text", "wait_for", "read_console", "read_network", "get_network_body", "list_tabs", "get_user_tab", "list_profiles", "run_script", "run_flow"];
    ok("the typed tools declare an outputSchema", TYPED.every((n) => tools.find((t) => t.name === n)?.outputSchema?.type === "object"), J(TYPED.filter((n) => !tools.find((t) => t.name === n)?.outputSchema)));
    ok("...and prose tools don't", ["page_snapshot", "screenshot", "fill_element", "type_text", "scroll", "drag"].every((n) => !tools.find((t) => t.name === n)?.outputSchema));
    ok("tools/list is still 44 tools", tools.length === 44, String(tools.length));

    // structured == the text's JSON, for the tools whose text is an object
    for (const [name, args] of [
      ["read_page", {}], ["find_text", { query: "Welcome" }], ["wait_for", { text: "Welcome" }],
      ["read_console", {}], ["read_network", {}], ["get_network_body", { request_id: "r1" }],
      ["get_user_tab", {}], ["list_profiles", {}],
    ]) {
      r = await call(name, args);
      ok(`${name}: structuredContent equals the text's JSON`, !r.isError && r.structuredContent && J(r.structuredContent) === J(JSON.parse(firstText(r))), J({ sc: r.structuredContent, text: firstText(r) }));
    }
    r = await call("read_page", {});
    ok("an unexpected extra field from the extension doesn't break the result", !r.isError && J(r.structuredContent.extra) === '{"nested":[1,2]}', J(r));

    // lists: text unchanged (a JSON array), structured wrapped in an object
    r = await call("read_elements", {});
    ok("read_elements: text is still the plain list", Array.isArray(JSON.parse(firstText(r))) && JSON.parse(firstText(r)).length === ELEMENTS.length, firstText(r));
    ok("...structured is { elements: [...] } with each index", J(r.structuredContent.elements) === firstText(r) && r.structuredContent.elements[5].index === 5, J(r.structuredContent));
    r = await call("read_elements", { query: "many" });
    ok("read_elements cut short: structured keeps total / shown / note", r.structuredContent.total === 400 && r.structuredContent.shown === 1 && r.structuredContent.elements.length === 1 && /Showing 1 of 400/.test(r.structuredContent.note), J(r.structuredContent));
    r = await call("list_tabs", {});
    ok("list_tabs: text is the list, structured is { tabs }", Array.isArray(JSON.parse(firstText(r))) && J(r.structuredContent.tabs) === firstText(r) && r.structuredContent.tabs[0].tabId === 100, J(r));

    // replays: typed on success and on failure
    r = await call("run_script", { steps: [{ action: "click", target: { text: "Home" } }] });
    ok("run_script ok -> structured ok: true", !r.isError && r.structuredContent?.ok === true && r.structuredContent.steps_run === 1, J(r.structuredContent));
    r = await call("run_script", { steps: [{ action: "click", target: { text: "Nope" }, timeout_ms: 100 }] });
    ok("run_script failed -> isError, still typed (failed_step readable)", r.isError && r.structuredContent?.ok === false && r.structuredContent.failed_step === 0, J(r.structuredContent));

    // a soft failure on a typed tool is an error, not a schema violation
    r = await call("wait_for", {});
    ok("wait_for with nothing to wait for -> isError (no schema error)", r.isError && firstText(r).startsWith("Provide 'text', 'selector' and/or 'url'"), firstText(r));

    // ===== Actions: typed "what changed" (0.13.0) =====
    const ACTIONS = ["click", "click_element", "select_option", "hover", "press_key", "navigate", "go_back", "go_forward", "reload"];
    ok("the action tools declare an outputSchema", ACTIONS.every((n) => tools.find((t) => t.name === n)?.outputSchema?.type === "object"), J(ACTIONS.filter((n) => !tools.find((t) => t.name === n)?.outputSchema)));

    const typedAction = async (name, args) => {
      const r = await call(name, args);
      return { r, t: firstText(r), sc: r.structuredContent, ch: r.structuredContent?.changed };
    };
    let a = await typedAction("click", { x: 901, y: 1 });
    ok("click -> text byte-for-byte what the extension said", !a.r.isError && a.t === REPORTS[901], a.t);
    ok("...message is the same text", a.sc?.message === a.t, J(a.sc));
    ok("...navigated with url and title (parentheses in the title)", a.ch?.navigated === true && a.ch.url === "https://shop.example/b" && a.ch.title === "Shop (B)", J(a.ch));
    a = await typedAction("click", { x: 902, y: 1 });
    ok("form submitted at the same URL -> navigated, same_url, title", a.ch?.navigated === true && a.ch.same_url === true && a.ch.title === "Thanks", J(a.ch));
    a = await typedAction("click", { x: 903, y: 1 });
    ok("new tab + popup + download, all kept", J(a.ch?.new_tabs) === J([{ tab: 321, url: "https://pay.example/?a=(1)", popup: false }, { tab: 322, popup: true }]) && J(a.ch.downloads) === J(["C:\\Users\\me\\Downloads\\invoice 7.pdf"]) && a.ch.navigated === false, J(a.ch));
    a = await typedAction("click", { x: 904, y: 1 });
    ok("a dialog opened by the action (multi-line message)", !a.r.isError && a.ch?.dialog?.type === "confirm" && a.ch.dialog.message === "Leave this page?\nChanges are lost" && !a.ch.other, J(a.ch));
    a = await typedAction("click", { x: 905, y: 1 });
    ok("no visible change -> page_changed false, navigated false", a.ch?.page_changed === false && a.ch.navigated === false, J(a.ch));
    a = await typedAction("click", { x: 906, y: 1 });
    ok("page updated + an unknown line kept in 'other'", a.ch?.page_changed === true && J(a.ch.other) === J(["→ Something new this server has never seen."]), J(a.ch));
    a = await typedAction("click", { x: 907, y: 1 });
    ok("title changed without navigating", a.ch?.title === "Cart (2)" && a.ch.navigated === false, J(a.ch));
    a = await typedAction("click", { x: 908, y: 1 });
    ok("tab closed", a.ch?.tab_closed === true, J(a.ch));

    a = await typedAction("click_element", { target: { text: "Show dialog" } });
    ok("a dialog after a 'target' click (behind the Matched prefix) -> dialog", a.t === 'Matched [7] "Show dialog". ' + DIALOG && a.ch?.dialog?.type === "confirm" && !a.ch.other, J(a.ch));
    a = await typedAction("click_element", { target: { text: "Freeze" } });
    ok("the watchdog's frozen-page note after a 'target' click -> dialog type unknown", a.ch?.dialog?.type === "unknown" && a.ch.dialog.message === undefined && !a.ch.other, J(a.ch));
    a = await typedAction("click_element", { index: 8 });
    ok("...and without the prefix", a.ch?.dialog?.type === "unknown" && !a.ch.other, J(a.ch));
    a = await typedAction("click_element", { target: { text: "Home" } });
    ok("click_element by target -> typed, the match note kept in message", !a.r.isError && a.sc?.message.startsWith('Matched [0] "Home". Clicked') && a.ch?.navigated === false, J(a.sc));
    a = await typedAction("navigate", { url: "https://shop.example/x" });
    ok("navigate -> navigated + url", a.ch?.navigated === true && a.ch.url === "https://shop.example/x" && a.t === "Navigated to https://shop.example/x", J(a.sc));
    a = await typedAction("go_forward", {});
    ok("go_forward -> navigated + url", a.ch?.navigated === true && a.ch.url === "https://shop.example/c", J(a.sc));
    a = await typedAction("reload", { hard: true });
    ok("reload -> navigated, same_url", a.ch?.navigated === true && a.ch.same_url === true, J(a.sc));
    a = await typedAction("press_key", { key: "Enter" });
    ok("press_key -> typed (navigated)", !a.r.isError && a.ch?.navigated === true && a.ch.url === "https://shop.example/done", J(a.sc));
    a = await typedAction("select_option", { index: 3, label: "M" });
    ok("select_option -> typed", !a.r.isError && a.sc?.message === "Selected M" && a.ch?.navigated === false, J(a.sc));
    a = await typedAction("hover", { x: 5, y: 5 });
    ok("hover by coordinates -> typed", !a.r.isError && a.sc?.message === "Hovered", J(a.sc));

    // errors stay errors, with no typed content (and no schema error)
    answer = "decline";
    a = await typedAction("click_element", { index: 1 });
    answer = "accept";
    ok("a declined click -> isError, no structuredContent", a.r.isError && a.sc === undefined && a.t.endsWith(HINT), J(a.r));
    for (const [name, args, start] of [
      ["click_element", { index: 4 }, "Click aborted"], ["click_element", { index: 5 }, "Click refused"],
      ["click_element", { index: 99 }, "No interactive element"], ["go_back", {}, "Cannot go back"],
      ["select_option", { index: 3 }, "Provide 'value'"], ["hover", {}, "Provide 'index'"],
    ]) {
      a = await typedAction(name, args);
      ok(`${name} '${start}' -> isError, no structuredContent`, a.r.isError && a.sc === undefined && a.t.startsWith(start), J(a.r));
    }

    // the server instructions match what Claude Code hands a script
    const instr = c.getInstructions() ?? "";
    ok("instructions: results reach a script as JSON text; actions return { message, changed }", /Results reach a script as JSON text: parse it\./.test(instr) && /\{ message, changed \}/.test(instr) && !/Reading tools also return typed results/.test(instr), instr.slice(-900));

    // profile notes: an extra text block AND structured `notes`
    const e2 = await connectFakeExtension(WS_PORT, { onCommand: ext, hello: { id: "p2", name: "Second", email: "second@example.com", browser: "Chrome" } });
    await sleep(300);
    r = await call("read_page", {});
    const noteBlock = r.content.slice(1).map((b) => b.text).join("\n");
    ok("a profile connecting -> note as an extra text block", /Browser profile connected: .*Second/.test(noteBlock), J(r.content));
    ok("...and as structured notes; the first block still parses", Array.isArray(r.structuredContent?.notes) && /Second/.test(r.structuredContent.notes.join(" ")) && JSON.parse(firstText(r)).title === "Shop", J(r.structuredContent));
    r = await call("read_page", {});
    ok("...told once", r.content.length === 1 && !r.structuredContent.notes, J(r.content));
    e2.ws.close();

    await c.close();
    e.ws.close();
  } finally {
    proc.kill();
    await sleep(500);
  }

  console.log(`\n[test] ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error("harness error:", e); process.exit(2); });
