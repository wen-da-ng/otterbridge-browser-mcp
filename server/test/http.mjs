// End-to-end smoke test for the Node OtterBridge server.
// Spawns the built server (HTTP mode), fakes the Chrome extension over the
// WebSocket bridge with canned responses, and drives the MCP tools over HTTP.
// Verifies the 9 tools, image content, and BOTH destructive-gate branches.
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { WebSocket } from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { useTempHome, connectFakeExtension, httpTransport } from "./_ext.mjs";

useTempHome();

// Test servers bridge on a port far outside the range (8765-8774) the real
// Otter extension scans, so a live Chrome never attaches to them. Spawned
// servers inherit it through process.env.
process.env.OTTERBRIDGE_WS_PORT ??= "18765";
const WS_PORT = Number(process.env.OTTERBRIDGE_WS_PORT);

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
  { index: 2, tag: "button", text: "Open menu", x: 30, y: 30 }, // under a cookie banner
  // The extension's own gate check: the live target turned out destructive.
  { index: 3, tag: "button", text: "Home2", x: 40, y: 40 },  // -> "Delete" unless gated
  { index: 4, tag: "button", text: "Weird", x: 50, y: 50 },  // refused with the SAME text
];
const clicks = [];          // params of every click command
let enterLabels = [];       // what the page says Enter would trigger
const enterProbes = [];     // params of every enter_target call
const keyParams = [];       // params of press_key / type_text / fill_element
let evalParams = null;
let dialog = { open: false };
let approvalMode = "ask"; // the extension popup's Full Auto switch
const opened = [];          // open_tab calls seen, to check auto-open
function handleExtension(action, p) {
  switch (action) {
    case "ping": return { pong: true, ts: 1 };
    case "get_approval_mode": return { mode: approvalMode };
    case "open_tab":
      opened.push(p);
      return { tabId: 42, url: p.url || "about:blank", title: "T", windowId: 9, groupId: 3, label: `Otter · ${p.clientName} 1` };
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
    case "click": {
      // Mirror the real extension: an index click re-resolves its own live
      // coords from the element list (the server no longer passes x/y for
      // index clicks). Raw clicks fall back to the given coordinates.
      const el = p.index != null ? ELEMENTS[p.index] : null;
      clicks.push(p);
      if (p.index === 2) return { changed: true, covered: true, actualText: "Accept cookies", x: 30, y: 30 };
      if (p.index === 3 && p.gated !== true) return { changed: true, ungated: true, actualText: "Delete", x: 40, y: 40 };
      if (p.index === 4) return { changed: true, ungated: true, actualText: "Weird", x: 50, y: 50 };
      const verb = p.button === "right" ? "Right-clicked" : p.double ? "Double-clicked" : "Clicked";
      return `${verb} at (${el ? el.x : p.x}, ${el ? el.y : p.y})`;
    }
    case "enter_target": enterProbes.push(p); return { labels: enterLabels };
    case "type_text": keyParams.push(p); return `Typed ${(p.text || "").length} chars`;
    case "press_key": keyParams.push(p); return `Pressed ${p.key}`;
    case "scroll": return "Scrolled";
    case "fill_element": keyParams.push(p); return `Filled element ${p.index} with ${(p.text || "").length} chars`;
    case "upload_file": return p.dryRun ? { ok: true, url: "https://upload.example/form", multiple: false } : "Attached 1 file(s) to the file input.";
    case "dialog_info": return dialog;
    case "handle_dialog": dialog = { open: false }; return `${p.accept ? "Accepted" : "Dismissed"} the dialog.`;
    case "evaluate_js": evalParams = p; return { type: "number", result: "2" };
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
  await client.connect(await httpTransport());
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
    const ext = await connectFakeExtension(WS_PORT, { onCommand: handleExtension });
    console.log("[test] fake extension paired with the bridge");

    // --- MCP client that CAN elicit (approves destructive) ---
    const client = await mkClient({ elicit: true });

    const toolDefs = (await client.listTools()).tools;
    const tools = toolDefs.map((t) => t.name).sort();
    const def = (n) => toolDefs.find((t) => t.name === n);
    ok("every tool has a title + annotations", toolDefs.every((t) => t.title && t.annotations?.title === t.title), JSON.stringify(toolDefs.filter((t) => !t.title).map((t) => t.name)));
    ok("read_page is read-only, click_element destructive", def("read_page")?.annotations?.readOnlyHint === true && def("click_element")?.annotations?.destructiveHint === true);
    ok("state-changing tools never claim read-only (Claude Code parallelizes those)", ["find_text", "use_tab", "scroll", "navigate"].every((n) => def(n)?.annotations?.readOnlyHint === false));
    const expected = [
      "click", "click_element", "close_tab", "drag", "evaluate_js", "fill_element",
      "find_text", "get_network_body", "go_back", "go_forward", "hover", "list_tabs",
      "navigate", "open_tab", "press_key", "read_console", "read_elements",
      "read_network", "read_page", "reload", "run_script", "screenshot", "scroll",
      "select_option", "type_text", "use_tab", "wait_for", "get_user_tab",
      "page_snapshot", "handle_dialog", "upload_file", "wait_for_download", "set_viewport", "save_pdf",
      "list_profiles", "use_profile", "pair_browser",
      "throttle", "perf_audit", "perf_record", "css_coverage",
    ].sort();
    ok("tools/list has all 41 tools", JSON.stringify(tools) === JSON.stringify(expected), `got ${JSON.stringify(tools)}`);

    const rp = await client.callTool({ name: "read_page", arguments: {} });
    ok("read_page returns JSON text", firstText(rp).includes("example.com"));
    ok("first tool call auto-opens the session's own tab", opened.length === 1 && typeof opened[0].agentId === "string", JSON.stringify(opened));
    ok("open_tab carries the client name for the group label", opened[0]?.clientName === "smoketest", JSON.stringify(opened[0]));
    await client.callTool({ name: "read_page", arguments: {} });
    ok("later calls reuse the session tab (no second window)", opened.length === 1, `opened=${opened.length}`);

    const nav = await client.callTool({ name: "navigate", arguments: { url: "https://x.test" } });
    ok("navigate", firstText(nav) === "Navigated to https://x.test");

    const ss = await client.callTool({ name: "screenshot", arguments: {} });
    const img = ss.content.find((c) => c.type === "image");
    ok("screenshot returns image/jpeg block", img && img.mimeType === "image/jpeg" && img.data === TINY_JPEG);

    const safe = await client.callTool({ name: "click_element", arguments: { index: 0 } });
    const dbl = await client.callTool({ name: "click_element", arguments: { index: 0, double: true } });
    ok("double-click passes through", firstText(dbl) === "Double-clicked at (10, 10)", `got "${firstText(dbl)}"`);
    ok("click_element safe (Home) clicks without gate", firstText(safe) === "Clicked at (10, 10)");

    const dangerApproved = await client.callTool({ name: "click_element", arguments: { index: 1 } });
    ok("click_element destructive + elicit-accept -> clicks", firstText(dangerApproved) === "Clicked at (20, 20)", `got "${firstText(dangerApproved)}"`);

    const missing = await client.callTool({ name: "click_element", arguments: { index: 99 } });
    ok("click_element missing index -> guidance", firstText(missing).startsWith("No interactive element"));

    const rawClickDanger = await client.callTool({ name: "click", arguments: { x: 20, y: 20 } });
    ok("click(x,y) on destructive + elicit-accept -> clicks", firstText(rawClickDanger) === "Clicked at (20, 20)");

    // Second line of defence: approved commands are marked, others aren't.
    clicks.length = 0;
    await client.callTool({ name: "click_element", arguments: { index: 1 } });
    await client.callTool({ name: "click_element", arguments: { index: 0 } });
    ok("approved destructive click carries gated: true", clicks[0]?.gated === true, JSON.stringify(clicks[0]));
    ok("harmless click carries no gated flag", clicks[1] && !("gated" in clicks[1]), JSON.stringify(clicks[1]));
    const regated = await client.callTool({ name: "click_element", arguments: { index: 3 } });
    ok("extension refuses an ungated 'Delete' -> server gates it, then clicks", firstText(regated) === "Clicked at (40, 40)", `got "${firstText(regated)}"`);
    await client.callTool({ name: "evaluate_js", arguments: { code: "1+1" } });
    ok("approved evaluate_js carries gated: true", evalParams?.gated === true, JSON.stringify(evalParams));

    // Enter that would trigger something destructive: asked, then marked gated.
    enterLabels = ["Send"];
    keyParams.length = 0;
    const enterOk = await client.callTool({ name: "press_key", arguments: { key: "Enter" } });
    ok("Enter that would 'Send' + approval -> pressed, marked gated", firstText(enterOk).startsWith("Pressed Enter") && keyParams[0]?.gated === true, `${firstText(enterOk)} ${JSON.stringify(keyParams[0])}`);
    enterLabels = [];

    const typed = await client.callTool({ name: "type_text", arguments: { text: "hello" } });
    ok("type_text", firstText(typed) === "Typed 5 chars");

    const scrolled = await client.callTool({ name: "scroll", arguments: {} });
    ok("scroll default", firstText(scrolled) === "Scrolled");

    await client.close();

    // --- MCP client that CANNOT elicit (fail-safe deny) ---
    const noElicit = await mkClient({ elicit: false });
    const denied = await noElicit.callTool({ name: "click_element", arguments: { index: 1 } });
    ok("destructive + no elicitation -> fail-safe DENY", firstText(denied).startsWith("Action denied by user"), `got "${firstText(denied)}"`);

    // An overlay over the target: never click through it, say what's in the way.
    const covered = await noElicit.callTool({ name: "click_element", arguments: { index: 2 } });
    ok("covered target is not clicked; result names the overlay", firstText(covered).startsWith("Click aborted: the target is covered by 'Accept cookies'"), `got "${firstText(covered)}"`);

    // Uploads send the user's files to a website: approval required.
    const pkg = join(process.cwd(), "package.json");
    const up = await noElicit.callTool({ name: "upload_file", arguments: { files: [pkg] } });
    ok("upload_file without approval -> DENIED", firstText(up).startsWith("Action denied by user: upload of package.json"), `got "${firstText(up)}"`);
    const upRel = await noElicit.callTool({ name: "upload_file", arguments: { files: ["package.json"] } });
    ok("upload_file rejects relative paths", firstText(upRel).includes("isn't an absolute path"), `got "${firstText(upRel)}"`);

    // OK on a destructive confirm() = a destructive click: gated. Cancel never is.
    dialog = { open: true, type: "confirm", message: "Delete 3 files?" };
    const dOk = await noElicit.callTool({ name: "handle_dialog", arguments: { accept: true } });
    ok("accepting a destructive confirm without approval -> DENIED", firstText(dOk).startsWith("Action denied by user"), `got "${firstText(dOk)}"`);
    const dNo = await noElicit.callTool({ name: "handle_dialog", arguments: { accept: false } });
    ok("dismissing a dialog is never gated", firstText(dNo) === "Dismissed the dialog.", `got "${firstText(dNo)}"`);

    // Typed text never reaches the audit log.
    await noElicit.callTool({ name: "fill_element", arguments: { index: 0, text: "s3cret-PW-4711" } });
    await sleep(100);
    const log = await readFile(join(process.cwd(), "agent_actions.log"), "utf-8").catch(() => "");
    ok("audit log redacts typed text", log.includes('"text":"[14 chars]"') && !log.includes("s3cret-PW-4711"));

    // Enter submits forms and sends chat messages: gated like a click.
    enterLabels = ["Send"];
    const enterNo = await noElicit.callTool({ name: "press_key", arguments: { key: "Enter" } });
    ok("Enter that would 'Send', no approval -> DENIED", firstText(enterNo) === "Action denied by user: Enter would trigger 'Send'.", `got "${firstText(enterNo)}"`);
    const ctrlEnter = await noElicit.callTool({ name: "press_key", arguments: { key: "Control+Enter" } });
    ok("Control+Enter is gated too", firstText(ctrlEnter).startsWith("Action denied by user"), `got "${firstText(ctrlEnter)}"`);
    enterProbes.length = 0;
    const shiftEnter = await noElicit.callTool({ name: "press_key", arguments: { key: "Shift+Enter" } });
    ok("Shift+Enter (newline in chat boxes) isn't gated", firstText(shiftEnter) === "Pressed Shift+Enter" && enterProbes.length === 0, `got "${firstText(shiftEnter)}"`);
    const letter = await noElicit.callTool({ name: "press_key", arguments: { key: "a" } });
    ok("other keys aren't probed or gated", firstText(letter) === "Pressed a" && enterProbes.length === 0);
    const typedNl = await noElicit.callTool({ name: "type_text", arguments: { text: "hello\n" } });
    ok("type_text with a line break is gated like Enter", firstText(typedNl).startsWith("Action denied by user: Enter"), `got "${firstText(typedNl)}"`);
    const fillNl = await noElicit.callTool({ name: "fill_element", arguments: { index: 0, text: "a\nb" } });
    ok("fill_element with a line break asks about THAT field's Enter", firstText(fillNl).startsWith("Action denied by user: Enter") && enterProbes.at(-1)?.index === 0, `got "${firstText(fillNl)}" ${JSON.stringify(enterProbes.at(-1))}`);
    enterLabels = ["Search"];
    keyParams.length = 0;
    const search = await noElicit.callTool({ name: "press_key", arguments: { key: "Enter" } });
    ok("Enter that would 'Search' -> pressed without asking, not marked gated", firstText(search) === "Pressed Enter" && !("gated" in (keyParams[0] || {})), `got "${firstText(search)}"`);
    enterLabels = [];

    // Right-click only opens a context menu: never gated, even on a danger word.
    const rc = await noElicit.callTool({ name: "click_element", arguments: { index: 1, button: "right" } });
    ok("right-click on destructive element is not gated", firstText(rc) === "Right-clicked at (20, 20)", `got "${firstText(rc)}"`);
    const rcRaw = await noElicit.callTool({ name: "click", arguments: { x: 20, y: 20, button: "right" } });
    ok("right-click(x,y) is not gated either", firstText(rcRaw) === "Right-clicked at (20, 20)", `got "${firstText(rcRaw)}"`);

    // The extension saw a destructive target the server didn't gate.
    const refusedNew = await noElicit.callTool({ name: "click_element", arguments: { index: 3 } });
    ok("ungated 'Delete' seen by the extension -> server asks -> denied", firstText(refusedNew) === "Action denied by user: click on 'Delete'.", `got "${firstText(refusedNew)}"`);
    const refusedSame = await noElicit.callTool({ name: "click_element", arguments: { index: 4 } });
    ok("extension refusal with unchanged text -> refused, no loop", firstText(refusedSame).startsWith("Click refused by the browser extension: 'Weird'"), `got "${firstText(refusedSame)}"`);

    // --- Full Auto (extension popup switch): no prompt, no denial ---
    approvalMode = "auto";
    const auto = await noElicit.callTool({ name: "click_element", arguments: { index: 1 } });
    ok("Full Auto: destructive click proceeds without elicitation", firstText(auto) === "Clicked at (20, 20)", `got "${firstText(auto)}"`);
    approvalMode = "ask";
    const back = await noElicit.callTool({ name: "click_element", arguments: { index: 1 } });
    ok("switching back to Ask re-arms the gate immediately", firstText(back).startsWith("Action denied by user"), `got "${firstText(back)}"`);
    await noElicit.close();

    console.log(`\n[test] ${pass} passed, ${fail} failed`);
  } finally {
    proc.kill();
  }
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error("[test] harness error:", e); process.exit(2); });
