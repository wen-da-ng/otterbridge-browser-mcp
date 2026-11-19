// Web-app measuring tools: the extension hands back raw timings, the server
// turns them into reports and findings. A fake extension supplies canned raw
// data for a slow page and a clean one.
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { useTempHome, connectFakeExtension, httpTransport } from "./_ext.mjs";

useTempHome();
process.env.OTTERBRIDGE_WS_PORT ??= "18765";
const WS_PORT = Number(process.env.OTTERBRIDGE_WS_PORT);

let pass = 0, fail = 0;
const ok = (n, c, e = "") => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n} ${e}`); } };
const firstText = (r) => r.content.find((c) => c.type === "text")?.text ?? "";

const req = (o) => ({ method: "GET", status: 200, protocol: "h2", enc: "br", cache: "max-age=31536000", transfer: 2000, decoded: 6000, ms: 50, waitMs: 20, ...o });

const SLOW = {
  url: "https://app.example.com/dash?token=SECRET123", cold: true, throttle: { network: "none", cpu: 1 },
  page: {
    visibility: "visible", ttfb: 1200, fcp: 2100, dom_content_loaded: 2600, load: 5200,
    lcp: { time: 4800, size: 90000, element: "img#hero", url: "https://cdn.example.com/hero.png?sig=abc" },
    cls: 0.31, tbt: 720,
    long_frames: [{ start: 2500, duration: 340, blocking: 280, scripts: [{ url: "https://app.example.com/main.js?v=9", fn: "renderGrid", invoker: "", duration: 300 }] }],
    render_blocking: ["https://app.example.com/styles.css?v=9"],
    dom: { nodes: 3400, maxDepth: 31 },
  },
  metrics: { ScriptDuration: 1.9, LayoutDuration: 0.4, RecalcStyleDuration: 0.2, JSHeapUsedSize: 41000000, Nodes: 3400 },
  requests: [
    req({ url: "https://app.example.com/dash?token=SECRET123", type: "Document", protocol: "http/1.1" }),
    req({ url: "https://app.example.com/main.js?v=9", type: "Script", transfer: 450000, decoded: 1400000, ms: 900 }),
    req({ url: "https://app.example.com/data.json", type: "Fetch", mimeType: "application/json", enc: "", decoded: 80000, transfer: 80000 }),
    req({ url: "https://cdn.example.com/hero.png?sig=abc", type: "Image", transfer: 2600000, decoded: 2600000, cache: "" }),
    req({ url: "https://tracker.adsnet.io/t.js", type: "Script", transfer: 30000 }),
    req({ url: "https://app.example.com/api/user", type: "XHR", status: 500 }),
    req({ url: "https://app.example.com/data.json", type: "Fetch", mimeType: "application/json", enc: "", decoded: 80000, transfer: 80000 }),
  ],
  consoleErrors: { count: 2, first: ["TypeError: x is undefined"] },
  unavailable: ["cpu metrics: test says so"],
};

const CLEAN = {
  url: "https://fast.example.com/", cold: true, throttle: { network: "none", cpu: 1 },
  page: { visibility: "visible", ttfb: 120, fcp: 400, dom_content_loaded: 450, load: 600, lcp: { time: 700, size: 1000, element: "h1", url: "" }, cls: 0.01, tbt: 20, long_frames: [], render_blocking: [], dom: { nodes: 300, maxDepth: 12 } },
  metrics: {},
  requests: [req({ url: "https://fast.example.com/", type: "Document" }), req({ url: "https://fast.example.com/app.js", type: "Script" })],
  consoleErrors: { count: 0, first: [] },
  unavailable: [],
};

let auditRaw = SLOW;
const seen = [];
const ext = (action, p) => {
  seen.push({ action, p });
  if (action === "open_tab") return { tabId: 3, url: "about:blank", windowId: 1, label: "Otter · perf 1" };
  if (action === "perf_audit") return auditRaw;
  if (action === "throttle") return p.reset ? { network: "none", cpu: 1 } : { network: p.network ?? "none", cpu: p.cpu ?? 1 };
  if (action === "perf_record") {
    return p.action === "start" ? { started: true } : {
      durationMs: 3000, page: { slowest_interactions: [{ type: "click", duration: 280, target: "button#save" }], long_frames: [], blocking_ms: 230, cls: 0, dom: { nodes: 900 } },
      before: { ScriptDuration: 1, JSHeapUsedSize: 10e6, Nodes: 800 }, after: { ScriptDuration: 1.25, JSHeapUsedSize: 12e6, Nodes: 900 },
      requests: [req({ url: "https://app.example.com/api/save?x=1", type: "Fetch", ms: 400 })],
    };
  }
  if (action === "css_coverage") {
    return p.action === "start" ? { started: true } : {
      sheets: [
        { url: "https://app.example.com/big.css?v=1", length: 100000, inline: false, used: 20000 },
        { url: "", length: 2000, inline: true, used: 2000 },
        { url: "", length: 1000, inline: true, used: 0 },
      ],
    };
  }
  if (action === "save_pdf") throw new Error("Unknown action: save_pdf"); // an extension too old for a tool
  return "ok";
};

async function main() {
  const proc = spawn("node", ["dist/index.js"], { cwd: process.cwd(), stdio: ["ignore", "ignore", "ignore"] });
  try {
    await sleep(1200);
    await connectFakeExtension(WS_PORT, { onCommand: ext });
    const c = new Client({ name: "perf-test", version: "1.0.0" });
    await c.connect(await httpTransport());
    const call = async (name, args = {}) => c.callTool({ name, arguments: args });

    // --- perf_audit: slow page ---
    const slow = JSON.parse(firstText(await call("perf_audit", { network: "fast-3g", cpu: 4 })));
    const sent = seen.find((s) => s.action === "perf_audit").p;
    ok("perf_audit passes run throttling to the extension", sent.network === "fast-3g" && sent.cpu === 4, JSON.stringify(sent));
    const whats = slow.findings.map((f) => f.what);
    const sev = slow.findings.map((f) => f.severity);
    ok("findings are ordered high -> medium -> low", sev.join(",") === [...sev].sort((a, b) => ({ high: 0, medium: 1, low: 2 })[a] - ({ high: 0, medium: 1, low: 2 })[b]).join(","), sev.join(","));
    for (const w of ["Slow Largest Contentful Paint", "Layout shifts", "Main thread blocked", "Slow server response",
      "Render-blocking resources", "Text responses sent without compression", "Large images", "Large JavaScript files",
      "Failed requests", "Very large DOM", "Long frame from a script", "Same URL requested more than once",
      "Static files without long-term caching", "Page served over HTTP/1.1", "Heavy page"]) {
      ok(`slow page -> finding "${w}"`, whats.includes(w), JSON.stringify(whats));
    }
    ok("LCP / CLS / TBT high on the slow page", ["Slow Largest Contentful Paint", "Layout shifts", "Main thread blocked"].every((w) => slow.findings.find((f) => f.what === w)?.severity === "high"));
    ok("capped at 15 findings, dropping the lowest first", slow.findings.length === 15 && !whats.includes("Console errors during load"), String(slow.findings.length));
    ok("console errors still reported in their own section", slow.console_errors.count === 2);
    const all = JSON.stringify(slow);
    ok("report URLs have no query strings (tokens stay out)", !all.includes("SECRET123") && !all.includes("sig=abc") && !all.includes("?v=9"), all.match(/\?[^"]*/g)?.slice(0, 3).join(" "));
    ok("long frame names the script and function", slow.long_frames[0].scripts[0].url === "https://app.example.com/main.js" && whats.length && slow.findings.some((f) => f.evidence.includes("renderGrid()")));
    ok("third-party hosts are listed", slow.network.third_party.some((t) => t.host === "tracker.adsnet.io"), JSON.stringify(slow.network.third_party));
    ok("same-site CDN isn't third-party", !slow.network.third_party.some((t) => t.host === "cdn.example.com"));
    ok("unavailable data is passed through", slow.unavailable.includes("cpu metrics: test says so"));
    ok("main-thread metrics converted to ms", slow.page.script_ms === 1900, JSON.stringify(slow.page));

    // --- perf_audit: clean page, hidden tab ---
    auditRaw = CLEAN;
    const clean = JSON.parse(firstText(await call("perf_audit", {})));
    ok("clean page -> no findings", clean.findings.length === 0, JSON.stringify(clean.findings));
    ok("clean page -> no warnings", clean.warnings.length === 0, JSON.stringify(clean.warnings));
    auditRaw = { ...CLEAN, page: { ...CLEAN.page, visibility: "hidden", fcp: null } };
    const hidden = JSON.parse(firstText(await call("perf_audit", {})));
    ok("hidden tab -> warning about paint metrics", hidden.warnings.some((w) => w.includes("hidden")), JSON.stringify(hidden.warnings));

    // --- throttle ---
    const before = seen.length;
    const noArgs = firstText(await call("throttle", {}));
    ok("throttle without arguments -> usage, nothing sent", noArgs.startsWith("Provide network") && seen.length === before, noArgs);
    const on = firstText(await call("throttle", { network: "slow-3g", cpu: 4 }));
    ok("throttle on says it stays on and how to undo", on.includes("slow-3g") && on.includes("4×") && on.includes("reset=true"), on);
    const off = firstText(await call("throttle", { reset: true }));
    ok("throttle reset -> off", off === "Throttling is off for this tab.", off);

    // --- perf_record ---
    const started = firstText(await call("perf_record", { action: "start" }));
    ok("perf_record start explains the next step", started.includes("action='stop'"), started);
    const recd = JSON.parse(firstText(await call("perf_record", { action: "stop" })));
    ok("perf_record reports slowest interactions", recd.slowest_interactions[0]?.target === "button#save");
    ok("perf_record reports heap / DOM / script deltas", recd.deltas.js_heap_bytes === 2000000 && recd.deltas.dom_nodes === 100 && recd.deltas.script_ms === 250, JSON.stringify(recd.deltas));
    ok("perf_record request URLs have no query", recd.requests.slowest[0]?.url === "https://app.example.com/api/save", JSON.stringify(recd.requests));

    // --- css_coverage ---
    await call("css_coverage", { action: "start" });
    const css = JSON.parse(firstText(await call("css_coverage", { action: "stop" })));
    ok("css_coverage totals", css.total_bytes === 103000 && css.unused_bytes === 81000, JSON.stringify(css));
    ok("css_coverage: biggest waste first, inline styles merged, no query", css.sheets[0].url === "https://app.example.com/big.css" && css.sheets[0].unused_pct === 80 && css.sheets.filter((s) => s.url === "(inline styles)").length === 1, JSON.stringify(css.sheets));
    ok("css_coverage says it's CSS only", css.note.includes("CSS only"));

    // --- an extension too old for a tool ---
    const old = await call("save_pdf", {});
    ok("'Unknown action' -> tells the user to update the extension", old.isError && firstText(old).includes("older than this server"), firstText(old));

    await c.close();
    console.log(`\n[test] ${pass} passed, ${fail} failed`);
  } finally {
    proc.kill();
  }
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error("harness error:", e); process.exit(2); });
