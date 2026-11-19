// Several browser profiles on one server: each Chrome profile runs its own
// extension copy and announces itself with a hello. Commands must reach the
// profile the session chose — never "whichever connected last".
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { WebSocket } from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// Test servers bridge on a port far outside the range (8765-8774) the real
// Otter extension scans, so a live Chrome never attaches to them. Spawned
// servers inherit it through process.env.
process.env.OTTERBRIDGE_WS_PORT ??= "18765";
const WS_PORT = Number(process.env.OTTERBRIDGE_WS_PORT);

let pass = 0, fail = 0;
const ok = (n, c, e = "") => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n} ${e}`); } };
const firstText = (r) => r.content.find((c) => c.type === "text")?.text ?? "";

// A fake extension for one profile: says hello, records what it was asked.
async function fakeProfile(id, name, email) {
  const ws = new WebSocket(`ws://localhost:${WS_PORT}`);
  const seen = [];
  const sessionNos = []; // sessionNo of each open_tab
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type) return; // registry messages / heartbeat
    seen.push(msg.action);
    if (msg.action === "open_tab") sessionNos.push(msg.params.sessionNo);
    const result =
      msg.action === "open_tab" ? { tabId: name === "Work" ? 70 : name === "Personal" ? 80 : 7, url: "about:blank", windowId: 1, label: "Otter · test 1" }
      : msg.action === "navigate" ? `Navigated in ${name}`
      : "ok";
    ws.send(JSON.stringify({ id: msg.id, result }));
  });
  await new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });
  ws.send(JSON.stringify({ type: "hello", profile: { id, name, email, browser: "Chrome" } }));
  return { ws, seen, sessionNos };
}

async function client() {
  const c = new Client({ name: "profiles-test", version: "1.0.0" });
  await c.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8000/mcp")));
  return c;
}

async function withServer(env, fn) {
  const proc = spawn("node", ["dist/index.js"], { cwd: process.cwd(), env: { ...process.env, ...env }, stdio: ["ignore", "ignore", "ignore"] });
  try {
    await sleep(1200);
    await fn();
  } finally {
    proc.kill();
    await sleep(300);
  }
}

async function main() {
  await withServer({}, async () => {
    const work = await fakeProfile("p-work", "Work", "alice@company.test");
    const personal = await fakeProfile("p-personal", "Personal", "alice@gmail.test");
    await sleep(200);
    const c = await client();

    const listed = JSON.parse(firstText(await c.callTool({ name: "list_profiles", arguments: {} })));
    ok("list_profiles shows both profiles", listed.profiles.length === 2 && listed.session_profile === null, JSON.stringify(listed));

    const amb = await c.callTool({ name: "navigate", arguments: { url: "https://x.test" } });
    ok("two profiles + no choice -> refuses and lists them", amb.isError && /2 browser profiles are connected: .*Work.*Personal|Personal.*Work/.test(firstText(amb)), firstText(amb));
    ok("nothing was sent to either profile", work.seen.length === 0 && personal.seen.length === 0, JSON.stringify([work.seen, personal.seen]));

    const chose = firstText(await c.callTool({ name: "use_profile", arguments: { profile: "personal" } }));
    ok("use_profile matches by name (case-insensitive)", chose.includes("Personal (alice@gmail.test)"), chose);

    const nav = firstText(await c.callTool({ name: "navigate", arguments: { url: "https://x.test" } }));
    ok("commands go to the chosen profile only", nav === "Navigated in Personal" && work.seen.length === 0, `${nav} work=${JSON.stringify(work.seen)}`);

    const viaEmail = firstText(await c.callTool({ name: "use_profile", arguments: { profile: "alice@company.test" } }));
    const nav2 = firstText(await c.callTool({ name: "navigate", arguments: { url: "https://y.test" } }));
    ok("use_profile by email switches profile", viaEmail.includes("Work") && nav2 === "Navigated in Work", `${viaEmail} / ${nav2}`);

    const opened = firstText(await c.callTool({ name: "open_tab", arguments: {} }));
    ok("open_tab names the profile", opened.includes("profile: Work (alice@company.test)"), opened);

    const nope = firstText(await c.callTool({ name: "use_profile", arguments: { profile: "zzz" } }));
    ok("unknown profile -> lists what's connected", nope.startsWith("No connected browser profile matches 'zzz'"), nope);

    await c.close();
    work.ws.close();
    personal.ws.close();
  });

  // Parallel subagents in one session: each opens its tab in its own profile and
  // passes the tab id — commands follow the tab, no use_profile needed.
  await withServer({}, async () => {
    const work = await fakeProfile("p-work", "Work", "alice@company.test");
    const personal = await fakeProfile("p-personal", "Personal", "alice@gmail.test");
    await sleep(200);
    const c = await client();
    const tw = firstText(await c.callTool({ name: "open_tab", arguments: { profile: "Work" } }));
    const tp = firstText(await c.callTool({ name: "open_tab", arguments: { profile: "alice@gmail.test" } }));
    ok("open_tab(profile) opens in the named profile", tw.includes("profile: Work") && tp.includes("profile: Personal"), `${tw} / ${tp}`);
    const [rw, rp] = await Promise.all([
      c.callTool({ name: "navigate", arguments: { url: "https://w.test", tab: 70 } }),
      c.callTool({ name: "navigate", arguments: { url: "https://p.test", tab: 80 } }),
    ]);
    ok("commands follow each tab's profile, in parallel", firstText(rw) === "Navigated in Work" && firstText(rp) === "Navigated in Personal", `${firstText(rw)} / ${firstText(rp)}`);
    // Every tab-scoped tool follows the tab — close_tab included (it once didn't).
    const cl = await c.callTool({ name: "close_tab", arguments: { tab: 80 } });
    ok("close_tab follows the tab's profile (no use_profile)", !cl.isError && personal.seen.includes("close_tab") && !work.seen.includes("close_tab"), firstText(cl));
    await c.close();
    work.ws.close();
    personal.ws.close();
  });

  // OTTERBRIDGE_PROFILE pins every session of the server to one profile.
  await withServer({ OTTERBRIDGE_PROFILE: "Work" }, async () => {
    const work = await fakeProfile("p-work", "Work", "alice@company.test");
    const personal = await fakeProfile("p-personal", "Personal", "alice@gmail.test");
    await sleep(200);
    const c = await client();
    const nav = firstText(await c.callTool({ name: "navigate", arguments: { url: "https://z.test" } }));
    ok("OTTERBRIDGE_PROFILE pins the session", nav === "Navigated in Work" && personal.seen.length === 0, nav);
    await c.close();
    work.ws.close();
    personal.ws.close();
  });

  // Seamless changes: profiles coming and going are told to the session, and
  // a session's group number is the same in every profile but unique per session.
  await withServer({ OTTERBRIDGE_STARTUP_GRACE_MS: "0", OTTERBRIDGE_DISCONNECT_GRACE_MS: "300" }, async () => {
    const work = await fakeProfile("p-work", "Work", "alice@company.test");
    await sleep(200);
    const a = await client();
    const b = await client();
    await a.callTool({ name: "open_tab", arguments: {} }); // only Work connected: auto-chosen
    await b.callTool({ name: "open_tab", arguments: {} });
    const [na, nb] = work.sessionNos;
    ok("each session gets its own group number", Number.isInteger(na) && Number.isInteger(nb) && na !== nb, JSON.stringify(work.sessionNos));

    const personal = await fakeProfile("p-personal", "Personal", "alice@gmail.test");
    await sleep(200);
    const told = await a.callTool({ name: "list_profiles", arguments: {} });
    const notes = told.content.map((c) => c.text).join("\n");
    ok("a profile connecting later is told to the session", notes.includes("→ Browser profile connected: Personal (alice@gmail.test)"), notes.slice(-300));

    await a.callTool({ name: "use_profile", arguments: { profile: "Personal" } });
    await a.callTool({ name: "open_tab", arguments: {} });
    ok("same session keeps its number in another profile", personal.sessionNos[0] === na, `${personal.sessionNos[0]} vs ${na}`);

    personal.ws.close();
    await sleep(600);
    const after = await b.callTool({ name: "list_profiles", arguments: {} });
    const notes2 = after.content.map((c) => c.text).join("\n");
    ok("a profile closing is told to the session", notes2.includes("→ Browser profile disconnected: Personal"), notes2.slice(-300));

    await a.close();
    await b.close();
    work.ws.close();
  });

  console.log(`\n[test] ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error("harness error:", e); process.exit(2); });
