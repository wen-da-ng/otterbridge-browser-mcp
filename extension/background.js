// config.js defines OtterConfig (shared DEFAULTS / PRESETS / helpers). Must be
// imported before anything reads settings.
importScripts("config.js");

// Live settings from chrome.storage.sync, refreshed whenever they change.
let S = OtterConfig.DEFAULTS;
OtterConfig.load().then((s) => { S = s; });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && changes[OtterConfig.KEY]) {
    S = OtterConfig.normalize(changes[OtterConfig.KEY].newValue);
  }
});

// ===== WebSocket bridge =====
let ws;

function connect() {
  ws = new WebSocket("ws://localhost:8765");
  ws.onopen = () => console.log("[agent] connected to MCP bridge");
  ws.onmessage = async (e) => {
    const { id, action, params } = JSON.parse(e.data);
    let result = null, error = null;
    try {
      result = await handle(action, params || {});
    } catch (err) {
      error = err.message || String(err);
    }
    ws.send(JSON.stringify({ id, result, error }));
  };
  ws.onclose = () => setTimeout(connect, 2000); // auto-reconnect
  ws.onerror = () => ws.close();
}
connect();

// MV3 service workers can be suspended; a periodic alarm keeps reconnection alive.
chrome.alarms.create("keepalive", { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener(() => {
  if (!ws || ws.readyState === WebSocket.CLOSED) connect();
});

// ===== Small helpers =====
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ===== CDP helpers =====
const attached = new Set();

async function ensureDebugger(tabId) {
  if (attached.has(tabId)) return;
  await chrome.debugger.attach({ tabId }, "1.3");
  attached.add(tabId);
  // Console/network capture rides along with every attach (read_console /
  // read_network read the buffers below). Best-effort: an enable failure must
  // never block the action that triggered the attach.
  try {
    await Promise.all([
      chrome.debugger.sendCommand({ tabId }, "Runtime.enable"),
      chrome.debugger.sendCommand({ tabId }, "Log.enable"),
      chrome.debugger.sendCommand({ tabId }, "Network.enable"),
    ]);
  } catch (_) {}
}

chrome.debugger.onDetach.addListener(({ tabId }) => attached.delete(tabId));

// ===== Console + network capture (per-tab ring buffers) =====
// Filled by CDP events while a debugger is attached. Buffers survive a detach
// (the data stays readable); they're dropped when the tab closes.
const consoleBuf = new Map(); // tabId -> [{ ts, level, text, url?, source? }]
const networkBuf = new Map(); // tabId -> Map(requestId -> entry), insertion-ordered
const CONSOLE_CAP = 500, NETWORK_CAP = 300;

function pushConsole(tabId, entry) {
  let buf = consoleBuf.get(tabId);
  if (!buf) consoleBuf.set(tabId, (buf = []));
  buf.push(entry);
  if (buf.length > CONSOLE_CAP) buf.splice(0, buf.length - CONSOLE_CAP);
}

chrome.debugger.onEvent.addListener(({ tabId }, method, params) => {
  if (tabId == null) return;
  if (method === "Runtime.consoleAPICalled") {
    const text = (params.args || [])
      .map((a) => {
        if (a.value !== undefined) {
          return typeof a.value === "string" ? a.value : JSON.stringify(a.value);
        }
        return a.description || a.type;
      })
      .join(" ");
    pushConsole(tabId, { ts: params.timestamp, level: params.type, text: text.slice(0, 2000) });
  } else if (method === "Runtime.exceptionThrown") {
    const d = params.exceptionDetails;
    const text =
      (d.exception && (d.exception.description || d.exception.value)) ||
      d.text || "Uncaught exception";
    pushConsole(tabId, {
      ts: params.timestamp, level: "error", text: String(text).slice(0, 2000), url: d.url,
    });
  } else if (method === "Log.entryAdded") {
    const e = params.entry;
    pushConsole(tabId, {
      ts: e.timestamp, level: e.level, text: String(e.text).slice(0, 2000),
      url: e.url, source: e.source,
    });
  } else if (method === "Network.requestWillBeSent") {
    let buf = networkBuf.get(tabId);
    if (!buf) networkBuf.set(tabId, (buf = new Map()));
    buf.set(params.requestId, {
      requestId: params.requestId,
      url: params.request.url,
      method: params.request.method,
      type: params.type,
      ts: params.wallTime,
    });
    if (buf.size > NETWORK_CAP) buf.delete(buf.keys().next().value);
  } else if (method === "Network.responseReceived") {
    const e = (networkBuf.get(tabId) || new Map()).get(params.requestId);
    if (e) { e.status = params.response.status; e.mimeType = params.response.mimeType; }
  } else if (method === "Network.loadingFailed") {
    const e = (networkBuf.get(tabId) || new Map()).get(params.requestId);
    if (e) e.error = params.errorText;
  } else if (method === "Network.loadingFinished") {
    const e = (networkBuf.get(tabId) || new Map()).get(params.requestId);
    if (e) e.encodedBytes = Math.round(params.encodedDataLength);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  consoleBuf.delete(tabId);
  networkBuf.delete(tabId);
});

async function cdp(tabId, method, params) {
  await ensureDebugger(tabId);
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

// Brief-attach pattern (section 12): detach when idle to shrink the window
// in which CDP-artifact detection can observe an attached debugger.
async function detachDebugger(tabId) {
  if (!attached.has(tabId)) return;
  try { await chrome.debugger.detach({ tabId }); } catch (_) {}
  attached.delete(tabId);
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error("No active tab");
  return tab;
}

// ===== Multi-tab: per-agent tab groups =====
// Each MCP session (agent) owns a colored, titled Chrome tab group. Tabs it
// opens are added to that group so parallel agents stay visually separated.
const agentGroups = {}; // agentId -> chrome tab group id
const GROUP_COLORS = ["orange", "blue", "green", "purple", "cyan", "pink", "yellow", "red", "grey"];
let groupColorIx = 0;

async function ensureAgentGroup(agentId, agentLabel, tabId) {
  if (!agentId) return undefined; // ungrouped (legacy / no session id)
  let groupId = agentGroups[agentId];
  try {
    if (groupId != null) {
      await chrome.tabs.group({ groupId, tabIds: [tabId] });
    } else {
      groupId = await chrome.tabs.group({ tabIds: [tabId] });
      agentGroups[agentId] = groupId;
      const color = GROUP_COLORS[groupColorIx++ % GROUP_COLORS.length];
      await chrome.tabGroups.update(groupId, { title: agentLabel || "OtterBridge", color });
    }
  } catch (_) { /* grouping is best-effort; never block the action */ }
  return groupId;
}

// Resolve which tab a command targets: explicit params.tabId, else the active
// tab (legacy single-tab behavior when a session hasn't opened its own tab).
async function resolveTab(p) {
  if (p && p.tabId != null) {
    try { return await chrome.tabs.get(p.tabId); }
    catch (_) { throw new Error(`Tab ${p.tabId} not found (was it closed?).`); }
  }
  return activeTab();
}

// ===== Cursor orchestration =====
// Animate the fake cursor (content script) while firing real CDP mouseMoved
// events along the same path so :hover states genuinely trigger.
async function moveWithHoverTrail(tabId, x, y) {
  // Ask content script for the sampled path points it will animate through.
  const pts = await chrome.tabs.sendMessage(tabId, {
    type: "moveCursor",
    x, y,
    samples: S.trailSamples,
  });
  for (const p of pts.path) {
    await cdp(tabId, "Input.dispatchMouseEvent", {
      type: "mouseMoved", x: p.x, y: p.y,
    });
  }
}

// ===== Human-like typing (shared by type_text and fill_element) =====
// Per-character key events with jittered timing. Speed and the occasional
// "thinking" pause are settings-driven.
async function typeChars(tabId, text) {
  for (const ch of text) {
    await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyDown", text: ch });
    await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyUp", text: ch });
    await sleep(OtterConfig.typeDelay(S, Math.random));
  }
}

// ===== Interactive-element collection (single source of truth) =====
// Runs in the page. Semantic controls PLUS elements with computed
// cursor:pointer (catches React onClick divs that have no role/onclick attr).
// Deterministic DOM order so indices line up across read/locate/click.
function collectInteractiveEls(scrollToIndex) {
  const semantic = "a, button, input, textarea, select, [role='button'], [onclick]";
  const set = new Set(document.querySelectorAll(semantic));
  document.querySelectorAll("body *").forEach((el) => {
    if (set.has(el)) return;
    let cs;
    try { cs = getComputedStyle(el); } catch (e) { return; }
    if (cs.cursor !== "pointer" || cs.pointerEvents === "none") return;
    if (cs.visibility === "hidden" || cs.display === "none") return;
    if (el.querySelector(semantic)) return;      // wrapper around a real control
    let p = el.parentElement, skip = false;
    while (p) { if (set.has(p)) { skip = true; break; } p = p.parentElement; }
    if (!skip) set.add(el);
  });
  const ordered = [...set].sort((a, b) => {
    const pos = a.compareDocumentPosition(b);
    if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
    if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
    return 0;
  });
  const out = [], elems = [];
  ordered.forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;       // invisible
    elems.push(el);
    out.push({
      index: out.length,
      tag: el.tagName.toLowerCase(),
      text: (el.innerText || el.value || el.placeholder ||
        el.getAttribute("aria-label") || el.title || "").trim().slice(0, 80),
      x: Math.round(r.x + r.width / 2),
      y: Math.round(r.y + r.height / 2),
    });
  });
  // Cache the live element references in this isolated world so follow-up
  // executeScript calls (focus/select_option) can resolve an index without
  // re-walking the DOM. Refreshed on every collection.
  window.__otterEls = elems;
  // Scroll the requested element into view if it's off-screen. CDP clicks
  // only land inside the visible viewport, so below-fold targets need this.
  if (typeof scrollToIndex === "number" && elems[scrollToIndex]) {
    const el = elems[scrollToIndex];
    if (el.scrollIntoViewIfNeeded) el.scrollIntoViewIfNeeded(true);
    else el.scrollIntoView({ block: "center", inline: "center" });
  }
  return out;
}

async function collectEls(tabId, scrollToIndex) {
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    args: [typeof scrollToIndex === "number" ? scrollToIndex : null],
    func: collectInteractiveEls,
  });
  return res.result || [];
}

// ===== Cursor visibility gating =====
// The animated cursor is only shown while the agent is active. We stamp the
// time of each real command; the post-navigation cursor restore only fires
// within this window, so ordinary browsing never shows the cursor.
let lastAgentActivity = 0;
const CURSOR_ACTIVE_WINDOW_MS = 15000;

// ===== Command handlers =====
async function handle(action, p) {
  // ping needs no tab — keep it above activeTab() so the Phase 1 echo test
  // works even on chrome:// pages where no normal tab is active.
  if (action === "ping") {
    return { pong: true, ts: Date.now() };
  }

  // ----- Multi-tab management (no pre-existing active tab required) -----
  if (action === "open_tab") {
    const created = await chrome.tabs.create({ url: p.url || "about:blank", active: true });
    // Attach CDP immediately (not lazily on first click) so console/network
    // capture covers the page load. Best-effort: chrome:// pages can't attach.
    try { await ensureDebugger(created.id); } catch (_) {}
    if (p.url) await waitForLoad(created.id);
    const groupId = await ensureAgentGroup(p.agentId, p.agentLabel, created.id);
    const fresh = await chrome.tabs.get(created.id);
    return { tabId: created.id, url: fresh.url, title: fresh.title, groupId };
  }
  if (action === "list_tabs") {
    const groupId = agentGroups[p.agentId];
    const tabs = groupId != null ? await chrome.tabs.query({ groupId }) : [];
    return tabs.map((t) => ({ tabId: t.id, title: t.title, url: t.url, active: t.active }));
  }
  if (action === "close_tab") {
    try { await chrome.tabs.remove(p.tabId); } catch (_) {}
    return { closed: p.tabId };
  }

  lastAgentActivity = Date.now();
  const tab = await resolveTab(p);
  // Focus-aware activation: when a SINGLE agent is running, bring its tab to the
  // front on visible actions so the user can watch. When MULTIPLE agents are
  // active (parallel), never steal focus — they'd fight over it. All actions
  // work on background tabs anyway (CDP input + scripting + CDP screenshot), so
  // activation is purely cosmetic. screenshot is excluded (it uses CDP capture,
  // which needs no focus).
  const VISIBLE = new Set([
    "navigate", "go_back", "go_forward", "reload",
    "click", "fill_element", "select_option", "hover", "drag",
    "type_text", "press_key", "scroll",
  ]);
  const parallel = Object.keys(agentGroups).length > 1;
  if (p.tabId != null && VISIBLE.has(action) && !parallel && !tab.active) {
    await chrome.tabs.update(tab.id, { active: true });
  }

  switch (action) {
    case "navigate": {
      await chrome.tabs.update(tab.id, { url: p.url });
      await waitForLoad(tab.id);
      return `Navigated to ${p.url}`;
    }

    case "go_back": {
      try { await chrome.tabs.goBack(tab.id); }
      catch (_) { return "Cannot go back: no earlier history entry."; }
      // Same-document (SPA pushState) moves fire no load event; cap the wait.
      await waitForLoad(tab.id, 4000);
      const fresh = await chrome.tabs.get(tab.id);
      return `Went back to ${fresh.url}`;
    }

    case "go_forward": {
      try { await chrome.tabs.goForward(tab.id); }
      catch (_) { return "Cannot go forward: no later history entry."; }
      await waitForLoad(tab.id, 4000);
      const fresh = await chrome.tabs.get(tab.id);
      return `Went forward to ${fresh.url}`;
    }

    case "reload": {
      await chrome.tabs.reload(tab.id, { bypassCache: !!p.hard });
      await waitForLoad(tab.id);
      return p.hard ? "Hard-reloaded (cache bypassed)" : "Reloaded";
    }

    case "read_page": {
      const offset = Math.max(0, p.offset || 0);
      const maxChars = Math.min(Math.max(1, p.maxChars || 20000), 100000);
      const [res] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        args: [offset, maxChars],
        func: (offset, maxChars) => {
          const full = document.body.innerText;
          return {
            url: location.href,
            title: document.title,
            text: full.slice(offset, offset + maxChars),
            offset,
            total_chars: full.length,
            devicePixelRatio: window.devicePixelRatio,
          };
        },
      });
      return res.result;
    }

    case "read_elements": {
      // Number every clickable/typable element so the model can act by index.
      return await collectEls(tab.id);
    }

    case "hit_test": {
      // Return the text/tag of the topmost interactive element at (x, y),
      // so the server can run its destructive-action check on ANY click
      // regardless of how the coordinates were obtained.
      const [res] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        args: [p.x, p.y],
        func: (x, y) => {
          const hit = document.elementFromPoint(x, y);
          if (!hit) return { text: "", tag: "" };
          const el = hit.closest(
            "a, button, input, textarea, select, [role='button'], [onclick]"
          ) || hit;
          const text = (el.innerText || el.value || el.getAttribute("aria-label") ||
            el.placeholder || el.title || "").trim().slice(0, 120);
          return { text, tag: el.tagName.toLowerCase() };
        },
      });
      return res.result;
    }

    case "locate_element": {
      // Resolve a read_elements index to its exact center INSIDE the page.
      const els = await collectEls(tab.id);
      const el = els[p.index];
      return el ? { found: true, text: el.text, x: el.x, y: el.y }
                : { found: false };
    }

    case "click": {
      // p: { x, y, index? } in CSS viewport coordinates.
      let { x, y, index } = p;
      const hasIndex = index !== undefined && index !== null;
      // The first CDP attach shows the "being debugged" banner, which reflows
      // the page. Attach up-front and let it settle before measuring/clicking.
      const firstAttach = !attached.has(tab.id);
      await ensureDebugger(tab.id);
      if (firstAttach) await sleep(200);
      // Scroll the target into view if it's below/above the fold (CDP clicks
      // only register inside the visible viewport), then take fresh coords.
      if (hasIndex) {
        await collectEls(tab.id, index);   // scrolls element `index` if off-screen
        await sleep(180);                  // let the scroll settle
        const els = await collectEls(tab.id);
        if (els[index]) { x = els[index].x; y = els[index].y; }
      }
      await moveWithHoverTrail(tab.id, x, y);
      // Re-resolve the LIVE position after the cursor animation — immune to
      // reflow during the move (banner, lazy content, animations). This is
      // what makes the first click reliable.
      if (hasIndex) {
        const els = await collectEls(tab.id);
        const live = els[index];
        if (live) {
          x = live.x; y = live.y;
          try {
            await chrome.tabs.sendMessage(tab.id, { type: "placeCursor", x, y });
          } catch (_) { /* content script may be reloading */ }
        }
      }
      await chrome.tabs.sendMessage(tab.id, { type: "clickPulse" });
      await cdp(tab.id, "Input.dispatchMouseEvent", {
        type: "mousePressed", x, y, button: "left", clickCount: 1,
      });
      await cdp(tab.id, "Input.dispatchMouseEvent", {
        type: "mouseReleased", x, y, button: "left", clickCount: 1,
      });
      lastCursor = { x, y };
      return `Clicked at (${x}, ${y})`;
    }

    case "type_text": {
      const text = p.text || "";
      await typeChars(tab.id, text);
      return `Typed ${text.length} chars`;
    }

    case "fill_element": {
      // Focus + select-all inside the page, then type over the selection with
      // real key events (so frameworks see genuine, trusted input).
      await ensureDebugger(tab.id);
      await collectEls(tab.id, p.index); // refresh cache + scroll into view
      await sleep(120);
      const [res] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        args: [p.index],
        func: (index) => {
          const el = (window.__otterEls || [])[index];
          if (!el) {
            return { ok: false, error: `No element with index ${index}. Call read_elements first.` };
          }
          el.focus();
          if (typeof el.select === "function") el.select();
          else if (el.isContentEditable) {
            const r = document.createRange();
            r.selectNodeContents(el);
            const sel = getSelection();
            sel.removeAllRanges();
            sel.addRange(r);
          }
          return { ok: true, tag: el.tagName.toLowerCase() };
        },
      });
      const info = res.result;
      if (!info.ok) throw new Error(info.error);
      const text = p.text || "";
      if (text) {
        await typeChars(tab.id, text);
        return `Filled element ${p.index} (${info.tag}) with ${text.length} chars`;
      }
      // Empty text = clear: delete the selected content.
      await cdp(tab.id, "Input.dispatchKeyEvent", {
        type: "keyDown", key: "Backspace", windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8,
      });
      await cdp(tab.id, "Input.dispatchKeyEvent", {
        type: "keyUp", key: "Backspace", windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8,
      });
      return `Cleared element ${p.index} (${info.tag})`;
    }

    case "select_option": {
      // Native <select> dropdowns can't be driven by synthetic clicks; set the
      // value in-page and fire the events frameworks listen for.
      await collectEls(tab.id); // refresh the element cache
      const [res] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        args: [p.index, p.value ?? null, p.label ?? null],
        func: (index, value, label) => {
          const el = (window.__otterEls || [])[index];
          if (!el) {
            return { ok: false, error: `No element with index ${index}. Call read_elements first.` };
          }
          if (el.tagName !== "SELECT") {
            return { ok: false, error: `Element ${index} is a <${el.tagName.toLowerCase()}>, not a <select>.` };
          }
          const opts = [...el.options];
          const norm = (s) => (s || "").trim().toLowerCase();
          let opt = null;
          if (value != null) opt = opts.find((o) => o.value === value);
          if (!opt && label != null) opt = opts.find((o) => norm(o.text) === norm(label));
          if (!opt && label != null) opt = opts.find((o) => norm(o.text).includes(norm(label)));
          if (!opt) {
            return {
              ok: false,
              error: "No option matches.",
              options: opts.slice(0, 30).map((o) => ({ value: o.value, label: o.text.trim() })),
            };
          }
          el.value = opt.value;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          return { ok: true, selected: { value: opt.value, label: opt.text.trim() } };
        },
      });
      const r = res.result;
      if (!r.ok) {
        throw new Error(r.error + (r.options ? ` Available options: ${JSON.stringify(r.options)}` : ""));
      }
      return `Selected '${r.selected.label}' (value=${r.selected.value}) in element ${p.index}`;
    }

    case "hover": {
      // click() minus the press/release: animated glide + real mouseMoved so
      // :hover styles and JS mouseover handlers genuinely trigger.
      let { x, y, index } = p;
      const firstAttach = !attached.has(tab.id);
      await ensureDebugger(tab.id);
      if (firstAttach) await sleep(200);
      if (index !== undefined && index !== null) {
        await collectEls(tab.id, index); // scrolls it into view if needed
        await sleep(180);
        const els = await collectEls(tab.id);
        if (!els[index]) throw new Error(`No interactive element with index ${index}. Call read_elements first.`);
        x = els[index].x;
        y = els[index].y;
      }
      await moveWithHoverTrail(tab.id, x, y);
      await cdp(tab.id, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      lastCursor = { x, y };
      return `Hovering at (${x}, ${y})`;
    }

    case "drag": {
      // Mouse-event drag: press at the start point, glide with buttons held,
      // release at the end. Drives sliders, sortable lists, canvas tools.
      // (HTML5 draggable="true" native DnD may not respond to synthetic events.)
      const { fromX, fromY, toX, toY } = p;
      const firstAttach = !attached.has(tab.id);
      await ensureDebugger(tab.id);
      if (firstAttach) await sleep(200);
      await moveWithHoverTrail(tab.id, fromX, fromY);
      await chrome.tabs.sendMessage(tab.id, { type: "clickPulse" });
      await cdp(tab.id, "Input.dispatchMouseEvent", {
        type: "mousePressed", x: fromX, y: fromY, button: "left", clickCount: 1,
      });
      const pts = await chrome.tabs.sendMessage(tab.id, {
        type: "moveCursor", x: toX, y: toY, samples: S.trailSamples,
      });
      for (const pt of pts.path) {
        await cdp(tab.id, "Input.dispatchMouseEvent", {
          type: "mouseMoved", x: pt.x, y: pt.y, button: "left", buttons: 1,
        });
      }
      await cdp(tab.id, "Input.dispatchMouseEvent", {
        type: "mouseReleased", x: toX, y: toY, button: "left", clickCount: 1,
      });
      lastCursor = { x: toX, y: toY };
      return `Dragged (${fromX}, ${fromY}) → (${toX}, ${toY})`;
    }

    case "find_text": {
      const [res] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        args: [p.query, p.scroll !== false, p.nth || 0],
        func: (query, scroll, nth) => {
          const q = query.toLowerCase();
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          const found = []; // { node, ix, context } — internal, holds live nodes
          let node;
          while ((node = walker.nextNode()) && found.length < 50) {
            const t = node.textContent;
            const tl = t.toLowerCase();
            let ix = tl.indexOf(q);
            while (ix !== -1 && found.length < 50) {
              const range = document.createRange();
              range.setStart(node, ix);
              range.setEnd(node, ix + query.length);
              const r = range.getBoundingClientRect();
              if (r.width || r.height) { // zero rect = display:none / detached
                found.push({
                  node, ix,
                  context: t.slice(Math.max(0, ix - 60), ix + query.length + 60).trim(),
                });
              }
              ix = tl.indexOf(q, ix + 1);
            }
          }
          if (!found.length) return { count: 0, matches: [] };
          if (scroll) {
            const el = found[Math.min(nth, found.length - 1)].node.parentElement;
            if (el) el.scrollIntoView({ block: "center" });
          }
          // Rects are recomputed AFTER the scroll so coordinates are current.
          const matches = found.map((m, i) => {
            const range = document.createRange();
            range.setStart(m.node, m.ix);
            range.setEnd(m.node, m.ix + query.length);
            const r = range.getBoundingClientRect();
            return {
              nth: i,
              x: Math.round(r.x + r.width / 2),
              y: Math.round(r.y + r.height / 2),
              visible: r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth,
              context: m.context,
            };
          });
          return { count: matches.length, matches };
        },
      });
      return res.result;
    }

    case "wait_for": {
      const timeout = Math.min(Math.max(p.timeoutMs || 10000, 100), 60000);
      const started = Date.now();
      const deadline = started + timeout;
      for (;;) {
        let res = null;
        try {
          [res] = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            args: [p.text ?? null, p.selector ?? null],
            func: (text, selector) => {
              const textOk =
                text == null ||
                document.body.innerText.toLowerCase().includes(text.toLowerCase());
              let selOk = true;
              if (selector != null) {
                try { selOk = !!document.querySelector(selector); }
                catch (_) { return { invalidSelector: true }; }
              }
              return { found: textOk && selOk };
            },
          });
        } catch (_) { /* mid-navigation: frame briefly not scriptable — retry */ }
        if (res && res.result && res.result.invalidSelector) {
          throw new Error(`Invalid CSS selector: ${p.selector}`);
        }
        if (res && res.result && res.result.found) {
          return { found: true, elapsed_ms: Date.now() - started };
        }
        if (Date.now() >= deadline) {
          return { found: false, elapsed_ms: Date.now() - started, timeout_ms: timeout };
        }
        await sleep(300);
      }
    }

    case "press_key": {
      // e.g. Enter, Tab, Escape
      const key = p.key;
      await cdp(tab.id, "Input.dispatchKeyEvent", { type: "keyDown", key });
      await cdp(tab.id, "Input.dispatchKeyEvent", { type: "keyUp", key });
      return `Pressed ${key}`;
    }

    case "scroll": {
      // Variable increments read more naturally than fixed jumps. Distance and
      // whether to jitter are settings-driven; an explicit deltaY still wins.
      const amount = OtterConfig.scrollAmount(S, p.deltaY, Math.random);
      await cdp(tab.id, "Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: p.x ?? 400, y: p.y ?? 300,
        deltaX: 0, deltaY: Math.round(amount),
      });
      return "Scrolled";
    }

    case "screenshot": {
      // CDP Page.captureScreenshot (NOT chrome.tabs.captureVisibleTab) so we can
      // capture BACKGROUND tabs too — essential for parallel agents, each
      // screenshotting its own tab without stealing focus. Like captureVisibleTab
      // it grabs the viewport at PHYSICAL pixels (CSS size x devicePixelRatio);
      // we scale back down to CSS pixels in an OffscreenCanvas so coordinates
      // read off the image map 1:1 to the CSS viewport coords click() expects.
      await ensureDebugger(tab.id);
      const [meta] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => ({
          w: window.innerWidth,
          h: window.innerHeight,
          dpr: window.devicePixelRatio,
        }),
      });
      const { w, h, dpr } = meta.result;
      // Full-page mode: clip to the document's content box. Height is capped —
      // an endless-feed page would otherwise blow past canvas size limits and
      // the bridge's 32 MiB frame cap.
      let outW = w, outH = h;
      const capParams = { format: "jpeg", quality: 80 };
      if (p.fullPage) {
        const lm = await cdp(tab.id, "Page.getLayoutMetrics");
        const size = lm.cssContentSize || lm.contentSize;
        outW = Math.max(1, Math.round(size.width));
        outH = Math.max(1, Math.min(Math.round(size.height), 8000));
        capParams.clip = { x: 0, y: 0, width: outW, height: outH, scale: 1 };
        capParams.captureBeyondViewport = true;
      }
      // JPEG q80: ~5-10x smaller than PNG on photo-heavy pages.
      const cap = await cdp(tab.id, "Page.captureScreenshot", capParams);
      const bitmap = await createImageBitmap(
        await (await fetch(`data:image/jpeg;base64,${cap.data}`)).blob(),
      );
      const canvas = new OffscreenCanvas(outW, outH);
      canvas.getContext("2d").drawImage(bitmap, 0, 0, outW, outH);
      const buf = await (await canvas.convertToBlob({
        type: "image/jpeg", quality: 0.8,
      })).arrayBuffer();
      const bytes = new Uint8Array(buf);
      let binary = "";
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      // capturedWidth/Height = native (physical) capture; width/height = CSS
      // size the image is scaled to. Diagnostic for the coordinate drift.
      return {
        base64: btoa(binary), format: "jpeg",
        width: outW, height: outH, dpr, fullPage: !!p.fullPage,
        capturedWidth: bitmap.width, capturedHeight: bitmap.height,
      };
    }

    case "read_console": {
      // Attaching now starts capture; Runtime.enable also replays the page's
      // recent console history, so even a first read returns something.
      const wasAttached = attached.has(tab.id);
      await ensureDebugger(tab.id);
      if (!wasAttached) await sleep(300); // let the replayed events land
      let out = consoleBuf.get(tab.id) || [];
      if (p.level) out = out.filter((e) => e.level === p.level);
      const limit = Math.min(Math.max(p.limit || 50, 1), CONSOLE_CAP);
      out = out.slice(-limit);
      if (p.clear) consoleBuf.set(tab.id, []);
      return {
        count: out.length,
        entries: out,
        note: wasAttached ? undefined :
          "Capture just started (plus replayed recent history). Reload the tab to capture a full page load.",
      };
    }

    case "read_network": {
      const wasAttached = attached.has(tab.id);
      await ensureDebugger(tab.id);
      if (!wasAttached) await sleep(300);
      const buf = networkBuf.get(tab.id);
      let out = buf ? [...buf.values()] : [];
      if (p.filter) {
        const f = p.filter.toLowerCase();
        out = out.filter(
          (e) => e.url.toLowerCase().includes(f) || (e.type || "").toLowerCase() === f,
        );
      }
      const limit = Math.min(Math.max(p.limit || 50, 1), NETWORK_CAP);
      out = out.slice(-limit);
      if (p.clear) networkBuf.delete(tab.id);
      return {
        count: out.length,
        requests: out,
        note: wasAttached ? undefined :
          "Network capture just started; only requests from now on appear. Reload the tab to capture a full page load.",
      };
    }

    case "get_network_body": {
      await ensureDebugger(tab.id);
      // Throws "No resource with given identifier" if Chrome evicted the body.
      const res = await cdp(tab.id, "Network.getResponseBody", { requestId: p.requestId });
      const MAX = 50000;
      return {
        base64Encoded: res.base64Encoded,
        total_chars: res.body.length,
        truncated: res.body.length > MAX,
        body: res.body.slice(0, MAX),
      };
    }

    case "evaluate_js": {
      // Hard-gated by the options-page toggle (off by default); the server
      // additionally asks the user for approval on every call.
      if (!S.allowJsEval) {
        throw new Error(
          "JavaScript evaluation is disabled. Enable 'Allow evaluate_js' in the " +
          "Otter extension options (right-click the extension icon → Options → Advanced).",
        );
      }
      await ensureDebugger(tab.id);
      const res = await cdp(tab.id, "Runtime.evaluate", {
        expression: p.code,
        returnByValue: true,
        awaitPromise: true,
        userGesture: true,
      });
      if (res.exceptionDetails) {
        const d = res.exceptionDetails;
        const msg =
          (d.exception && (d.exception.description || d.exception.value)) || d.text;
        throw new Error(`Page JS threw: ${String(msg).slice(0, 1000)}`);
      }
      const r = res.result || {};
      const raw =
        r.value !== undefined
          ? (typeof r.value === "string" ? r.value : JSON.stringify(r.value))
          : (r.description || r.type || "undefined");
      const MAX = 20000;
      return {
        type: r.type,
        result: String(raw).slice(0, MAX),
        truncated: String(raw).length > MAX,
      };
    }

    default:
      throw new Error(`Unknown action: ${action}`);
  }
}

function waitForLoad(tabId, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const timer = setTimeout(done, timeoutMs);
    function listener(id, info) {
      if (id === tabId && info.status === "complete") done();
    }
    function done() {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// Re-inject cursor position after navigation (content scripts die on nav).
let lastCursor = { x: 40, y: 40 };
chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (info.status !== "complete") return;
  // Respect the cursor visibility setting:
  //   off / disabled -> never restore
  //   always         -> restore on every navigation
  //   active         -> only if the agent acted recently (default; otherwise
  //                     the user's own browsing would keep re-showing it)
  if (!S.cursorEnabled || S.cursorVisibility === "off") return;
  const withinWindow = Date.now() - lastAgentActivity < CURSOR_ACTIVE_WINDOW_MS;
  if (S.cursorVisibility === "active" && !withinWindow) return;
  {
    try {
      await chrome.tabs.sendMessage(tabId, {
        type: "placeCursor", ...lastCursor,
      });
    } catch (_) { /* content script not ready / not injectable page */ }
  }
});
