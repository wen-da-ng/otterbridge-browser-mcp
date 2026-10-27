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
  const VERSION = 5;
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
      const lab = new Map(cands.map((i) => [i, labelOf(els[i]).toLowerCase()]));
      // Exact beats prefix beats substring — 'Log' finds 'Log', not 'Log out'.
      let hits = cands.filter((i) => lab.get(i) === q);
      if (!hits.length) hits = cands.filter((i) => lab.get(i).startsWith(q));
      if (!hits.length) hits = cands.filter((i) => lab.get(i).includes(q));
      cands = hits;
    }
    return { matches: cands };
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

  window.__otter = {
    v: VERSION,
    collect, rect, scrollTo, hitIs, hitTest, hitTestTop, match, labelAt: (i) => (elAt(i) ? labelOf(elAt(i)).slice(0, 80) : null),
    pageText, findText, scrollToFind, waitCheck,
    focusSelect, fieldState, selectOption, markFileInput, unmarkFileInput,
    snapshot, watchMutations, mutationCount,
    broadcast, frameInfo,
  };
})();
