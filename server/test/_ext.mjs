// Shared test helpers: an isolated pairing home, the pairing code, a fake
// Otter extension that performs the v2 pairing handshake, and an HTTP client
// transport carrying the bearer token.
import { createHmac, randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { WebSocket } from "ws";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// Every suite calls this FIRST: spawned servers inherit OTTERBRIDGE_HOME, so
// tests never read or create the user's real ~/.otterbridge/pairing.json.
// required: write a pairing.json up front with pairing switched on (true) or
// off (false) for "this computer"; omitted, the server creates its default.
export function useTempHome({ required } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "otterbridge-test-"));
  process.env.OTTERBRIDGE_HOME = dir;
  if (required !== undefined) {
    const code = [...randomBytes(20)].map((b) => ALPHABET[b & 31]).join("").match(/.{4}/g).join("-");
    writeFileSync(join(dir, "pairing.json"), JSON.stringify({ v: 1, code, required }) + "\n");
  }
  return dir;
}

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export function normalizeCode(s) {
  const t = String(s).toUpperCase().replace(/O/g, "0").replace(/[IL]/g, "1")
    .split("").filter((c) => ALPHABET.includes(c)).join("");
  return t.length === 20 ? t : null;
}

// The code a spawned server created (polls until the file exists).
export async function pairingCode(timeoutMs = 8000) {
  const file = join(process.env.OTTERBRIDGE_HOME, "pairing.json");
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const code = normalizeCode(JSON.parse(await readFile(file, "utf-8")).code);
      if (code) return code;
    } catch { /* not written yet */ }
    if (Date.now() > deadline) throw new Error(`no pairing code in ${file}`);
    await sleep(100);
  }
}

export const mac = (code, msg) => createHmac("sha256", code).update(msg).digest("hex");

// A fake extension on `port`. Answers the challenge with `code` (default: the
// real one; pass a wrong one, or `unpaired: true`, to test failures). After
// pairing it sends `hello` if given, routes commands to onCommand(action,
// params, msg) — sync or async — and records `bridges` announcements.
// macPort: compute the MAC as if connected to another port (relay test).
// Resolves once paired; rejects with the failure reason.
export async function connectFakeExtension(port, opts = {}) {
  // A freshly spawned server may not be listening yet: retry refused
  // connections for a few seconds. Pairing failures are never retried.
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      return await connectOnce(port, opts);
    } catch (e) {
      const notUp = e.code === "ECONNREFUSED" || e.message === "closed before pairing";
      if (!notUp || Date.now() > deadline) throw e;
      await sleep(200);
    }
  }
}

async function connectOnce(port, opts) {
  // open: "Require pairing" switched off — resolves once the server lets it
  // in (which may wait for the user's OK), rejects if refused.
  const { onCommand, hello, unpaired = false, open = false, macPort = port } = opts;
  const code = unpaired || open ? null : (opts.code ?? (await pairingCode()));
  const ws = new WebSocket(`ws://localhost:${port}`);
  const seen = [];      // action names, in order
  const msgs = [];      // full command messages
  const announced = new Set();
  const received = [];  // every message type before pairing (for assertions)
  const pairingStates = []; // the computer's "required" setting, as the server reports it
  const pings = [];         // the live-session list of each heartbeat
  let ns, ne, settle;
  const paired = new Promise((res, rej) => { settle = { res, rej }; });
  paired.catch(() => {});
  ws.on("message", async (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === "challenge") {
      received.push("challenge");
      if (unpaired) { ws.send(JSON.stringify({ type: "unpaired", v: 2 })); settle.res(); return; }
      if (open) { ws.send(JSON.stringify({ type: "open", v: 2 })); return; }
      ns = msg.nonce;
      ne = randomBytes(16).toString("hex");
      ws.send(JSON.stringify({ type: "auth", v: 2, nonce: ne, mac: mac(code, `otterbridge/v2/ext|${ns}|${ne}|${macPort}`) }));
      return;
    }
    if (msg.type === "auth_ok" && open) {
      if (msg.open !== true) { settle.rej(new Error("expected an open auth_ok")); return; }
      if (hello) ws.send(JSON.stringify({ type: "hello", profile: hello }));
      settle.res();
      return;
    }
    if (msg.type === "auth_ok") {
      if (msg.mac !== mac(code, `otterbridge/v2/srv|${ns}|${ne}|${macPort}`)) { settle.rej(new Error("server MAC wrong")); ws.close(); return; }
      if (hello) ws.send(JSON.stringify({ type: "hello", profile: hello }));
      settle.res();
      return;
    }
    if (msg.type === "auth_failed") { settle.rej(new Error(`auth_failed ${msg.reason}`)); return; }
    if (msg.type === "bridges") { (msg.ports || []).forEach((p) => announced.add(p)); return; }
    if (msg.type === "pairing_state") { pairingStates.push(msg.required); return; }
    if (msg.type === "ping") { pings.push(msg.agents || []); return; }
    if (msg.type) { received.push(msg.type); return; } // ping, ...
    received.push("command");
    seen.push(msg.action);
    msgs.push(msg);
    let result = null, error = null;
    try { result = await onCommand?.(msg.action, msg.params || {}, msg); } catch (e) { error = e.message; }
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ id: msg.id, result, error }));
  });
  ws.on("close", () => settle.rej(new Error("closed before pairing")));
  await new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });
  await paired;
  return { ws, seen, msgs, announced, received, pairingStates, pings };
}

// Streamable-HTTP transport with the pairing code as bearer token.
export async function httpTransport(url = "http://127.0.0.1:8000/mcp") {
  const code = await pairingCode();
  return new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${code}` } },
  });
}
