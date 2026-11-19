// Pins the env-string parsing the .mcpb manifest relies on: user_config
// booleans substitute into env as the literal strings "true"/"false", so the
// server must treat BROWSER_AGENT_GATE=false as gate-off and
// BROWSER_AGENT_GATE_FALLBACK=true as fail-open.
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { WebSocket } from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { useTempHome, connectFakeExtension, httpTransport } from "./_ext.mjs";

useTempHome();

// Test servers bridge on a port far outside the range (8765-8774) the real
// Otter extension scans, so a live Chrome never attaches to them. Spawned
// servers inherit it through process.env.
process.env.OTTERBRIDGE_WS_PORT ??= "18765";
const WS_PORT = Number(process.env.OTTERBRIDGE_WS_PORT);

let pass = 0, fail = 0;
const ok = (n, c, e = "") => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n} ${e}`); } };
const firstText = (r) => r.content.find((c) => c.type === "text")?.text ?? "";

// Extension canned so index 1 is the destructive "Submit order" element.
let lastClick = null;
function ext(action, params) {
  if (action === "click") lastClick = params;
  const els = [{ index: 0, tag: "a", text: "Home", x: 10, y: 10 }, { index: 1, tag: "button", text: "Submit order", x: 20, y: 20 }];
  if (action === "open_tab") return { tabId: 1, url: "about:blank", windowId: 1, label: "Otter · env-test 1" };
  if (action === "locate_element") { const e = els[params.index]; return e ? { found: true, ...e } : { found: false }; }
  if (action === "click") { const e = params.index != null ? els[params.index] : null; return `Clicked at (${e ? e.x : params.x}, ${e ? e.y : params.y})`; }
  return "ok";
}

async function scenario(env, label, expectClicked) {
  const proc = spawn("node", ["dist/index.js"], { cwd: process.cwd(), env: { ...process.env, ...env }, stdio: ["ignore", "ignore", "ignore"] });
  try {
    await sleep(1000);
    const { ws } = await connectFakeExtension(WS_PORT, { onCommand: ext });
    // Client WITHOUT elicitation capability, so the gate must resolve via env alone.
    const client = new Client({ name: "env-test", version: "1.0.0" });
    await client.connect(await httpTransport());
    const r = firstText(await client.callTool({ name: "click_element", arguments: { index: 1 } }));
    const clicked = r === "Clicked at (20, 20)";
    ok(label, clicked === expectClicked, `got "${r}"`);
    if (clicked) ok(`${label}: the click is marked gated (approved by config)`, lastClick?.gated === true, JSON.stringify(lastClick));
    await client.close();
    ws.close();
  } finally { proc.kill(); await sleep(300); }
}

async function main() {
  // gate ON (true) + no elicit + fallback deny (false) -> DENIED
  await scenario({ BROWSER_AGENT_GATE: "true", BROWSER_AGENT_GATE_FALLBACK: "false" }, "GATE=true FALLBACK=false -> destructive DENIED", false);
  // gate ON (true) + no elicit + fallback allow (true) -> ALLOWED
  await scenario({ BROWSER_AGENT_GATE: "true", BROWSER_AGENT_GATE_FALLBACK: "true" }, "GATE=true FALLBACK=true -> destructive ALLOWED (fail-open)", true);
  // gate OFF (false) -> ALLOWED without any elicitation
  await scenario({ BROWSER_AGENT_GATE: "false", BROWSER_AGENT_GATE_FALLBACK: "false" }, "GATE=false -> gate disabled, destructive ALLOWED", true);
  console.log(`\n[test] ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error("harness error:", e); process.exit(2); });
