// ===== Flow recorder: capturing what the user does in their own tab =====
// Registered by background.js only while a recording is running (in every
// tab and frame, so navigations and late iframes are covered), and injected
// into the recorded tab's existing frames when it starts. Inert unless the
// background confirms THIS tab is the one being recorded.
//
// Needs page.js (loaded just before it) for durable targets. Sends one
// message per user action: clicks, final field values, dropdown choices,
// Enter / Escape / Tab, form submits. Never per keystroke, and never the
// value of a password or other sensitive field — those are recorded as
// "sensitive" with no value, and the value never leaves the page.
(() => {
  // A page keeps an earlier copy across an extension reload: replace it when
  // this one is newer (the old copy is orphaned and goes quiet by itself).
  const REC_VERSION = 2;
  if (window.__otterRec && window.__otterRec.v === REC_VERSION) {
    window.__otterRec.check(); // injected again for a new recording
    return;
  }
  if (window.__otterRec && window.__otterRec.retire) window.__otterRec.retire();
  let active = false;
  let retired = false;

  const sendRaw = (msg) => {
    try {
      const p = chrome.runtime.sendMessage(msg);
      if (p && p.catch) p.catch(() => {});
    } catch (_) {
      active = false; // the extension was reloaded: this copy is orphaned
    }
  };
  const send = (m) =>
    sendRaw({ type: "rec:event", ...m, frameUrl: location.href, top: window === window.top, ts: Date.now() });

  function check() {
    try {
      chrome.runtime.sendMessage({ type: "rec:hello" }).then(
        (r) => { active = !!(r && r.recording); },
        () => { active = false; },
      );
    } catch (_) {
      active = false;
    }
  }
  chrome.runtime.onMessage.addListener((msg) => {
    // Stopping: send what's still being typed, then go quiet.
    if (msg && msg.type === "rec:off") { flushAll(); active = false; }
  });

  // ---- what kind of element ----
  const lib = () => window.__otter;
  const SENSITIVE_AC = new Set([
    "current-password", "new-password", "one-time-code",
    "cc-number", "cc-csc", "cc-exp", "cc-exp-month", "cc-exp-year",
  ]);
  const SENSITIVE_NAME = /pass|pwd|otp|one.?time|cvv|cvc|card.?num|security.?code|ssn/i;
  function isSensitive(el) {
    if (el.tagName === "INPUT" && (el.type || "").toLowerCase() === "password") return true;
    const ac = String(el.getAttribute("autocomplete") || "").toLowerCase().split(/\s+/);
    if (ac.some((t) => SENSITIVE_AC.has(t))) return true;
    return ["name", "id", "aria-label"].some((a) => SENSITIVE_NAME.test(el.getAttribute(a) || ""));
  }

  // The text field (or contenteditable host) an event happened in.
  function fieldOf(node) {
    for (let n = node; n && n.nodeType === 1; n = n.parentElement || (n.getRootNode && n.getRootNode().host) || null) {
      if (lib() && lib().isTextField(n)) {
        // contenteditable: the outermost editable element is the field
        if (n.isContentEditable && n.tagName !== "INPUT" && n.tagName !== "TEXTAREA") {
          let top = n;
          while (top.parentElement && top.parentElement.isContentEditable) top = top.parentElement;
          return top;
        }
        return n;
      }
    }
    return null;
  }
  const valueOf = (el) => (el.tagName === "INPUT" || el.tagName === "TEXTAREA" ? el.value : el.innerText) || "";
  const origin = (e) => (e.composedPath && e.composedPath()[0]) || e.target;

  function targetOf(el) {
    try {
      return lib() ? lib().durableTarget(el) : null;
    } catch (_) {
      return null;
    }
  }

  // ---- fills: one message per field value, not per keystroke ----
  const pending = new Map(); // field -> debounce timer
  const lastSent = new WeakMap(); // field -> value sent ("\u0000sensitive" for sensitive fields)

  function flushFill(el) {
    clearTimeout(pending.get(el));
    pending.delete(el);
    if (!active || !el.isConnected) return;
    const sensitive = isSensitive(el);
    const value = sensitive ? "\u0000sensitive" : valueOf(el).slice(0, 10000);
    if (lastSent.get(el) === value) return;
    const target = targetOf(el);
    if (!target) return;
    lastSent.set(el, value);
    if (sensitive) send({ kind: "fill", target, sensitive: true });
    else send({ kind: "fill", target, value });
  }
  function flushAll() {
    for (const el of [...pending.keys()]) flushFill(el);
  }

  // ---- listeners (capture phase, user input only) ----
  // Kept as stable functions so attaching them again is a no-op: a page that
  // rewrites a frame with document.open() (try-it editors, some widgets)
  // erases every listener on it, and attach() runs again when that happens.
  const handlers = {};
  const on = (type, fn) => {
    handlers[type] = (e) => {
      if (!active || retired || !e.isTrusted) return;
      try { fn(e); } catch (_) {}
    };
  };
  function attach() {
    if (retired) return;
    for (const [type, h] of Object.entries(handlers)) document.addEventListener(type, h, true);
  }

  // Enter in a form makes Chrome click its submit button (a trusted click
  // with detail 0): that's the Enter already recorded, not a second action.
  let lastEnterAt = 0;

  on("click", (e) => {
    flushAll();
    if (e.detail === 0 && Date.now() - lastEnterAt < 1000) return;
    let d = null;
    try { d = lib() ? lib().durable(origin(e)) : null; } catch (_) {}
    if (!d) return;
    // A dropdown is recorded by its choice (the change below); Chrome also
    // fires clicks on it while its list opens and closes.
    if (d.el.tagName === "SELECT") return;
    send({ kind: "click", target: d.target });
  });

  on("input", (e) => {
    const el = fieldOf(origin(e));
    if (!el) return;
    clearTimeout(pending.get(el));
    pending.set(el, setTimeout(() => flushFill(el), 400));
  });

  on("change", (e) => {
    const raw = origin(e);
    if (raw && raw.tagName === "SELECT") {
      flushAll();
      const target = targetOf(raw);
      if (!target) return;
      if (isSensitive(raw)) send({ kind: "select", target, sensitive: true });
      else {
        const opt = raw.selectedOptions && raw.selectedOptions[0];
        send({ kind: "select", target, value: opt ? opt.text.trim().slice(0, 200) : "" });
      }
      return;
    }
    const el = fieldOf(raw);
    if (el) flushFill(el);
  });

  on("focusout", (e) => {
    const el = fieldOf(origin(e));
    if (el && pending.has(el)) flushFill(el);
  });

  on("keydown", (e) => {
    if (e.isComposing || !/^(Enter|Escape|Tab)$/.test(e.key)) return;
    if (e.key === "Enter" && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) return; // newline
    flushAll(); // the field's value comes first
    const mods = [e.ctrlKey && "Control", e.altKey && "Alt", e.shiftKey && "Shift", e.metaKey && "Meta"].filter(Boolean);
    if (e.key === "Enter") lastEnterAt = Date.now();
    send({ kind: "key", key: [...mods, e.key].join("+") });
  });

  on("submit", () => {
    flushAll();
    send({ kind: "submit" });
  });

  window.addEventListener("pagehide", () => { if (active && !retired) flushAll(); }, true);

  attach();
  // document.open() swaps the document's contents (and drops listeners):
  // seen as its root element changing.
  let root = document.documentElement;
  const mo = new MutationObserver(() => {
    if (document.documentElement !== root) {
      root = document.documentElement;
      attach();
    }
  });
  mo.observe(document, { childList: true });

  window.__otterRec = {
    v: REC_VERSION,
    check,
    retire: () => { retired = true; active = false; mo.disconnect(); },
  };
  check();
})();
