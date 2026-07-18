// Verifies (a) stdio transport wiring and (b) the single-instance :8765 guard.
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { WebSocket } from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

let pass = 0, fail = 0;
const ok = (n, c, e = "") => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n} ${e}`); } };

async function main() {
  // (a) stdio: the client spawns the server itself, exactly like Claude Desktop.
  const client = new Client({ name: "stdio-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/index.js", "--stdio"],
    cwd: process.cwd(),
    stderr: "inherit",
  });
  await client.connect(transport);

  // Fake extension attaches to the bridge this stdio server hosts.
  const ext = new WebSocket("ws://localhost:8765");
  ext.on("message", (raw) => {
    const { id, action } = JSON.parse(raw.toString());
    ext.send(JSON.stringify({ id, result: action === "read_page" ? { url: "https://ok.test", title: "T", text: "x" } : "ok" }));
  });
  await new Promise((res, rej) => { ext.on("open", res); ext.on("error", rej); });

  const tools = (await client.listTools()).tools;
  ok("stdio: tools/list returns 26 tools (22 core + 4 tab)", tools.length === 26, `got ${tools.length}`);
  const rp = await client.callTool({ name: "read_page", arguments: {} });
  ok("stdio: read_page round-trips through bridge", rp.content[0].text.includes("ok.test"));

  // (b) single-instance guard: a SECOND server must fail to bind :8765 and exit.
  const second = spawn("node", ["dist/index.js", "--stdio"], { cwd: process.cwd(), stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  second.stderr.on("data", (d) => { stderr += d.toString(); });
  const code = await new Promise((res) => { second.on("exit", res); setTimeout(() => { second.kill(); res("timeout"); }, 4000); });
  ok("second instance exits non-zero on :8765 conflict", code !== 0 && code !== "timeout", `exit=${code}`);
  ok("second instance logs the bind-conflict fatal", /could not bind ws:\/\/localhost:8765/.test(stderr), stderr.slice(0, 200));

  await client.close();
  console.log(`\n[test] ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error("harness error:", e); process.exit(2); });
