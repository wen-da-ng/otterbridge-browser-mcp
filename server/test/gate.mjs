// The extension's second-line gate check (extension/config.js) and the
// server's DANGER_RE must agree, and refuseUngated must refuse exactly the
// actions the server would have asked the user about.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const require = createRequire(import.meta.url);
// config.js is a classic script: its IIFE attaches OtterConfig to `this`,
// which under CommonJS is module.exports.
const { OtterConfig: C } = require(join(process.cwd(), "..", "extension", "config.js"));

let pass = 0, fail = 0;
const ok = (n, c, e = "") => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n} ${e}`); } };

const src = readFileSync(join(process.cwd(), "src", "index.ts"), "utf-8");
const m = /const DANGER_RE =\s*\/(.+)\/(\w*);/.exec(src);
ok("found DANGER_RE in the server source", !!m);
ok("extension DANGER_SOURCE equals the server's DANGER_RE", m && m[1] === C.DANGER_SOURCE && m[2] === "i", m ? `${m[1]} vs ${C.DANGER_SOURCE}` : "");

const r = (o) => C.refuseUngated({ approvalMode: "ask", ...o });
ok("ungated click on 'Delete' -> refused", r({ kind: "click", text: "Delete" }) === true);
ok("ungated click on 'Home' -> allowed", r({ kind: "click", text: "Home" }) === false);
ok("gated click on 'Delete' -> allowed", r({ kind: "click", text: "Delete", gated: true }) === false);
ok("Full Auto: ungated click on 'Delete' -> allowed", r({ kind: "click", text: "Delete", approvalMode: "auto" }) === false);
ok("ungated OK on 'Delete 3 files?' confirm -> refused", r({ kind: "dialog", text: "Delete 3 files?" }) === true);
ok("ungated OK on a harmless confirm -> allowed", r({ kind: "dialog", text: "Continue?" }) === false);
ok("ungated OK on an unread dialog -> refused", r({ kind: "dialog_unread" }) === true);
ok("gated OK on an unread dialog -> allowed", r({ kind: "dialog_unread", gated: true }) === false);
ok("ungated upload -> refused", r({ kind: "upload" }) === true);
ok("ungated evaluate_js -> refused", r({ kind: "eval" }) === true);
ok("gated upload / evaluate_js -> allowed", r({ kind: "upload", gated: true }) === false && r({ kind: "eval", gated: true }) === false);
ok("gated must be exactly true (not a truthy string)", r({ kind: "eval", gated: "yes" }) === true);

// Settings migration: auto-close became the default in settings v2.
ok("new install: auto-close agent windows is on", C.normalize(undefined).autoCloseWindows === true);
ok("settings saved before v2: auto-close switched on", C.normalize({ autoCloseWindows: false }).autoCloseWindows === true);
ok("switched off after v2: stays off", C.normalize({ autoCloseWindows: false, settingsVersion: 2 }).autoCloseWindows === false);

// page.js is one big closure: a second function with an existing name
// silently replaces the first (this once broke read_elements).
const pageJs = readFileSync(join(process.cwd(), "..", "extension", "page.js"), "utf-8");
const names = [...pageJs.matchAll(/^  (?:async )?function ([A-Za-z0-9_]+)|^  (?:const|let) ([A-Za-z0-9_]+)/gm)].map((x) => x[1] || x[2]);
const dupes = names.filter((n, i) => names.indexOf(n) !== i);
ok("page.js defines every top-level name once", names.length > 20 && dupes.length === 0, dupes.join(", ") || `${names.length} names`);

console.log(`\n[test] ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
