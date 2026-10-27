// Verifies (a) stdio transport wiring and (b) multi-client coexistence: a
// second server (another Claude client) takes the next free bridge port
// instead of failing.
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { WebSocket } from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Test servers bridge on a port far outside the range (8765-8774) the real
// Otter extension scans, so a live Chrome never attaches to them. Spawned
// servers inherit it through process.env.
process.env.OTTERBRIDGE_WS_PORT ??= "18765";
const WS_PORT = Number(process.env.OTTERBRIDGE_WS_PORT);

let pass = 0, fail = 0;
const ok = (n, c, e = "") => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n} ${e}`); } };

async function main() {
  // (a) stdio: the client spawns the server itself, exactly like Claude Desktop.
  const client = new Client({ name: "stdio-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/index.js", "--stdio"],
    cwd: process.cwd(),
    env: { ...process.env }, // the SDK passes only a filtered env by default
    stderr: "inherit",
  });
  await client.connect(transport);

  // Fake extension attaches to the bridge this stdio server hosts.
  const ext = new WebSocket(`ws://localhost:${WS_PORT}`);
  ext.on("message", (raw) => {
    const { id, action } = JSON.parse(raw.toString());
    const result =
      action === "read_page" ? { url: "https://ok.test", title: "T", text: "x" }
      : action === "open_tab" ? { tabId: 7, url: "about:blank", windowId: 1, label: "Otter · stdio-test 1" }
      : "ok";
    ext.send(JSON.stringify({ id, result }));
  });
  await new Promise((res, rej) => { ext.on("open", res); ext.on("error", rej); });

  const tools = (await client.listTools()).tools;
  ok("stdio: tools/list returns 28 tools", tools.length === 28, `got ${tools.length}`);
  const rp = await client.callTool({ name: "read_page", arguments: {} });
  ok("stdio: read_page round-trips through bridge", rp.content[0].text.includes("ok.test"));

  // (b) multi-client: a SECOND server must come up on the next port and stay up.
  const second = spawn("node", ["dist/index.js", "--stdio"], { cwd: process.cwd(), stdio: ["pipe", "ignore", "pipe"] });
  let stderr = "";
  second.stderr.on("data", (d) => { stderr += d.toString(); });
  const deadline = Date.now() + 4000;
  while (!/listening on ws:\/\/localhost:\d+/.test(stderr) && second.exitCode == null && Date.now() < deadline) await sleep(100);
  ok("second instance binds the next free port", stderr.includes(`listening on ws://localhost:${WS_PORT + 1}`), stderr.slice(0, 200));
  ok("second instance keeps running", second.exitCode == null, `exit=${second.exitCode}`);
  const ext2 = new WebSocket(`ws://localhost:${WS_PORT + 1}`);
  const opened = await new Promise((res) => { ext2.on("open", () => res(true)); ext2.on("error", () => res(false)); });
  ok("extension can attach to the second instance too", opened);
  ext2.close();
  second.kill();

  await client.close();
  console.log(`\n[test] ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error("harness error:", e); process.exit(2); });
