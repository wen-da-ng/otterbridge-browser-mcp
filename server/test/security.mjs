// Regression tests for the localhost-exposure fixes:
//  - WS bridge (:8765) rejects browser page Origins, accepts the extension /
//    non-browser clients.
//  - HTTP endpoint (:8000/mcp) rejects spoofed Host (DNS rebinding) and foreign
//    Origin, accepts loopback.
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { WebSocket } from "ws";
import http from "node:http";
import { useTempHome, pairingCode } from "./_ext.mjs";

useTempHome();

// Test servers bridge on a port far outside the range (8765-8774) the real
// Otter extension scans, so a live Chrome never attaches to them. Spawned
// servers inherit it through process.env.
process.env.OTTERBRIDGE_WS_PORT ??= "18765";
const WS_PORT = Number(process.env.OTTERBRIDGE_WS_PORT);

let pass = 0, fail = 0;
const ok = (n, c, e = "") => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n} ${e}`); } };

// "open": the WebSocket opened. A client that hasn't paired yet must receive
// nothing but the pairing challenge — recorded in `firstMessages`.
const firstMessages = [];
function tryWs(origin) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${WS_PORT}`, origin ? { headers: { Origin: origin } } : {});
    ws.on("message", (raw) => firstMessages.push(JSON.parse(raw.toString()).type));
    ws.on("open", () => setTimeout(() => { ws.close(); resolve("open"); }, 300));
    ws.on("error", () => resolve("rejected"));
    ws.on("unexpected-response", () => resolve("rejected"));
  });
}

function httpPost({ host, origin, bearer }) {
  return new Promise((resolve) => {
    const headers = { "Content-Type": "application/json" };
    if (bearer) headers["Authorization"] = `Bearer ${bearer}`;
    if (host) headers["Host"] = host;       // simulate a request naming a foreign host
    if (origin) headers["Origin"] = origin;  // simulate a browser page origin
    const req = http.request(
      { host: "127.0.0.1", port: 8000, path: "/mcp", method: "POST", headers },
      (res) => { res.resume(); resolve(res.statusCode); },
    );
    req.on("error", () => resolve(-1));
    req.end("{}");
  });
}

async function main() {
  const proc = spawn("node", ["dist/index.js"], { cwd: process.cwd(), stdio: ["ignore", "ignore", "ignore"] });
  try {
    await sleep(1200);

    // --- WebSocket bridge origin guard ---
    ok("WS rejects http:// page origin", (await tryWs("http://evil.com")) === "rejected");
    ok("WS rejects https:// page origin", (await tryWs("https://evil.example")) === "rejected");
    ok("WS accepts chrome-extension:// origin", (await tryWs("chrome-extension://abcdefghijklmnop")) === "open");
    firstMessages.length = 0;
    ok("WS accepts no-origin native client", (await tryWs(null)) === "open");
    ok("...but an unpaired client receives nothing but the pairing challenge", JSON.stringify(firstMessages) === '["challenge"]', JSON.stringify(firstMessages));

    // --- HTTP host/origin guard (DNS-rebinding defense) ---
    ok("HTTP 403 on spoofed Host (rebinding)", (await httpPost({ host: "evil.com:8000" })) === 403);
    ok("HTTP 403 on foreign Origin", (await httpPost({ origin: "http://evil.com" })) === 403);
    const good = await httpPost({ host: "127.0.0.1:8000", bearer: await pairingCode() });
    ok("HTTP passes guard on loopback Host", good !== 403 && good !== -1, `got ${good}`);

    console.log(`\n[test] ${pass} passed, ${fail} failed`);
  } finally {
    proc.kill();
  }
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error("harness error:", e); process.exit(2); });
