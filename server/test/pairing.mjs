// Bridge pairing (protocol v2): only a client that proves it knows the
// pairing code is treated as the extension; the code reaches the human (in an
// elicitation prompt) but never the model, the audit log or stderr.
import { spawn, execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { WebSocket } from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { useTempHome, pairingCode, connectFakeExtension, httpTransport, mac } from "./_ext.mjs";

// Most of this suite is about pairing switched ON for the computer (opt-in).
useTempHome({ required: true });
process.env.OTTERBRIDGE_WS_PORT ??= "18765";
const WS_PORT = Number(process.env.OTTERBRIDGE_WS_PORT);

let pass = 0, fail = 0;
const ok = (n, c, e = "") => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n} ${e}`); } };
const firstText = (r) => r.content.find((c) => c.type === "text")?.text ?? "";
const fmt = (c) => c.match(/.{4}/g).join("-");

let stderrAll = "";
async function withServer(fn, env = {}) {
  const proc = spawn("node", ["dist/index.js"], { cwd: process.cwd(), env: { ...process.env, ...env }, stdio: ["ignore", "ignore", "pipe"] });
  proc.stderr.on("data", (d) => { stderrAll += d.toString(); });
  try {
    await sleep(1200);
    await fn();
  } finally {
    proc.kill();
    await sleep(400);
  }
}

async function client({ elicit } = {}) {
  const c = new Client({ name: "pairing-test", version: "1.0.0" }, elicit ? { capabilities: { elicitation: {} } } : {});
  if (elicit) c.setRequestHandler(ElicitRequestSchema, elicit);
  await c.connect(await httpTransport());
  return c;
}

const onCommand = (action) =>
  action === "open_tab" ? { tabId: 5, url: "about:blank", windowId: 1, label: "Otter · pairing-test 1" }
  : action === "read_page" ? { url: "https://paired.test", title: "T", text: "x" }
  : "ok";

// A raw client: what an older (0.7.0) extension or a stranger looks like.
function rawClient(path = "") {
  const ws = new WebSocket(`ws://localhost:${WS_PORT}${path}`);
  const got = [];
  let closeCode = null;
  const closed = new Promise((res) => ws.on("close", (code) => { closeCode = code; res(code); }));
  ws.on("message", (raw) => got.push(JSON.parse(raw.toString()).type));
  ws.on("error", () => {});
  const opened = new Promise((res) => ws.on("open", res));
  return { ws, got, closed, opened, closeCode: () => closeCode };
}

function httpStatus(headers) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: "127.0.0.1", port: 8000, path: "/mcp", method: "POST", headers: { "Content-Type": "application/json", ...headers } },
      (res) => { res.resume(); resolve(res.statusCode); },
    );
    req.on("error", () => resolve(-1));
    req.end("{}");
  });
}

async function main() {
  const code = await (async () => {
    // --pairing-code creates the file if needed and prints the code.
    const out = execFileSync("node", ["dist/index.js", "--pairing-code"], { cwd: process.cwd(), env: process.env }).toString().trim();
    const c = await pairingCode();
    ok("--pairing-code prints the code and exits", out === fmt(c), `got "${out}"`);
    return c;
  })();
  const leaks = (s) => s.includes(code) || s.includes(fmt(code));

  await withServer(async () => {
    // 1. Correct code: paired, commands round-trip.
    const good = await connectFakeExtension(WS_PORT, { onCommand });
    const c1 = await client();
    ok("correct code -> paired; a tool call round-trips", firstText(await c1.callTool({ name: "read_page", arguments: {} })).includes("paired.test"));
    good.ws.close();
    await c1.close();
    await sleep(200);

    // 2. Wrong code: refused and closed; a tool call says the codes don't match.
    const wrong = await connectFakeExtension(WS_PORT, { code: "ABCDABCDABCDABCDABCD" }).catch((e) => e);
    ok("wrong code -> auth_failed mismatch", wrong instanceof Error && wrong.message === "auth_failed mismatch", String(wrong));
    const c2 = await client();
    const r2 = await c2.callTool({ name: "navigate", arguments: { url: "https://x.test" } });
    ok("...and a tool call explains the mismatch", r2.isError && firstText(r2).includes("doesn't match"), firstText(r2));
    await c2.close();

    // 3. Unpaired extension + a client that can't show prompts: plain help, no code.
    const unpaired = await connectFakeExtension(WS_PORT, { unpaired: true, onCommand });
    const c3 = await client();
    const t0 = Date.now();
    const r3 = await c3.callTool({ name: "navigate", arguments: { url: "https://x.test" } });
    ok("unpaired -> tool call explains how to pair (fast)", r3.isError && firstText(r3).includes("isn't paired") && Date.now() - t0 < 3000, `${Date.now() - t0}ms ${firstText(r3)}`);
    ok("...pointing to a paired profile's popup (no prompt possible here)", firstText(r3).includes("Show code"), firstText(r3));
    ok("...and the result does not contain the code", !leaks(JSON.stringify(r3)));
    ok("unpaired extension got no command", unpaired.seen.length === 0, JSON.stringify(unpaired.seen));
    const lp = JSON.parse(firstText(await c3.callTool({ name: "list_profiles", arguments: {} })));
    ok("list_profiles flags the waiting unpaired extension", lp.unpaired_extension_waiting === true && lp.profiles.length === 0, JSON.stringify(lp));
    await c3.close();

    // 4. A client that CAN prompt: the human sees the code; pairing during the
    //    prompt lets the original call finish.
    let prompted = "", paired4 = null, prompts = 0;
    const c4 = await client({
      elicit: async (req) => {
        prompts++;
        prompted = req.params.message;
        paired4 = await connectFakeExtension(WS_PORT, { onCommand });
        return { action: "accept", content: { last4: code.slice(-4).toLowerCase() } };
      },
    });
    const [r4, r4b] = await Promise.all([
      c4.callTool({ name: "read_page", arguments: {} }),
      c4.callTool({ name: "list_tabs", arguments: {} }),
    ]);
    ok("elicitation shows the human the formatted code", prompted.includes(fmt(code)), prompted);
    ok("parallel calls share one pairing prompt", prompts === 1, `prompts=${prompts}`);
    ok("after pairing, the original call succeeds", !r4.isError && firstText(r4).includes("paired.test"), firstText(r4));
    ok("...and its result does not contain the code", !leaks(JSON.stringify(r4)) && !leaks(JSON.stringify(r4b)));
    await c4.close();
    paired4?.ws.close();
    unpaired.ws.close();

    // A prompt accepted without the confirmation pairs nothing, and comes back.
    const un2 = await connectFakeExtension(WS_PORT, { unpaired: true, onCommand });
    let shown = 0;
    const cX = await client({ elicit: async () => { shown++; return { action: "accept", content: { last4: "ZZZZ" } }; } });
    const rX = await cX.callTool({ name: "navigate", arguments: { url: "https://x.test" } });
    ok("accept without the last 4 characters -> nothing paired, says try again", rX.isError && firstText(rX).includes("Try again"), firstText(rX));
    await cX.callTool({ name: "navigate", arguments: { url: "https://x.test" } });
    ok("...and the next call shows the prompt again", shown === 2, `shown=${shown}`);
    await cX.close();
    un2.ws.close();

    // 9. HTTP endpoint needs the code as bearer token.
    ok("HTTP without Authorization -> 401", (await httpStatus({})) === 401);
    ok("HTTP with a wrong code -> 401", (await httpStatus({ Authorization: "Bearer ABCD-ABCD-ABCD-ABCD-ABCD" })) === 401);
    const withCode = await httpStatus({ Authorization: `Bearer ${fmt(code).toLowerCase()}` });
    ok("HTTP with the code (any case, dashes) passes", withCode !== 401 && withCode !== -1, `got ${withCode}`);
  });

  await withServer(async () => {
    // 5. A client that never answers the challenge (0.7.0 extension).
    const old = rawClient();
    await old.opened;
    old.ws.send(JSON.stringify({ type: "hello", profile: { id: "old", name: "Old", email: "", browser: "Chrome" } }));
    const c5 = await client();
    const listed = JSON.parse(firstText(await c5.callTool({ name: "list_profiles", arguments: {} })));
    ok("silent client is never listed as a profile", listed.profiles.length === 0, JSON.stringify(listed));
    await Promise.race([old.closed, sleep(7000)]);
    ok("silent client is closed after ~5 s (4400)", old.closeCode() === 4400, `code=${old.closeCode()}`);
    ok("...having received only the challenge", JSON.stringify(old.got) === '["challenge"]', JSON.stringify(old.got));
    const r5 = await c5.callTool({ name: "navigate", arguments: { url: "https://x.test" } });
    ok("...and a tool call says the extension is too old", r5.isError && firstText(r5).includes("older than this OtterBridge server"), firstText(r5));
    await c5.close();

    // 8. Registration needs a fresh MAC.
    const watcher = await connectFakeExtension(WS_PORT, { onCommand });
    const p = WS_PORT + 3;
    const unsigned = rawClient(`/register?port=${p}`);
    await unsigned.closed;
    const ts = String(Date.now());
    const badMac = rawClient(`/register?port=${p}&ts=${ts}&mac=${mac("ABCDABCDABCDABCDABCD", `otterbridge/v2/reg|${p}|${ts}`)}`);
    await badMac.closed;
    const oldTs = String(Date.now() - 120000);
    const stale = rawClient(`/register?port=${p}&ts=${oldTs}&mac=${mac(code, `otterbridge/v2/reg|${p}|${oldTs}`)}`);
    await stale.closed;
    await sleep(200);
    ok("unsigned / wrongly signed / stale registrations are refused", !watcher.announced.has(p), JSON.stringify([...watcher.announced]));
    const ts2 = String(Date.now());
    const signed = rawClient(`/register?port=${p}&ts=${ts2}&mac=${mac(code, `otterbridge/v2/reg|${p}|${ts2}`)}`);
    await signed.opened;
    await sleep(200);
    ok("a signed registration is announced", watcher.announced.has(p), JSON.stringify([...watcher.announced]));
    signed.ws.close();
    watcher.ws.close();
  });

  await withServer(async () => {
    // 6. Relay defence: a MAC computed for another port is rejected.
    const relayed = await connectFakeExtension(WS_PORT, { macPort: WS_PORT + 1 }).catch((e) => e);
    ok("MAC bound to another port -> rejected", relayed instanceof Error && relayed.message === "auth_failed mismatch", String(relayed));

    // 7. Lockout: 5 failures within a minute, then even the right code is refused.
    for (let i = 0; i < 4; i++) await connectFakeExtension(WS_PORT, { code: "ABCDABCDABCDABCDABCD" }).catch(() => {});
    const locked = await connectFakeExtension(WS_PORT).catch((e) => e);
    ok("after 5 failures -> locked (even with the right code)", locked instanceof Error && locked.message === "auth_failed locked", String(locked));
  });

  // Opting out: "Require pairing" switched off in the extension.
  const readRequired = async () =>
    JSON.parse(await readFile(join(process.env.OTTERBRIDGE_HOME, "pairing.json"), "utf-8")).required !== false;
  await withServer(async () => {
    // A. Claiming "no pairing" isn't enough: held until the user decides.
    const heldA = connectFakeExtension(WS_PORT, { open: true, onCommand });
    heldA.catch(() => {});
    await sleep(300);
    const cA = await client({ elicit: async () => ({ action: "decline" }) });
    const lp = JSON.parse(firstText(await cA.callTool({ name: "list_profiles", arguments: {} })));
    ok("an extension asking to skip pairing is held, not listed", lp.profiles.length === 0 && lp.extension_waiting_to_work_without_pairing === true, JSON.stringify(lp));
    const rA = await cA.callTool({ name: "navigate", arguments: { url: "https://x.test" } });
    ok("user declines -> the call says pairing stays on", rA.isError && firstText(rA).includes("keep pairing on"), firstText(rA));
    const refused = await heldA.then(() => null, (e) => e);
    ok("...and the extension is told pairing is required", refused?.message === "auth_failed pairing_required", String(refused));
    ok("...and the computer still requires pairing", await readRequired());
    await cA.close();

    // B. The user allows it in the AI app: let in, setting saved.
    const heldB = connectFakeExtension(WS_PORT, { open: true, onCommand });
    heldB.catch(() => {});
    await sleep(300);
    let promptB = "";
    const cB = await client({ elicit: async (req) => { promptB = req.params.message; return { action: "accept", content: {} }; } });
    const rB = await cB.callTool({ name: "read_page", arguments: {} });
    ok("user allows -> the original call succeeds", !rB.isError && firstText(rB).includes("paired.test"), firstText(rB));
    ok("...the prompt says what it allows (and shows no code)", promptB.includes("without pairing") && !leaks(promptB), promptB);
    ok("...and the computer no longer requires pairing", !(await readRequired()));
    const extB = await heldB;
    await cB.close();

    // C. With pairing off: no-pairing extensions get in at once; HTTP needs no token.
    const extC = await Promise.race([connectFakeExtension(WS_PORT, { open: true, onCommand }), sleep(2000).then(() => null)]);
    ok("pairing off -> a no-pairing extension is let in at once", !!extC);
    const noAuth = await httpStatus({});
    ok("pairing off -> HTTP works without the token", noAuth !== 401 && noAuth !== -1, `got ${noAuth}`);

    // D. Only a PAIRED extension can change the setting.
    extC?.ws.send(JSON.stringify({ type: "require_pairing" }));
    await sleep(300);
    ok("an extension let in without pairing can't change the setting", !(await readRequired()));
    const paired = await connectFakeExtension(WS_PORT, { onCommand });
    const closedC = new Promise((res) => extC?.ws.on("close", res));
    paired.ws.send(JSON.stringify({ type: "require_pairing" }));
    await sleep(300);
    ok("a paired extension turns pairing back on", await readRequired());
    ok("...which disconnects the extensions let in without pairing", await Promise.race([closedC.then(() => true), sleep(1000).then(() => false)]));
    ok("...and HTTP needs the token again", (await httpStatus({})) === 401);
    paired.ws.send(JSON.stringify({ type: "pairing_off" }));
    await sleep(300);
    ok("a paired extension's switch turns pairing off without a prompt", !(await readRequired()));
    ok("paired extensions are told the computer's setting as it changes", JSON.stringify(paired.pairingStates) === "[false,true,false]", JSON.stringify(paired.pairingStates));
    paired.ws.send(JSON.stringify({ type: "require_pairing" }));
    await sleep(300);
    paired.ws.close();
    extB.ws.close();
  });

  // pair_browser: show the code for a profile that switched pairing on while
  // others are already connected (no automatic prompt in that case).
  await withServer(async () => {
    const first = await connectFakeExtension(WS_PORT, { onCommand, hello: { id: "p1", name: "One", email: "", browser: "Chrome" } });
    const cN = await client();
    const none = firstText(await cN.callTool({ name: "pair_browser", arguments: {} }));
    ok("pair_browser with nothing waiting -> explains how to start", none.startsWith("No Otter extension is waiting"), none);
    await cN.close();
    const waiting = await connectFakeExtension(WS_PORT, { unpaired: true });
    let second = null, promptP = "";
    const cP = await client({
      elicit: async (req) => {
        promptP = req.params.message;
        second = await connectFakeExtension(WS_PORT, { onCommand, hello: { id: "p2", name: "Two", email: "", browser: "Chrome" } });
        return { action: "accept", content: { last4: code.slice(-4) } };
      },
    });
    const rP = await cP.callTool({ name: "pair_browser", arguments: {} });
    ok("pair_browser shows the code while another profile is connected", promptP.includes(fmt(code)), promptP);
    ok("...and reports the new profile once it pairs", !rP.isError && firstText(rP).startsWith("Paired.") && firstText(rP).includes("Two"), firstText(rP));
    ok("...without the code in its result", !leaks(JSON.stringify(rP)));
    await cP.close();
    first.ws.close(); waiting.ws.close(); second?.ws.close();
  });

  // Opt-in default: a computer that never switched pairing on.
  const freshHome = mkdtempSync(join(tmpdir(), "otterbridge-fresh-"));
  await withServer(async () => {
    const created = JSON.parse(await readFile(join(freshHome, "pairing.json"), "utf-8"));
    ok("a new pairing.json starts with pairing off (opt-in)", created.required === false, JSON.stringify({ required: created.required }));
    const ext = await Promise.race([connectFakeExtension(WS_PORT, { open: true, onCommand }), sleep(2000).then(() => null)]);
    ok("default: an extension without pairing works at once", !!ext);
    const st = await httpStatus({});
    ok("default: HTTP needs no token", st !== 401 && st !== -1, `got ${st}`);
    ext?.ws.close();
  }, { OTTERBRIDGE_HOME: freshHome });

  // The code never reaches stderr or the audit log.
  const audit = await readFile(join(process.cwd(), "agent_actions.log"), "utf-8").catch(() => "");
  ok("pairing code never appears on stderr", !leaks(stderrAll));
  ok("pairing code never appears in the audit log", !leaks(audit));
  ok("pairing events are audited", audit.includes('"action":"pairing"'));

  console.log(`\n[test] ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error("harness error:", e); process.exit(2); });
