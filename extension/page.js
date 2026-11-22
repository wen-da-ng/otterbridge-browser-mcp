// ===== OtterBridge in-page library =====
// Injected on demand by background.js (chrome.scripting, isolated world) into
// EVERY frame of an agent tab, right before any DOM operation. It is the one
// place that knows how to look at a page, so read_elements, clicks, find_text,
// wait_for, run_script targets and page_snapshot all see the same thing:
//
//  - Shadow DOM: walks open AND closed shadow roots (chrome.dom), so web
//    components (YouTube, Salesforce, Shoelace...) aren't invisible.
//  - Iframes: each frame reports its own elements in frame-local coordinates;
//    background.js adds the frame's offset in the top viewport, learned via
//    the postMessage relay below (cross-origin frames can't measure themselves).
//  - Element cache: the last collect() is kept as live element references, so
//    acting on index N touches the element the model actually saw instead of
//    re-scanning the page several times per click.
//  - Password values are never reported.
//
// Re-injection is cheap: a frame that already has this version returns early.
(() => {
  const VERSION = 10;
  if (window.__otter && window.__otter.v === VERSION) return;

  // What counts as interactive without looking at styles. ARIA menu/option
  // roles cover web-app context menus and custom dropdowns, whose items are
  // often plain <li>/<div> with no pointer cursor.
  const SEMANTIC =
    "a, button, input, textarea, select, summary, [onclick], [contenteditable=''], " +
    "[contenteditable='true'], [role='button'], [role='link'], [role='checkbox'], " +
    "[role='radio'], [role='switch'], [role='tab'], [role='combobox'], [role='textbox'], " +
    "[role='menuitem'], [role='menuitemcheckbox'], [role='menuitemradio'], [role='option']";

  // ---- tree helpers (shadow-aware) ----
  function shadowRootOf(el) {
    if (el.shadowRoot) return el.shadowRoot;
    try {
      return (chrome.dom && chrome.dom.openOrClosedShadowRoot)
        ? chrome.dom.openOrClosedShadowRoot(el) : null;
    } catch (_) { return null; }
  }

  // Depth-first over every element in document order, descending into shadow
  // roots (before the host's light children, matching rendering order).
  function walk(root, cb) {
    for (let c = root.firstElementChild; c; c = c.nextElementSibling) {
      cb(c);
      const sr = shadowRootOf(c);
      if (sr) walk(sr, cb);
      walk(c, cb);
    }
  }

  function shadowRoots() {
    const roots = [];
    walk(document, (el) => { const sr = shadowRootOf(el); if (sr) roots.push(sr); });
    return roots;
  }

  function deepQueryAll(selector) {
    const out = [...document.querySelectorAll(selector)];
    for (const sr of shadowRoots()) out.push(...sr.querySelectorAll(selector));
    return out;
  }

  const parentAcross = (n) => n.parentElement || (n.getRootNode && n.getRootNode().host) || null;

  function containsDeep(a, b) {
    for (let n = b; n; n = parentAcross(n)) if (n === a) return true;
    return false;
  }

  function closestInteractive(el) {
    for (let n = el; n; n = parentAcross(n)) {
      try { if (n.matches && n.matches(SEMANTIC)) return n; } catch (_) {}
    }
    return null;
  }

  // The label the model sees AND the text the destructive-action gate checks —
  // one function, so they can never disagree.
  function labelOf(el) {
    const isPw = el.tagName === "INPUT" && (el.type || "").toLowerCase() === "password";
    const value = isPw ? "" : el.value;
    const own = String(
      el.innerText || (typeof value === "string" ? value : "") || el.placeholder ||
      el.getAttribute("aria-label") || el.title || el.getAttribute("alt") ||
      (isPw ? "password" : ""),
    ).trim();
    if (own) return own;
    // A control inside a web component often shows SLOTTED text, which lives
    // in the host's light DOM: fall back to the host's label.
    const root = el.getRootNode && el.getRootNode();
    return root && root.host ? labelOf(root.host) : "";
  }

  function deepElementFromPoint(x, y) {
    let el = document.elementFromPoint(x, y);
    while (el) {
      const sr = shadowRootOf(el);
      if (!sr || !sr.elementFromPoint) break;
      const inner = sr.elementFromPoint(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }
    return el;
  }

  const inViewport = (r) =>
    r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;

  const ROLE_BY_TAG = { A: "link", BUTTON: "button", SELECT: "combobox", TEXTAREA: "textbox", SUMMARY: "button" };
  function roleOf(el) {
    const r = el.getAttribute("role");
    if (r) return r;
    if (el.tagName === "INPUT") {
      const t = (el.type || "text").toLowerCase();
      if (t === "checkbox" || t === "radio") return t;
      if (t === "submit" || t === "button" || t === "reset" || t === "image") return "button";
      if (t === "range") return "slider";
      if (t === "file") return "file upload";
      return "textbox";
    }
    if (el.isContentEditable) return "textbox";
    return ROLE_BY_TAG[el.tagName] || null;
  }

  // ---- interactive-element collection (the cache) ----
  function collect() {
    const picked = new Set();
    const els = [];
    walk(document, (el) => {
      let semantic = false;
      try { semantic = el.matches(SEMANTIC); } catch (_) {}
      if (!semantic) {
        // Pointer-cursor heuristic for React-style onClick divs. Cheap checks
        // first; styles only for elements not already inside a picked control.
        for (let p = parentAcross(el); p; p = parentAcross(p)) if (picked.has(p)) return;
        let cs;
        try { cs = getComputedStyle(el); } catch (_) { return; }
        if (cs.cursor !== "pointer" || cs.pointerEvents === "none") return;
        if (cs.visibility === "hidden" || cs.display === "none") return;
        if (el.querySelector(SEMANTIC)) return; // wrapper around a real control
        // A web-component host (<sl-button>) whose shadow root holds the real
        // <button>: list the inner control only, not both.
        const sr = shadowRootOf(el);
        if (sr && sr.querySelector(SEMANTIC)) return;
      }
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return; // not rendered
      picked.add(el);
      els.push(el);
    });
    window.__otterEls = els;
    return els.map((el) => describe(el));
  }

  function describe(el) {
    const r = el.getBoundingClientRect();
    const e = {
      tag: el.tagName.toLowerCase(),
      text: labelOf(el).slice(0, 80),
      x: Math.round(r.x + r.width / 2),
      y: Math.round(r.y + r.height / 2),
    };
    // Only roles the tag doesn't already say (role attributes, input types).
    if (el.getAttribute("role") || el.tagName === "INPUT" || el.isContentEditable) {
      const role = roleOf(el);
      if (role && role !== e.tag) e.role = role;
    }
    if (el.disabled || el.getAttribute("aria-disabled") === "true") e.disabled = true;
    if (el.type === "checkbox" || el.type === "radio") e.checked = !!el.checked;
    else if (el.hasAttribute("aria-checked")) e.checked = el.getAttribute("aria-checked") === "true";
    if (el.hasAttribute("aria-expanded")) e.expanded = el.getAttribute("aria-expanded") === "true";
    if (el.tagName === "A" && el.href) e.href = el.href.slice(0, 200);
    // The control's visible label, when it says something its name doesn't
    // (an empty field, a radio named by its value).
    if (isLabelledControl(el)) {
      const lab = labelText(el);
      if (lab && lab.toLowerCase() !== e.text.toLowerCase()) e.label = lab;
    }
    if (!inViewport(r)) e.offscreen = true;
    return e;
  }

  const elAt = (i) => {
    const el = (window.__otterEls || [])[i];
    return el && el.isConnected ? el : null;
  };

  function rect(i) {
    const el = elAt(i);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2),
      left: r.left, top: r.top, width: r.width, height: r.height,
      inView: inViewport(r), text: labelOf(el).slice(0, 80),
    };
  }

  function scrollTo(i) {
    const el = elAt(i);
    if (!el) return false;
    if (el.scrollIntoViewIfNeeded) el.scrollIntoViewIfNeeded(true);
    else el.scrollIntoView({ block: "center", inline: "center" });
    return true;
  }

  // Is element i really what a click at (x, y) would land on? Catches
  // overlays, modals and reflow swapping something else under the pointer.
  function hitIs(i, x, y) {
    const el = elAt(i);
    if (!el) return { ok: false, gone: true, text: null };
    const hit = deepElementFromPoint(x, y);
    if (hit && (hit === el || containsDeep(el, hit))) return { ok: true, text: labelOf(el).slice(0, 80) };
    // The hit may be the web component that WRAPS the target (<sl-button>
    // around its inner <button>, e.g. over slotted text): that's the target.
    for (let h = el.getRootNode().host; h; h = h.getRootNode().host) {
      if (h === hit) return { ok: true, text: labelOf(el).slice(0, 80) };
    }
    const target = hit ? (closestInteractive(hit) || hit) : null;
    return { ok: false, text: target ? labelOf(target).slice(0, 80) : null };
  }

  // Topmost element at a frame-local point. A point over an iframe returns
  // { frame: true } — that frame's own copy of this library answers instead.
  function hitTest(x, y) {
    if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return null;
    const hit = deepElementFromPoint(x, y);
    if (!hit) return null;
    if (hit.tagName === "IFRAME" || hit.tagName === "FRAME") return { frame: true };
    const target = closestInteractive(hit) || hit;
    return { text: labelOf(target).slice(0, 120), tag: target.tagName.toLowerCase() };
  }

  // ---- durable targets (run_script) over the CURRENT cache ----
  function match(selector, text, tag) {
    const els = window.__otterEls || [];
    let cands;
    if (selector) {
      let matched;
      try { matched = deepQueryAll(selector); } catch (_) { return { error: `Invalid CSS selector: ${selector}` }; }
      cands = [];
      for (const m of matched) {
        // The selector may hit the control itself, a wrapper, or a node inside.
        let ix = els.indexOf(m);
        if (ix === -1) ix = els.findIndex((el) => containsDeep(el, m) || containsDeep(m, el));
        if (ix !== -1 && !cands.includes(ix)) cands.push(ix);
      }
    } else {
      cands = els.map((_, i) => i);
    }
    if (tag) cands = cands.filter((i) => els[i].tagName.toLowerCase() === tag.toLowerCase());
    if (text != null && text !== "") {
      const q = text.trim().toLowerCase();
      // Each element's names: what it shows (labelOf) and, for a form
      // control, its <label> — so "Customer name" finds the field labelled
      // that, even when the field itself is empty or shows its value.
      const names = new Map(cands.map((i) => {
        const el = els[i];
        const n = [labelOf(el).toLowerCase()];
        if (isLabelledControl(el)) {
          const lab = labelText(el).toLowerCase();
          if (lab) n.push(lab);
        }
        return [i, n];
      }));
      const any = (i, test) => names.get(i).some(test);
      // Exact beats prefix beats substring — 'Log' finds 'Log', not 'Log out'.
      let hits = cands.filter((i) => any(i, (s) => s === q));
      if (!hits.length) hits = cands.filter((i) => any(i, (s) => s.startsWith(q)));
      if (!hits.length) hits = cands.filter((i) => any(i, (s) => s.includes(q)));
      cands = hits;
    }
    return { matches: cands };
  }

  // ---- durable targets for the flow recorder (recorder.js) ----
  // A target that resolves back to the element through match() above, the
  // way run_script will look for it. Never built from what was typed: a text
  // field's label comes from its <label>, aria-label, placeholder or name —
  // labelOf() would return its value.
  const NON_TEXT_INPUT = /^(checkbox|radio|submit|button|reset|image|file|range|color|hidden)$/i;
  function isTextField(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.tagName === "TEXTAREA") return true;
    if (el.tagName === "INPUT") return !NON_TEXT_INPUT.test(el.type || "text");
    return !!el.isContentEditable;
  }

  // A form control's own label as a person sees it — aria-label,
  // aria-labelledby, or its <label> (wrapping or for=) — with no fallbacks.
  // Shown next to the control and matched by text targets, but never used as
  // its name (labelOf): the approval gate checks that name, and a text field
  // labelled "Send to" or "Order notes" must not turn a click into it into a
  // "destructive" one.
  const tidy = (s) => String(s || "").trim().replace(/\s+/g, " ");
  function labelText(el) {
    let t = tidy(el.getAttribute("aria-label"));
    const ids = el.getAttribute("aria-labelledby");
    if (!t && ids) {
      const root = el.getRootNode && el.getRootNode().getElementById ? el.getRootNode() : document;
      t = tidy(ids.split(/\s+/).map((id) => {
        const n = root.getElementById(id);
        return n ? n.textContent : "";
      }).join(" "));
    }
    if (!t && el.labels && el.labels.length) {
      // The label's own words — not the control inside it (a <select> in a
      // <label> would otherwise add every option).
      const lab = el.labels[0];
      const tw = document.createTreeWalker(lab, NodeFilter.SHOW_TEXT);
      let s = "", n;
      while ((n = tw.nextNode())) {
        const p = n.parentElement;
        if (el.contains(n) || (p && p.closest("select, textarea, option"))) continue;
        s += n.textContent + " ";
      }
      t = tidy(s);
    }
    return t.slice(0, 80);
  }
  // Form controls that carry a label: text fields, dropdowns, checkboxes and
  // radios (not buttons — their own text is their label).
  const isLabelledControl = (el) =>
    !!el && el.nodeType === 1 &&
    (isTextField(el) || el.tagName === "SELECT" || (el.tagName === "INPUT" && /^(checkbox|radio)$/i.test(el.type || "")));

  function fieldLabel(el) {
    const t = labelText(el) ||
      tidy(el.placeholder) || tidy(el.title) || tidy(el.getAttribute("name")) || tidy(el.id);
    return t.slice(0, 80);
  }

  const UNSTABLE_ID = /^(:r|ember|react-|mui-|radix-)/i;
  const stableId = (id) => !!id && id.length <= 40 && !/\d{4,}/.test(id) && !UNSTABLE_ID.test(id);
  const attrValue = (v) => `"${String(v).replace(/["\\]/g, "\\$&").replace(/\n/g, "\\a ")}"`;

  // tag:nth-of-type path up to the nearest ancestor with a stable id; with
  // maxLevels, at most that many steps (then unanchored).
  function cssPath(el, maxLevels) {
    const parts = [];
    let n = el;
    for (let lvl = 0; n && n.nodeType === 1 && (maxLevels == null || lvl < maxLevels); lvl++) {
      if (lvl > 0 && stableId(n.id)) {
        parts.unshift(`#${CSS.escape(n.id)}`);
        break;
      }
      const tag = n.tagName.toLowerCase();
      const up = n.parentNode;
      const sibs = up && up.children ? [...up.children].filter((c) => c.tagName === n.tagName) : [];
      parts.unshift(sibs.length > 1 ? `${tag}:nth-of-type(${sibs.indexOf(n) + 1})` : tag);
      if (!n.parentElement) break; // <html>, or the top of a shadow root
      n = n.parentElement;
    }
    return parts.join(" > ");
  }

  // { el, target } for an event's target, or null when it isn't inside
  // anything interactive (a click on plain text).
  function durable(raw) {
    const els = (collect(), window.__otterEls || []);
    let el = null;
    for (let n = raw; n; n = parentAcross(n)) {
      if (els.indexOf(n) !== -1) { el = n; break; }
    }
    if (!el) return null;
    const i = els.indexOf(el);
    const tag = el.tagName.toLowerCase();
    const typed = isTextField(el) || el.tagName === "SELECT";
    const choice = el.tagName === "INPUT" && /^(checkbox|radio)$/i.test(el.type || "");
    const label = (typed ? fieldLabel(el) : choice ? fieldLabel(el) || labelOf(el) : labelOf(el))
      .trim().replace(/\s+/g, " ").slice(0, 80);

    const cands = [];
    for (const a of ["data-testid", "data-test", "data-qa", "data-cy"]) {
      const v = el.getAttribute(a);
      if (v) cands.push({ selector: `[${a}=${attrValue(v)}]` });
    }
    if (stableId(el.id)) cands.push({ selector: `#${CSS.escape(el.id)}` });
    const name = el.getAttribute("name");
    if (name && /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(el.tagName)) {
      cands.push({ selector: `${tag}[name=${attrValue(name)}]` });
    }
    const aria = el.getAttribute("aria-label");
    if (aria) cands.push({ selector: `[aria-label=${attrValue(aria)}]` });
    // Visible text only where it isn't a typed value (and stays the same
    // while the user types, so a click and its fill name the same target).
    if (!typed) {
      const t = labelOf(el).trim().slice(0, 80);
      if (t) cands.push({ text: t, tag });
    }
    cands.push({ selector: cssPath(el, 5) });
    cands.push({ selector: cssPath(el) }); // full path: always finds it

    const hits = cands.map((c) => {
      const r = match(c.selector || null, c.text == null ? null : c.text, c.tag || null);
      return r && Array.isArray(r.matches) ? [...r.matches].sort((a, b) => a - b) : [];
    });
    let pick = cands.findIndex((c, k) => hits[k].length === 1 && hits[k][0] === i);
    let nth = 0;
    if (pick === -1) {
      pick = cands.findIndex((c, k) => hits[k].includes(i));
      if (pick === -1) return null;
      nth = hits[pick].indexOf(i);
    }
    const target = { ...cands[pick], label };
    if (nth) target.nth = nth;
    return { el, target };
  }

  function durableTarget(raw) {
    const d = durable(raw);
    return d ? d.target : null;
  }

  // run_flow, for a step that needed a password: did the browser (or the
  // user) fill it in? Never says what's in it.
  function fieldFilled(i) {
    const el = elAt(i);
    if (!el) return { gone: true };
    if (el.tagName === "SELECT") return { filled: el.selectedIndex > 0 };
    const v = valueOf(el);
    return { filled: typeof v === "string" && v.length > 0 };
  }

  // ---- text ----
  function pageText() {
    let t = document.body ? document.body.innerText : "";
    // innerText doesn't always include shadow content; append what's missing.
    for (const sr of shadowRoots()) {
      for (const c of sr.children) {
        const s = (c.innerText || "").trim();
        if (s && !t.includes(s.slice(0, 60))) t += "\n" + s;
      }
    }
    return t;
  }

  function findText(query, limit) {
    const q = query.toLowerCase();
    const found = [];
    const roots = [document.body || document.documentElement, ...shadowRoots()];
    for (const root of roots) {
      const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = tw.nextNode()) && found.length < limit) {
        const t = node.textContent;
        const tl = t.toLowerCase();
        let ix = tl.indexOf(q);
        while (ix !== -1 && found.length < limit) {
          const range = document.createRange();
          range.setStart(node, ix);
          range.setEnd(node, ix + query.length);
          const r = range.getBoundingClientRect();
          if (r.width || r.height) {
            found.push({
              node, ix, len: query.length,
              context: t.slice(Math.max(0, ix - 60), ix + query.length + 60).trim(),
            });
          }
          ix = tl.indexOf(q, ix + 1);
        }
      }
    }
    window.__otterFind = found;
    return found.map((m) => findPos(m));
  }

  function findPos(m) {
    const range = document.createRange();
    range.setStart(m.node, m.ix);
    range.setEnd(m.node, m.ix + m.len);
    const r = range.getBoundingClientRect();
    return {
      x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2),
      visible: inViewport(r), context: m.context,
    };
  }

  function scrollToFind(i) {
    const m = (window.__otterFind || [])[i];
    const el = m && m.node.parentElement;
    if (el) el.scrollIntoView({ block: "center" });
    return (window.__otterFind || []).map((f) => findPos(f));
  }

  // Text and selector are reported separately: across frames, each condition
  // may be satisfied by a different frame.
  function waitCheck(text, selector) {
    const textOk = text == null || pageText().toLowerCase().includes(text.toLowerCase());
    let selOk = true;
    if (selector != null) {
      try { selOk = deepQueryAll(selector).length > 0; } catch (_) { return { invalidSelector: true }; }
    }
    return { textOk, selOk };
  }

  // ---- forms ----
  function focusSelect(i) {
    const el = elAt(i);
    if (!el) return { fatal: true, error: `No element with index ${i}. Call read_elements first.` };
    el.focus();
    if (typeof el.select === "function") el.select();
    else if (el.isContentEditable) {
      const r = document.createRange();
      r.selectNodeContents(el);
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
    }
    return { tag: el.tagName.toLowerCase(), value: valueOf(el), focused: isFocused(el) };
  }

  const valueOf = (el) =>
    el.value !== undefined ? el.value : (el.isContentEditable ? el.innerText : "");

  function isFocused(el) {
    let a = document.activeElement;
    while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
    return document.hasFocus() && (a === el || (a != null && containsDeep(el, a)));
  }

  // What pressing Enter would trigger, for the approval gate (Enter submits a
  // form just like clicking its submit button). Returns { labels } — the
  // candidates the gate checks — or null when the focus isn't in this frame.
  //   - a focused button / link: itself;
  //   - a field in a form: the form's submit button;
  //   - a text box outside any form (chat composers send on Enter): the
  //     buttons close around it, e.g. "Send".
  // i: an element index (fill_element, before it focuses); else the focus.
  function enterTarget(i) {
    let el;
    if (i != null) {
      el = elAt(i);
    } else {
      if (!document.hasFocus()) return null;
      el = document.activeElement;
      while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
      if (el && /^(IFRAME|FRAME)$/.test(el.tagName)) return null; // the frame answers for itself
    }
    if (!el || el === document.body || el === document.documentElement) return { labels: [] };
    const clip = (s) => String(s || "").trim().slice(0, 200);
    const tag = el.tagName;
    if (tag === "BUTTON" || tag === "A" || el.getAttribute("role") === "button" ||
        (tag === "INPUT" && /^(submit|button|image|reset)$/i.test(el.type || ""))) {
      return { labels: [clip(labelOf(el))] };
    }
    const form = el.form || (el.closest && el.closest("form"));
    if (form) {
      const btn = form.querySelector('button[type="submit"], input[type="submit"], input[type="image"], button:not([type])');
      return { labels: btn ? [clip(labelOf(btn))] : [] };
    }
    const editable = tag === "INPUT" || tag === "TEXTAREA" || el.isContentEditable;
    if (!editable) return { labels: [] };
    // Walk up a few levels; stop once a container is too broad to be "the
    // composer" (lots of buttons = a whole toolbar or page section).
    const labels = [];
    let node = el;
    for (let up = 0; up < 4 && node; up++) {
      node = node.parentElement || (node.getRootNode && node.getRootNode().host) || null;
      if (!node || !node.querySelectorAll) break;
      const buttons = node.querySelectorAll('button, [role="button"], input[type="submit"]');
      if (buttons.length > 12) break;
      for (const b of buttons) labels.push(clip(labelOf(b)));
    }
    return { labels: [...new Set(labels.filter(Boolean))].slice(0, 12) };
  }

  function fieldState(i) {
    const el = elAt(i);
    if (!el) return { gone: true };
    return { focused: isFocused(el), value: valueOf(el) };
  }

  function selectOption(i, value, label) {
    const el = elAt(i);
    if (!el) return { ok: false, error: `No element with index ${i}. Call read_elements first.` };
    if (el.tagName !== "SELECT") {
      return { ok: false, error: `Element ${i} is a <${el.tagName.toLowerCase()}>, not a <select>.` };
    }
    const opts = [...el.options];
    const norm = (s) => (s || "").trim().toLowerCase();
    let opt = null;
    if (value != null) opt = opts.find((o) => o.value === value);
    if (!opt && label != null) opt = opts.find((o) => norm(o.text) === norm(label));
    if (!opt && label != null) opt = opts.find((o) => norm(o.text).includes(norm(label)));
    if (!opt) {
      return {
        ok: false, error: "No option matches.",
        options: opts.slice(0, 30).map((o) => ({ value: o.value, label: o.text.trim() })),
      };
    }
    el.value = opt.value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true, selected: { value: opt.value, label: opt.text.trim() } };
  }

  // Tag the <input type=file> to upload into, so background.js can find it
  // through CDP (which needs a DOM node, not our isolated-world reference).
  function markFileInput(i, selector, token) {
    const isFile = (n) => n && n.tagName === "INPUT" && (n.type || "").toLowerCase() === "file";
    let input = null;
    if (i != null) {
      const el = elAt(i);
      if (!el) return { ok: false, error: `No element with index ${i}. Call read_elements first.` };
      // Upload buttons usually hide the real input: look inside, at the
      // label's control, then in the surrounding form.
      input = isFile(el) ? el
        : el.querySelector("input[type=file]") ||
          (el.closest && el.closest("label") && el.closest("label").control) ||
          (el.closest && el.closest("form") && el.closest("form").querySelector("input[type=file]"));
    } else {
      let all;
      try { all = deepQueryAll(selector || "input[type=file]"); }
      catch (_) { return { ok: false, error: `Invalid CSS selector: ${selector}` }; }
      all = all.filter(isFile);
      if (all.length > 1 && !selector) {
        return { ok: false, error: `The page has ${all.length} file inputs; pass the index of the upload control or a selector.` };
      }
      input = all[0] || null;
    }
    if (!isFile(input)) return { ok: false, notFound: true, error: "No file input found for that target." };
    input.setAttribute("data-otter-upload", token);
    return { ok: true, multiple: input.multiple, accept: input.accept || "", url: location.href };
  }

  function unmarkFileInput(token) {
    for (const n of deepQueryAll(`[data-otter-upload="${token}"]`)) n.removeAttribute("data-otter-upload");
  }

  // ---- page snapshot: compact structured outline ----
  // Headings, landmarks/dialogs, interactive elements (with the SAME local
  // indices as the cache, mapped to global ones by background.js) and short
  // visible text blocks. Far cheaper to read than a screenshot.
  const LANDMARK = { NAV: "navigation", MAIN: "main", HEADER: "banner", FOOTER: "contentinfo", ASIDE: "complementary", FORM: "form", DIALOG: "dialog" };
  function snapshot(scope, maxLines) {
    const els = window.__otterEls || [];
    const idx = new Map(els.map((el, i) => [el, i]));
    const lines = [];
    let truncated = false;
    const visible = (r) => r.width > 0 && r.height > 0 && (scope !== "viewport" || inViewport(r));
    const insideInteractive = (el) => {
      for (let p = parentAcross(el); p; p = parentAcross(p)) if (idx.has(p)) return true;
      return false;
    };
    walk(document, (el) => {
      if (lines.length >= maxLines) { truncated = true; return; }
      if (el.tagName === "SCRIPT" || el.tagName === "STYLE" || el.tagName === "NOSCRIPT") return;
      if (idx.has(el)) {
        const r = el.getBoundingClientRect();
        if (!visible(r)) return;
        const d = describe(el);
        const isPw = el.tagName === "INPUT" && (el.type || "").toLowerCase() === "password";
        let line = `${roleOf(el) || d.tag} "${d.text}"`;
        if (d.label) line += ` label "${d.label}"`;
        if ((el.tagName === "INPUT" || el.tagName === "TEXTAREA") && roleOf(el) === "textbox") {
          const v = isPw ? (el.value ? "••••" : "") : String(el.value || "").slice(0, 60);
          if (v && v !== d.text) line += ` = "${v}"`;
        }
        if (d.checked != null) line += d.checked ? " (checked)" : " (unchecked)";
        if (d.expanded != null) line += d.expanded ? " (expanded)" : " (collapsed)";
        if (d.disabled) line += " (disabled)";
        if (d.href) line += ` → ${d.href.slice(0, 120)}`;
        lines.push({ text: line, ref: idx.get(el) });
        return;
      }
      const role = el.getAttribute("role");
      const tag = el.tagName;
      if (/^H[1-6]$/.test(tag) || role === "heading") {
        const r = el.getBoundingClientRect();
        if (!visible(r)) return;
        const t = (el.innerText || "").trim().replace(/\s+/g, " ").slice(0, 120);
        if (t) lines.push({ text: `heading "${t}" (${/^H[1-6]$/.test(tag) ? tag.toLowerCase() : "h" + (el.getAttribute("aria-level") || "?")})` });
        return;
      }
      const lm = LANDMARK[tag] || (role === "dialog" || role === "alertdialog" ? "dialog" : null);
      if (lm) {
        const r = el.getBoundingClientRect();
        if (!visible(r)) return;
        const name = el.getAttribute("aria-label") || "";
        lines.push({ text: `[${lm}${name ? ` "${name}"` : ""}]` });
        return;
      }
      // Own visible text (direct text nodes) of a non-interactive element.
      let own = "";
      for (const n of el.childNodes) if (n.nodeType === 3) own += n.textContent;
      own = own.trim().replace(/\s+/g, " ");
      if (own.length < 2 || insideInteractive(el)) return;
      const r = el.getBoundingClientRect();
      if (!visible(r)) return;
      const t = own.slice(0, 160);
      const last = lines[lines.length - 1];
      if (!last || last.text !== `text "${t}"`) lines.push({ text: `text "${t}"` });
    });
    return {
      lines, truncated,
      viewport: { w: innerWidth, h: innerHeight, scrollY: Math.round(scrollY), scrollH: document.documentElement.scrollHeight },
    };
  }

  // ---- mutation counter (did an action change anything?) ----
  function watchMutations() {
    if (window.__otterMO) window.__otterMO.disconnect();
    const state = { count: 0 };
    window.__otterMut = state;
    window.__otterMO = new MutationObserver((ms) => { state.count += ms.length; });
    window.__otterMO.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    return true;
  }
  const mutationCount = () => (window.__otterMut ? window.__otterMut.count : -1);

  // ---- frame offsets ----
  // Each frame learns its top-left corner in TOP-viewport coordinates from its
  // parent: the top frame starts the relay, every frame forwards to its own
  // visible iframes. Only messages from the actual parent window count.
  const KEY = "__otterFrameOffset";
  let offset = window === window.top ? { x: 0, y: 0, token: null } : null;

  function depth() {
    let d = 0;
    for (let w = window; w !== w.top && d < 20; w = w.parent) d++;
    return d;
  }

  function propagate(off) {
    for (const f of deepQueryAll("iframe, frame")) {
      try {
        const r = f.getBoundingClientRect();
        if (!r.width || !r.height || !f.contentWindow) continue;
        const cs = getComputedStyle(f);
        f.contentWindow.postMessage({
          [KEY]: {
            x: off.x + r.left + f.clientLeft + (parseFloat(cs.paddingLeft) || 0),
            y: off.y + r.top + f.clientTop + (parseFloat(cs.paddingTop) || 0),
            token: off.token,
          },
        }, "*");
      } catch (_) {}
    }
  }

  window.addEventListener("message", (e) => {
    const d = e.data;
    if (!d || typeof d !== "object" || !d[KEY]) return;
    if (window === window.top || e.source !== window.parent) return;
    offset = { x: d[KEY].x, y: d[KEY].y, token: d[KEY].token };
    propagate(offset);
  });

  // hitTest for a point in TOP-viewport coordinates, answered by whichever
  // frame the point falls in (deepest frame wins; see background.js).
  function hitTestTop(x, y) {
    const off = window === window.top ? { x: 0, y: 0 } : offset;
    if (!off) return null;
    const r = hitTest(x - off.x, y - off.y);
    return r ? { ...r, depth: depth() } : null;
  }

  function broadcast(token) {
    if (window !== window.top) return false;
    offset = { x: 0, y: 0, token };
    propagate(offset);
    return true;
  }

  function frameInfo(token) {
    const top = window === window.top;
    const known = top || (offset && (token == null || offset.token === token));
    return {
      top,
      offset: known ? { x: top ? 0 : offset.x, y: top ? 0 : offset.y } : null,
      depth: depth(),
      frames: document.querySelectorAll("iframe, frame").length + shadowRoots().reduce((n, sr) => n + sr.querySelectorAll("iframe, frame").length, 0),
      url: location.href,
      w: innerWidth, h: innerHeight,
      scrollX: Math.round(scrollX), scrollY: Math.round(scrollY),
      dpr: devicePixelRatio,
    };
  }

  // ===== Performance measurement (perf_audit / perf_record) =====
  // Fixed measurement code reading the browser's own performance timeline;
  // top frame only. Numbers are milliseconds since navigation start.
  const r0 = (n) => (n == null ? null : Math.round(n));
  function perfLabel(el) {
    if (!el || !el.tagName) return null;
    let d = el.tagName.toLowerCase();
    if (el.id) d += `#${el.id}`;
    else if (el.classList && el.classList.length) d += "." + [...el.classList].slice(0, 2).join(".");
    return d.slice(0, 80);
  }
  function longFrames(entries, n = 10) {
    return [...entries].sort((a, b) => b.duration - a.duration).slice(0, n).map((e) => ({
      start: r0(e.startTime), duration: r0(e.duration), blocking: r0(e.blockingDuration),
      scripts: [...(e.scripts || [])].sort((a, b) => b.duration - a.duration).slice(0, 3).map((sc) => ({
        url: String(sc.sourceURL || "").slice(0, 300), fn: sc.sourceFunctionName || "",
        invoker: String(sc.invoker || "").slice(0, 120), duration: r0(sc.duration),
      })),
    }));
  }
  // Largest session window of layout shifts (the CLS definition): shifts
  // less than 1 s apart, window at most 5 s, shifts right after input ignored.
  function clsOf(shifts) {
    let best = 0, cur = 0, first = 0, prev = 0;
    for (const e of shifts) {
      if (e.hadRecentInput) continue;
      if (cur && e.startTime - prev < 1000 && e.startTime - first < 5000) cur += e.value;
      else { cur = e.value; first = e.startTime; }
      prev = e.startTime;
      best = Math.max(best, cur);
    }
    return Math.round(best * 1000) / 1000;
  }
  function domStats() {
    let nodes = 0, maxDepth = 0;
    const stack = [[document.documentElement, 1]];
    while (stack.length) {
      const [el, d] = stack.pop();
      if (!el) continue;
      nodes++;
      if (d > maxDepth) maxDepth = d;
      for (const c of el.children) stack.push([c, d + 1]);
    }
    return { nodes, maxDepth };
  }
  // Buffered entries of the given types (delivered asynchronously).
  function timeline(types) {
    const supported = (window.PerformanceObserver && PerformanceObserver.supportedEntryTypes) || [];
    const got = {}, obs = [];
    for (const t of types) {
      got[t] = [];
      if (!supported.includes(t)) continue;
      try {
        const o = new PerformanceObserver((list) => got[t].push(...list.getEntries()));
        o.observe({ type: t, buffered: true });
        obs.push([t, o]);
      } catch (_) {}
    }
    return new Promise((resolve) => setTimeout(() => {
      for (const [t, o] of obs) { try { got[t].push(...o.takeRecords()); o.disconnect(); } catch (_) {} }
      resolve({ got, supported });
    }, 50));
  }

  async function perfCollect() {
    const { got, supported } = await timeline([
      "navigation", "paint", "largest-contentful-paint", "layout-shift", "longtask", "long-animation-frame", "resource",
    ]);
    const nav = got.navigation[0] || performance.getEntriesByType("navigation")[0];
    const fcpE = got.paint.find((e) => e.name === "first-contentful-paint");
    const fcp = fcpE ? fcpE.startTime : null;
    const lcpE = got["largest-contentful-paint"].at(-1);
    const tbt = got.longtask
      .filter((e) => fcp == null || e.startTime >= fcp)
      .reduce((sum, e) => sum + Math.max(0, e.duration - 50), 0);
    return {
      visibility: document.visibilityState,
      supported: ["largest-contentful-paint", "layout-shift", "longtask", "long-animation-frame"].filter((t) => supported.includes(t)),
      ttfb: nav ? r0(nav.responseStart) : null,
      dom_content_loaded: nav ? r0(nav.domContentLoadedEventEnd) : null,
      load: nav ? r0(nav.loadEventEnd) : null,
      fcp: r0(fcp),
      lcp: lcpE ? { time: r0(lcpE.startTime), size: lcpE.size, element: perfLabel(lcpE.element), url: String(lcpE.url || "").slice(0, 300) } : null,
      cls: clsOf(got["layout-shift"]),
      tbt: r0(tbt),
      long_frames: longFrames(got["long-animation-frame"]),
      render_blocking: got.resource.filter((e) => e.renderBlockingStatus === "blocking").map((e) => e.name.slice(0, 300)),
      dom: domStats(),
    };
  }

  // perf_record: live observers between start and stop.
  let rec = null;
  function perfRecStart() {
    if (rec) rec.obs.forEach(([, o]) => o.disconnect());
    const supported = (window.PerformanceObserver && PerformanceObserver.supportedEntryTypes) || [];
    rec = { t0: performance.now(), entries: { longtask: [], "long-animation-frame": [], "layout-shift": [], event: [] }, obs: [] };
    for (const t of Object.keys(rec.entries)) {
      if (!supported.includes(t)) continue;
      try {
        const o = new PerformanceObserver((list) => rec && rec.entries[t].push(...list.getEntries()));
        o.observe(t === "event" ? { type: t, durationThreshold: 40 } : { type: t });
        rec.obs.push([t, o]);
      } catch (_) {}
    }
    return true;
  }
  function perfRecStop() {
    if (!rec) return { navigated: true };
    const { entries, obs } = rec;
    for (const [t, o] of obs) { try { entries[t].push(...o.takeRecords()); o.disconnect(); } catch (_) {} }
    rec = null;
    return {
      slowest_interactions: [...entries.event].sort((a, b) => b.duration - a.duration).slice(0, 10)
        .map((e) => ({ type: e.name, duration: r0(e.duration), target: perfLabel(e.target) })),
      long_frames: longFrames(entries["long-animation-frame"]),
      blocking_ms: r0(entries.longtask.reduce((sum, e) => sum + Math.max(0, e.duration - 50), 0)),
      cls: clsOf(entries["layout-shift"]),
      dom: domStats(),
    };
  }

  window.__otter = {
    v: VERSION,
    collect, rect, scrollTo, hitIs, hitTest, hitTestTop, match, labelAt: (i) => (elAt(i) ? labelOf(elAt(i)).slice(0, 80) : null),
    pageText, findText, scrollToFind, waitCheck,
    focusSelect, fieldState, enterTarget, selectOption, markFileInput, unmarkFileInput,
    snapshot, watchMutations, mutationCount,
    broadcast, frameInfo,
    perfCollect, perfRecStart, perfRecStop,
    durable, durableTarget, isTextField, fieldFilled,
  };
})();
