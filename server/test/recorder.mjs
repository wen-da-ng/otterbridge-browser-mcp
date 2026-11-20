// Flow recorder: recorded events -> run_script steps (extension/recorder-core.js,
// pure logic shared by the extension's background worker and these tests).
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const require = createRequire(import.meta.url);
// A classic script: its IIFE attaches OtterRecorder to `this` (module.exports).
const { OtterRecorder: R } = require(join(process.cwd(), "..", "extension", "recorder-core.js"));

let pass = 0, fail = 0;
const ok = (n, c, e = "") => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n} ${e}`); } };
const J = JSON.stringify;

const START = "https://shop.example.com/menu";
const email = { selector: 'input[name="email"]', label: "Email" };
const pw = { selector: 'input[name="password"]', label: "Password" };
const size = { selector: 'select[name="size"]', label: "Size" };
const buy = { text: "Order now", tag: "button", label: "Order now" };
const top = (o) => ({ top: true, frameUrl: START, ...o });

// --- the basics ---
{
  const { steps, vars, warnings } = R.toSteps([], START);
  ok("an empty recording is just the opening navigate", J(steps) === J([{ action: "navigate", url: START }]) && J(vars) === "{}" && warnings.length === 0, J(steps));
}

// --- coalescing fills, dropping the click that focused the field ---
{
  const { steps, vars } = R.toSteps([
    top({ kind: "click", target: email }),
    top({ kind: "fill", target: email, value: "me@ex" }),
    top({ kind: "fill", target: email, value: "me@example.com" }),
  ], START);
  ok("click before a fill of the same field is dropped", !steps.some((s) => s.action === "click"), J(steps));
  ok("repeated fills of one field keep only the last", steps.filter((s) => s.action === "fill").length === 1, J(steps));
  ok("the fill becomes a variable named after the label", steps[1].text === "{{email}}" && vars.email === "me@example.com", J({ steps, vars }));
  ok("the step keeps no typed value", !J(steps).includes("me@example.com"), J(steps));
}
{
  // Fills of different fields in between stay separate.
  const { steps } = R.toSteps([
    top({ kind: "fill", target: email, value: "a" }),
    top({ kind: "click", target: buy }),
    top({ kind: "fill", target: email, value: "b" }),
  ], START);
  ok("fills separated by another step are not merged", steps.filter((s) => s.action === "fill").length === 2, J(steps));
}
{
  // A click on a field that isn't followed by its fill stays.
  const { steps } = R.toSteps([top({ kind: "click", target: email }), top({ kind: "click", target: buy })], START);
  ok("a click not followed by its fill is kept", steps.filter((s) => s.action === "click").length === 2, J(steps));
}

// --- select ---
{
  const { steps, vars } = R.toSteps([
    top({ kind: "click", target: size }),
    top({ kind: "select", target: size, value: "Large" }),
  ], START);
  ok("click on a <select> followed by its choice is dropped", steps.length === 2 && steps[1].action === "select", J(steps));
  ok("select step carries the option label, no variable", steps[1].label === "Large" && J(vars) === "{}", J({ steps, vars }));
}

// --- keys, submit ---
{
  const { steps } = R.toSteps([
    top({ kind: "fill", target: email, value: "x@y.z" }),
    top({ kind: "key", key: "Enter" }),
    top({ kind: "submit" }),
    top({ kind: "key", key: "Shift+Tab" }),
    top({ kind: "key", key: "Escape" }),
    top({ kind: "key", key: "a" }),
  ], START);
  ok("Enter after a fill -> press_key Enter right after it", steps[1].action === "fill" && steps[2].action === "press_key" && steps[2].key === "Enter", J(steps));
  ok("submit events add no step", !steps.some((s) => s.action === "submit") && steps.length === 5, J(steps));
  ok("Tab / Escape (with modifiers) become press_key; other keys are ignored", steps[3].key === "Shift+Tab" && steps[4].key === "Escape", J(steps));
}

// --- navigation ---
{
  const { steps } = R.toSteps([
    { kind: "navigate", url: START }, // already there
    top({ kind: "click", target: buy }),
    { kind: "navigate", url: "https://shop.example.com/cart" },
    { kind: "navigate", url: "https://shop.example.com/cart" }, // reload
    top({ kind: "click", target: buy, frameUrl: "https://shop.example.com/cart" }),
    { kind: "navigate", url: START },
  ], START);
  const navs = steps.filter((s) => s.action === "navigate").map((s) => s.url);
  ok("navigate to the current URL is deduped", J(navs) === J([START, "https://shop.example.com/cart", START]), J(navs));
}
{
  // An iframe's events don't move the top page's URL.
  const { steps } = R.toSteps([
    { kind: "click", target: buy, top: false, frameUrl: "https://pay.example.net/frame" },
    { kind: "navigate", url: "https://pay.example.net/frame" },
  ], START);
  ok("iframe URLs aren't mistaken for the tab's URL", steps.filter((s) => s.action === "navigate").length === 2, J(steps));
}

// --- variables ---
{
  const first = { selector: "#a", label: "First name" };
  const first2 = { selector: "#b", label: "First  name!" };
  const blank = { selector: "#c", label: "" };
  const blank2 = { selector: "#d" };
  const long = { selector: "#e", label: "A very long label that goes on and on and on forever" };
  const { steps, vars } = R.toSteps([
    top({ kind: "fill", target: first, value: "Ann" }),
    top({ kind: "fill", target: first2, value: "Bo" }),
    top({ kind: "fill", target: blank, value: "1" }),
    top({ kind: "fill", target: blank2, value: "2" }),
    top({ kind: "fill", target: long, value: "3" }),
  ], START);
  const names = steps.filter((s) => s.action === "fill").map((s) => s.text);
  ok("slugs: lowercase, _ for the rest, _2 for repeats, 'field' when empty", J(names) === J(["{{first_name}}", "{{first_name_2}}", "{{field}}", "{{field_2}}", "{{a_very_long_label_that_goes_on}}"]), J(names));
  ok("slugs are at most 30 characters", Object.keys(vars).every((k) => k.replace(/_\d+$/, "").length <= 30), J(Object.keys(vars)));
  ok("each variable keeps its recorded value", vars.first_name === "Ann" && vars.first_name_2 === "Bo" && vars.field === "1" && vars.field_2 === "2", J(vars));
  ok("slug() directly", R.slug("E-mail address", new Set()) === "e_mail_address" && R.slug("你好", new Set()) === "field" && R.slug("  ", null) === "field");
}

// --- sensitive fields ---
{
  const { steps, vars } = R.toSteps([
    top({ kind: "fill", target: email, value: "me@example.com" }),
    top({ kind: "fill", target: pw, sensitive: true }),
    top({ kind: "fill", target: pw, sensitive: true, value: "should-never-be-here" }),
    top({ kind: "key", key: "Enter" }),
  ], START);
  const s = steps.find((x) => x.target && x.target.selector === pw.selector);
  ok("a sensitive fill is a step with sensitive: true", s && s.sensitive === true && s.action === "fill", J(steps));
  ok("...with no text and no variable", s && !("text" in s) && Object.keys(vars).length === 1, J({ s, vars }));
  ok("...and no value anywhere in the output", !J({ steps, vars }).includes("should-never-be-here"));
}

// --- labels ---
{
  const { steps } = R.toSteps([top({ kind: "click", target: buy }), top({ kind: "click", target: { selector: "#x", label: "Menu" } })], START);
  ok("label dropped when it repeats the text", !("label" in steps[1].target), J(steps[1]));
  ok("label kept when it adds something", steps[2].target.label === "Menu", J(steps[2]));
}

// --- the 300-step cap ---
{
  const many = Array.from({ length: 400 }, (_, i) => top({ kind: "click", target: { selector: `#b${i}` } }));
  const { steps, warnings } = R.toSteps(many, START);
  ok("capped at 300 steps", steps.length === 300, String(steps.length));
  ok("...with a warning", warnings.length === 1 && /300/.test(warnings[0]), J(warnings));
}

// --- validateFlow ---
{
  const good = { name: "Order lunch", steps: [{ action: "navigate", url: START }], vars: { email: "x", other: null } };
  ok("validateFlow accepts a good flow", R.validateFlow(good) === null, R.validateFlow(good));
  const bad = [
    [{ ...good, name: "" }, "empty name"],
    [{ ...good, name: "x".repeat(61) }, "name over 60"],
    [{ ...good, name: 5 }, "name not a string"],
    [{ ...good, steps: [] }, "no steps"],
    [{ ...good, steps: Array(301).fill({ action: "click" }) }, "301 steps"],
    [{ ...good, steps: [{}] }, "step without action"],
    [{ ...good, vars: [] }, "vars an array"],
    [{ ...good, vars: { a: 1 } }, "var not a string"],
    [null, "not an object"],
  ];
  for (const [f, why] of bad) ok(`validateFlow rejects: ${why}`, typeof R.validateFlow(f) === "string");
}

// --- recorder.js: a sensitive field's message never carries its value ---
{
  const src = readFileSync(join(process.cwd(), "..", "extension", "recorder.js"), "utf-8");
  const sends = [...src.matchAll(/send\(\{[^}]*sensitive: true[^}]*\}\)/g)].map((m) => m[0]);
  ok("recorder.js sends sensitive fills / selects without a value", sends.length === 2 && sends.every((s) => !/value/.test(s)), J(sends));
}

console.log(`\n[test] ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
