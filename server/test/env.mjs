// Pins the env-string parsing the .mcpb manifest relies on: user_config
// booleans substitute into env as the literal strings "true"/"false", so the
// server must treat BROWSER_AGENT_GATE=false as gate-off and
// BROWSER_AGENT_GATE_FALLBACK=true as fail-open.
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { WebSocket } from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

let pass = 0, fail = 0;
const ok = (n, c, e = "") => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n} ${e}`); } };
const firstText = (r) => r.content.find((c) => c.type === "text")?.text ?? "";

// Extension canned so index 1 is the destructive "Submit order" element.
function ext(ws) {
  ws.on("message", (raw) => {
    const { id, action, params } = JSON.parse(raw.toString());
    const els = [{ index: 0, tag: "a", text: "Home", x: 10, y: 10 }, { index: 1, tag: "button", text: "Submit order", x: 20, y: 20 }];
    let result;
    if (action === "locate_element") { const e = els[params.index]; result = e ? { found: true, ...e } : { found: false }; }
    else if (action === "click") result = `Clicked at (${params.x}, ${params.y})`;
    else result = "ok";
    ws.send(JSON.stringify({ id, result }));
  });
}

async function scenario(env, label, expectClicked) {
  const proc = spawn("node", ["dist/index.js"], { cwd: process.cwd(), env: { ...process.env, ...env }, stdio: ["ignore", "ignore", "ignore"] });
  try {
    await sleep(1000);
    const ws = new WebSocket("ws://localhost:8765");
    ext(ws);
    await new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });
    // Client WITHOUT elicitation capability, so the gate must resolve via env alone.
    const client = new Client({ name: "env-test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8000/mcp")));
    const r = firstText(await client.callTool({ name: "click_element", arguments: { index: 1 } }));
    const clicked = r === "Clicked at (20, 20)";
    ok(label, clicked === expectClicked, `got "${r}"`);
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
