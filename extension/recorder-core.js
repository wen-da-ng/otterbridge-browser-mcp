// ===== Flow recorder: turning recorded events into run_script steps =====
// Pure logic, no Chrome APIs: background.js loads it with importScripts and
// the Node tests require() it (its IIFE attaches OtterRecorder to `this`, like
// config.js).
//
// Events come from recorder.js (via background.js), in order:
//   { kind: "click", target }
//   { kind: "fill", target, value?, sensitive? }   sensitive: no value, ever
//   { kind: "select", target, value?, sensitive? } value: the option's label
//   { kind: "key", key }                           Enter / Escape / Tab (+ modifiers)
//   { kind: "submit" }
//   { kind: "navigate", url }                      background: a navigation no action caused
// plus frameUrl / top / ts. Targets are durable: { selector?, text?, tag?, nth?, label }.
(function (root) {
  const MAX_STEPS = 300;
  const MAX_FLOWS = 200;
  const KEYS = /^(?:(?:Control|Alt|Shift|Meta)\+)*(?:Enter|Escape|Tab)$/;

  // Two targets are the same element when they resolve the same way (the
  // label is only a description).
  const targetKey = (t) =>
    t ? JSON.stringify([t.selector ?? null, t.text ?? null, t.tag ?? null, t.nth ?? 0]) : "";

  // Variable name for a field: its label lowercased, non-alphanumerics -> "_",
  // trimmed, max 30 chars; "field" when nothing is left; _2, _3 for repeats.
  function slug(label, taken) {
    let base = String(label || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 30)
      .replace(/_+$/, "");
    if (!base) base = "field";
    let name = base;
    for (let n = 2; taken && taken.has(name); n++) name = `${base}_${n}`;
    if (taken) taken.add(name);
    return name;
  }

  // The target as a step carries it: the label only when it says something
  // the resolving fields don't.
  function cleanTarget(t) {
    const out = {};
    if (t.selector) out.selector = t.selector;
    if (t.text != null && t.text !== "") out.text = t.text;
    if (t.tag) out.tag = t.tag;
    if (t.nth) out.nth = t.nth;
    if (t.label && t.label !== t.text) out.label = t.label;
    return out;
  }

  function toSteps(events, startUrl) {
    const warnings = [];
    // Steps under construction; fills keep their raw value until the end, so
    // only the fills that survive coalescing get a variable.
    const raw = [{ action: "navigate", url: startUrl }];
    let currentUrl = startUrl;
    const last = () => raw[raw.length - 1];
    const sameTarget = (st, t) => st && st.target && targetKey(st.target) === targetKey(t);

    for (const e of events || []) {
      if (!e || typeof e !== "object") continue;
      if (e.top && typeof e.frameUrl === "string" && e.kind !== "navigate") currentUrl = e.frameUrl;
      switch (e.kind) {
        case "navigate": {
          if (typeof e.url !== "string" || !e.url || e.url === currentUrl) break;
          raw.push({ action: "navigate", url: e.url });
          currentUrl = e.url;
          break;
        }
        case "click": {
          if (!e.target) break;
          raw.push({ action: "click", target: e.target });
          break;
        }
        case "fill":
        case "select": {
          if (!e.target) break;
          const action = e.kind;
          // A click that only focused this field / opened this dropdown: the
          // fill or select does that itself.
          if (last().action === "click" && sameTarget(last(), e.target)) raw.pop();
          // Typing in bursts: keep only the final value.
          if (last().action === action && sameTarget(last(), e.target)) raw.pop();
          const st = { action, target: e.target };
          if (e.sensitive) st.sensitive = true;
          else st._value = typeof e.value === "string" ? e.value : "";
          raw.push(st);
          break;
        }
        case "key": {
          if (typeof e.key !== "string" || !KEYS.test(e.key)) break;
          raw.push({ action: "press_key", key: e.key });
          break;
        }
        // submit: the click or Enter that caused it is already a step; a form
        // submitted by the page's own script isn't something to replay.
        default:
          break;
      }
    }

    let steps = raw;
    if (steps.length > MAX_STEPS) {
      warnings.push(
        `The recording had ${steps.length} steps; only the first ${MAX_STEPS} were kept.`,
      );
      steps = steps.slice(0, MAX_STEPS);
    }

    const taken = new Set();
    const vars = {};
    const out = steps.map((st) => {
      if (st.action === "navigate" || st.action === "press_key") return st;
      const step = { action: st.action, target: cleanTarget(st.target) };
      if (st.sensitive) {
        step.sensitive = true;
      } else if (st.action === "fill") {
        const name = slug(st.target.label, taken);
        vars[name] = st._value;
        step.text = `{{${name}}}`;
      } else if (st.action === "select") {
        step.label = st._value;
      }
      return step;
    });
    return { steps: out, vars, warnings };
  }

  // Shape checks for a flow about to be saved. Returns an error message, or
  // null when it's fine. (The server validates each step with its schema.)
  function validateFlow(flow) {
    if (!flow || typeof flow !== "object" || Array.isArray(flow)) return "A flow must be an object.";
    const name = flow.name;
    if (typeof name !== "string" || !name.trim()) return "A flow needs a name.";
    if (name.length > 60) return "A flow name can be at most 60 characters.";
    if (!Array.isArray(flow.steps) || flow.steps.length === 0) return "A flow needs at least one step.";
    if (flow.steps.length > MAX_STEPS) return `A flow can have at most ${MAX_STEPS} steps.`;
    for (const [i, st] of flow.steps.entries()) {
      if (!st || typeof st !== "object" || typeof st.action !== "string") return `Step ${i} has no action.`;
    }
    if (flow.vars != null) {
      if (typeof flow.vars !== "object" || Array.isArray(flow.vars)) return "vars must be an object.";
      for (const [k, v] of Object.entries(flow.vars)) {
        if (v !== null && typeof v !== "string") return `Variable '${k}' must be a string or null.`;
      }
    }
    return null;
  }

  root.OtterRecorder = { toSteps, slug, validateFlow, targetKey, MAX_STEPS, MAX_FLOWS };
})(typeof self !== "undefined" ? self : this);
