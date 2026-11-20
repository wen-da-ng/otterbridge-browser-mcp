// Verifies (a) stdio transport wiring and (b) multi-client coexistence: a
// second server (another Claude client) takes the next free bridge port
// instead of failing.
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { WebSocket } from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { useTempHome, connectFakeExtension } from "./_ext.mjs";

useTempHome();

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
  const { announced } = await connectFakeExtension(WS_PORT, {
    onCommand: (action) =>
      action === "read_page" ? { url: "https://ok.test", title: "T", text: "x" }
      : action === "open_tab" ? { tabId: 7, url: "about:blank", windowId: 1, label: "Otter · stdio-test 1" }
      : "ok",
  }); // `announced`: ports the registry told us about

  const tools = (await client.listTools()).tools;
  ok("stdio: tools/list returns 44 tools", tools.length === 44, `got ${tools.length}`);
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
  // Pairs on the second port too (the MAC is bound to the port it's on).
  const ext2 = await connectFakeExtension(WS_PORT + 1).catch((e) => e);
  ok("extension can pair with the second instance too", !(ext2 instanceof Error), String(ext2));
  if (!(ext2 instanceof Error)) ext2.ws.close();
  for (let i = 0; i < 30 && !announced.has(WS_PORT + 1); i++) await sleep(100);
  ok("registry announces the second instance's port to the extension", announced.has(WS_PORT + 1), JSON.stringify([...announced]));

  // The registry's server exits: the survivor must take the registry port over.
  await client.close();
  for (let i = 0; i < 50 && !stderr.includes(`registry on ws://localhost:${WS_PORT}`); i++) await sleep(100);
  ok("survivor takes over the registry port", stderr.includes(`registry on ws://localhost:${WS_PORT}`), stderr.slice(-300));
  second.kill();

  console.log(`\n[test] ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error("harness error:", e); process.exit(2); });
