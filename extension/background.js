// config.js defines OtterConfig (shared DEFAULTS / PRESETS / helpers). Must be
// imported before anything reads settings.
importScripts("config.js");

// Live settings from chrome.storage.sync, refreshed whenever they change.
let S = OtterConfig.DEFAULTS;
const settingsReady = OtterConfig.load().then((s) => { S = s; reflectApprovalMode(); });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && changes[OtterConfig.KEY]) {
    S = OtterConfig.normalize(changes[OtterConfig.KEY].newValue);
    reflectApprovalMode();
  }
});

// Full Auto is visible at a glance on the toolbar icon, so it's never left on
// by accident.
function reflectApprovalMode() {
  const auto = S.approvalMode === "auto";
  chrome.action.setBadgeText({ text: auto ? "AUTO" : "" });
  if (auto) chrome.action.setBadgeBackgroundColor({ color: "#F24E07" });
}

// ===== WebSocket bridge =====
// Every MCP client (Claude Code, Claude Desktop, background sessions...) runs
// its own server process, each on the first free port of this range (must
// match BRIDGE_PORTS in server/src/index.ts). We hold one socket per port, so
// all of them drive this browser at once; each reply goes back on the socket
// its command arrived on.
const BRIDGE_PORTS = Array.from({ length: 10 }, (_, i) => 8765 + i);
const sockets = new Map(); // port -> WebSocket

function connectPort(port) {
  const sock = new WebSocket(`ws://localhost:${port}`);
  sockets.set(port, sock);
  sock.onopen = () => console.log(`[agent] connected to MCP bridge on :${port}`);
  sock.onmessage = async (e) => {
    const { id, action, params } = JSON.parse(e.data);
    let result = null, error = null;
    try {
      result = await handle(action, params || {});
    } catch (err) {
      error = err.message || String(err);
    }
    if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify({ id, result, error }));
  };
  sock.onclose = () => { if (sockets.get(port) === sock) sockets.delete(port); };
  sock.onerror = () => sock.close();
}

// Ports with no server just refuse the connection; they're retried each scan.
function scanBridges() {
  for (const port of BRIDGE_PORTS) {
    const s = sockets.get(port);
    if (!s || s.readyState === WebSocket.CLOSED) connectPort(port);
  }
}
scanBridges();
setInterval(scanBridges, 3000);

// MV3 service workers can be suspended; a periodic alarm keeps reconnection alive.
chrome.alarms.create("keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(scanBridges);

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

// ===== Multi-agent: one window + one tab group per agent =====
// Each MCP session (agent) works in its OWN Chrome window holding one colored,
// titled tab group, so it never mixes with the tabs the user is using. Every
// tab an agent gets goes through openAgentTab, and grouping is VERIFIED — a
// failed group is an error, never silently skipped.
//
// The registry lives in chrome.storage.session: MV3 suspends this worker when
// idle and wipes its globals, and agents must find their window again after.
const GROUP_COLORS = ["orange", "blue", "green", "purple", "cyan", "pink", "yellow", "red", "grey"];
let agents = {};   // agentId -> { windowId, groupId, label, color }
let agentSeq = 0;  // numbers agent labels across ALL connected servers
const agentsReady = chrome.storage.session.get(["agents", "agentSeq"]).then((r) => {
  agents = r.agents || {};
  agentSeq = r.agentSeq || 0;
});
const saveAgents = () => chrome.storage.session.set({ agents, agentSeq }).catch(() => {});

// Serialize window/group work per agent: two concurrent open_tab calls must not
// each create a window.
const agentLocks = new Map();
function withAgentLock(agentId, fn) {
  const run = (agentLocks.get(agentId) || Promise.resolve()).then(fn, fn);
  agentLocks.set(agentId, run.catch(() => {}));
  return run;
}

function agentRecord(agentId, clientName) {
  let ag = agents[agentId];
  if (!ag) {
    const n = ++agentSeq;
    ag = agents[agentId] = {
      windowId: null,
      groupId: null,
      label: `Otter · ${clientName || "agent"} ${n}`,
      color: GROUP_COLORS[(n - 1) % GROUP_COLORS.length],
    };
  }
  return ag;
}

// Which agent (if any) owns a tab: anything in its window or its group.
function ownerOf(tab) {
  for (const [id, ag] of Object.entries(agents)) {
    if (tab.windowId === ag.windowId) return id;
    if (ag.groupId != null && tab.groupId === ag.groupId) return id;
  }
  return null;
}

// Put tabId into the agent's group, recreating the group if Chrome dropped it
// (a group vanishes when its last tab closes). Retries cover Chrome's transient
// "Tabs cannot be edited right now (user may be dragging a tab)" refusal.
async function groupIntoAgent(ag, tabId) {
  let lastErr = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      if (ag.groupId != null) {
        try { await chrome.tabGroups.get(ag.groupId); } catch (_) { ag.groupId = null; }
      }
      if (ag.groupId != null) {
        await chrome.tabs.group({ groupId: ag.groupId, tabIds: [tabId] });
      } else {
        ag.groupId = await chrome.tabs.group({
          tabIds: [tabId], createProperties: { windowId: ag.windowId },
        });
      }
      await chrome.tabGroups.update(ag.groupId, { title: ag.label, color: ag.color });
      const t = await chrome.tabs.get(tabId);
      if (t.groupId === ag.groupId) return;
      lastErr = new Error("tab did not land in the group");
    } catch (e) {
      lastErr = e;
    }
    await sleep(150 * (attempt + 1));
  }
  throw new Error(`Could not put tab ${tabId} into the agent's tab group: ${lastErr && lastErr.message}`);
}

async function windowAlive(windowId) {
  if (windowId == null) return false;
  try { await chrome.windows.get(windowId); return true; } catch (_) { return false; }
}

// Open a tab for an agent: in its window (created unfocused on first use, so it
// doesn't grab the user's keyboard) and in its group.
async function openAgentTab(agentId, clientName, url) {
  await agentsReady;
  return withAgentLock(agentId, async () => {
    const ag = agentRecord(agentId, clientName);
    let tab;
    if (await windowAlive(ag.windowId)) {
      tab = await chrome.tabs.create({ windowId: ag.windowId, url: url || "about:blank", active: true });
    } else {
      const win = await chrome.windows.create({
        url: url || "about:blank", focused: false, type: "normal",
      });
      ag.windowId = win.id;
      ag.groupId = null;
      tab = win.tabs[0];
    }
    await groupIntoAgent(ag, tab.id);
    await saveAgents();
    return { tab, ag };
  });
}

// Keep the registry honest as the user closes windows / groups.
chrome.windows.onRemoved.addListener(async (windowId) => {
  await agentsReady;
  let changed = false;
  for (const ag of Object.values(agents)) {
    if (ag.windowId === windowId) { ag.windowId = null; ag.groupId = null; changed = true; }
  }
  if (changed) saveAgents();
});
chrome.tabGroups.onRemoved.addListener(async (group) => {
  await agentsReady;
  let changed = false;
  for (const ag of Object.values(agents)) {
    if (ag.groupId === group.id) { ag.groupId = null; changed = true; }
  }
  if (changed) saveAgents();
});

// Tabs the PAGE opens in an agent window (target=_blank, window.open) join the
// agent's group too, so nothing in the window is left ungrouped.
async function adoptIntoAgentGroup(tabId, windowId) {
  await agentsReady;
  const entry = Object.entries(agents).find(([, ag]) => ag.windowId === windowId);
  if (!entry) return;
  const [agentId, ag] = entry;
  await sleep(100); // let Chrome's own opener-grouping settle first
  try {
    const t = await chrome.tabs.get(tabId);
    if (ag.groupId != null && t.groupId === ag.groupId) return;
    await withAgentLock(agentId, () => groupIntoAgent(ag, tabId).then(saveAgents));
  } catch (_) { /* tab already closed */ }
}
chrome.tabs.onCreated.addListener((tab) => adoptIntoAgentGroup(tab.id, tab.windowId));
chrome.tabs.onAttached.addListener((tabId, info) => adoptIntoAgentGroup(tabId, info.newWindowId));

// The window the user last focused that ISN'T an agent's — get_user_tab's answer.
let lastUserWindowId = null;
chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  await agentsReady;
  if (!Object.values(agents).some((ag) => ag.windowId === windowId)) lastUserWindowId = windowId;
});

async function userTab() {
  await agentsReady;
  const isAgentWin = (id) => Object.values(agents).some((ag) => ag.windowId === id);
  let winId = lastUserWindowId;
  if (winId == null || isAgentWin(winId) || !(await windowAlive(winId))) {
    const wins = await chrome.windows.getAll({ windowTypes: ["normal"] });
    const mine = wins.filter((w) => !isAgentWin(w.id));
    const pick = mine.find((w) => w.focused) || mine[0];
    if (!pick) throw new Error("No user browser window found.");
    winId = pick.id;
  }
  const [t] = await chrome.tabs.query({ active: true, windowId: winId });
  if (!t) throw new Error("The user's window has no active tab.");
  return { tabId: t.id, title: t.title, url: t.url, readOnly: true };
}

// Resolve which tab a command targets: explicit params.tabId, else the active
// tab (legacy single-tab behavior for clients that send no agentId; current
// servers always send both).
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
// "thinking" pause are settings-driven. fast=true (script replay) drops the
// inter-key delay entirely — still real trusted key events, just back-to-back.
async function typeChars(tabId, text, fast) {
  for (const ch of text) {
    await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyDown", text: ch });
    await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyUp", text: ch });
    if (!fast) await sleep(OtterConfig.typeDelay(S, Math.random));
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

// Topmost interactive element at (x, y): its text + tag, or null if nothing is
// there. Shared by the hit_test action and the click gate's identity check.
async function hitTestAt(tabId, x, y) {
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    args: [x, y],
    func: (x, y) => {
      const hit = document.elementFromPoint(x, y);
      if (!hit) return null;
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

  // The user's switch, read by the server on every approval gate.
  if (action === "get_approval_mode") {
    await settingsReady;
    return { mode: S.approvalMode === "auto" ? "auto" : "ask" };
  }

  // ----- Multi-tab management (no pre-existing active tab required) -----
  if (action === "open_tab") {
    const { tab: created, ag } = await openAgentTab(p.agentId, p.clientName, p.url);
    // Attach CDP immediately (not lazily on first click) so console/network
    // capture covers the page load. Best-effort: chrome:// pages can't attach.
    try { await ensureDebugger(created.id); } catch (_) {}
    if (p.url) await waitForLoad(created.id);
    const fresh = await chrome.tabs.get(created.id);
    return {
      tabId: created.id, url: fresh.url, title: fresh.title,
      windowId: ag.windowId, groupId: ag.groupId, label: ag.label,
    };
  }
  if (action === "list_tabs") {
    await agentsReady;
    const ag = agents[p.agentId];
    const tabs = ag && (await windowAlive(ag.windowId))
      ? await chrome.tabs.query({ windowId: ag.windowId })
      : [];
    return tabs.map((t) => ({ tabId: t.id, title: t.title, url: t.url, active: t.active }));
  }
  if (action === "close_tab") {
    await agentsReady;
    let t;
    try { t = await chrome.tabs.get(p.tabId); } catch (_) { return { closed: p.tabId }; }
    if (p.agentId && ownerOf(t) !== p.agentId) {
      throw new Error(`Tab ${p.tabId} isn't in this session's window; only the session's own tabs can be closed.`);
    }
    await chrome.tabs.remove(p.tabId);
    return { closed: p.tabId };
  }
  if (action === "user_tab") {
    return userTab();
  }

  lastAgentActivity = Date.now();
  await agentsReady;
  const tab = await resolveTab(p);
  // Agents act only inside their own window. Any other tab — the user's, or
  // another agent's — is read-only: these actions observe without changing the
  // page (find_text's scroll is forced off below; screenshot avoids the
  // debugger there).
  const owned = !p.agentId || ownerOf(tab) === p.agentId;
  const READ_ONLY = new Set([
    "read_page", "read_elements", "find_text", "wait_for", "screenshot",
    "hit_test", "locate_element", "resolve_element",
  ]);
  if (!owned) {
    if (!READ_ONLY.has(action)) {
      throw new Error(
        `Tab ${tab.id} isn't in this session's window, so it is read-only ` +
        `(read_page, read_elements, find_text, wait_for, screenshot). To work ` +
        `with that page, open_tab its URL in the session's own window.`,
      );
    }
    p = { ...p, scroll: false, readOnly: true };
  }
  // Bring the agent's tab to the front of ITS OWN window on visible actions so
  // the user can watch. Activating a tab never focuses its window, so this
  // can't steal focus from the user's window or from other agents (each has
  // its own window). screenshot is excluded (CDP capture needs no focus).
  const VISIBLE = new Set([
    "navigate", "go_back", "go_forward", "reload",
    "click", "fill_element", "select_option", "hover", "drag",
    "type_text", "press_key", "scroll",
  ]);
  // p.background suppresses the activation: script replays meant to run
  // silently must not even switch tabs inside the agent window.
  if (owned && p.tabId != null && VISIBLE.has(action) && !p.background && !tab.active) {
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
      return (await hitTestAt(tab.id, p.x, p.y)) || { text: "", tag: "" };
    }

    case "locate_element": {
      // Resolve a read_elements index to its exact center INSIDE the page.
      const els = await collectEls(tab.id);
      const el = els[p.index];
      return el ? { found: true, text: el.text, x: el.x, y: el.y }
                : { found: false };
    }

    case "resolve_element": {
      // Resolve a DURABLE element descriptor — CSS selector and/or visible
      // text (+ optional tag filter, nth pick) — to a live index in the
      // current collectInteractiveEls ordering. This is what makes recorded
      // scripts replayable across sessions: indices shift between visits,
      // selectors and labels don't. The returned index feeds straight into
      // the existing click / fill_element / select_option paths (same cache).
      await collectEls(tab.id); // refresh window.__otterEls
      const [res] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        args: [p.selector ?? null, p.text ?? null, p.tag ?? null, p.nth || 0],
        func: (selector, text, tag, nth) => {
          const els = window.__otterEls || [];
          const labelOf = (el) => (el.innerText || el.value || el.placeholder ||
            el.getAttribute("aria-label") || el.title || "").trim();
          let candidates;
          if (selector) {
            let matched;
            try { matched = [...document.querySelectorAll(selector)]; }
            catch (_) { return { found: false, error: `Invalid CSS selector: ${selector}` }; }
            candidates = [];
            for (const m of matched) {
              // The selector may hit the interactive element itself, a wrapper
              // around it, or a node inside it — accept all three.
              let ix = els.indexOf(m);
              if (ix === -1) ix = els.findIndex((el) => el.contains(m) || m.contains(el));
              if (ix !== -1 && !candidates.includes(ix)) candidates.push(ix);
            }
          } else {
            candidates = els.map((_, i) => i);
          }
          if (tag) {
            const t = tag.toLowerCase();
            candidates = candidates.filter((i) => els[i].tagName.toLowerCase() === t);
          }
          if (text != null && text !== "") {
            const q = text.trim().toLowerCase();
            const labels = new Map(candidates.map((i) => [i, labelOf(els[i]).toLowerCase()]));
            // Exact match beats prefix beats substring — never mix tiers, so
            // 'Log' resolves to the 'Log' button, not 'Log out'.
            let hits = candidates.filter((i) => labels.get(i) === q);
            if (!hits.length) hits = candidates.filter((i) => labels.get(i).startsWith(q));
            if (!hits.length) hits = candidates.filter((i) => labels.get(i).includes(q));
            candidates = hits;
          }
          if (!candidates.length) return { found: false };
          const pick = candidates[Math.min(nth, candidates.length - 1)];
          const el = els[pick];
          const r = el.getBoundingClientRect();
          return {
            found: true, index: pick, matches: candidates.length,
            text: labelOf(el).slice(0, 80), tag: el.tagName.toLowerCase(),
            x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2),
          };
        },
      });
      if (res.result && res.result.error) throw new Error(res.result.error);
      return res.result || { found: false };
    }

    case "click": {
      // p: { x, y, index?, expectText? } in CSS viewport coordinates.
      // expectText, when present, is the text the SERVER ran the destructive-
      // action gate against. We re-resolve the live target one last time right
      // before pressing and REFUSE to press if it no longer matches, returning
      // { changed } so the server can re-gate. Without this, a reflow between
      // the server's gate and this press (a collapsing menu, lazy content, an
      // async re-render) would let an approved-safe element be swapped for an
      // ungated destructive one. See test/gate-bypass.mjs.
      let { x, y, index } = p;
      const hasIndex = index !== undefined && index !== null;
      const guard = p.expectText !== undefined && p.expectText !== null;
      const expectText = p.expectText || "";
      // The first CDP attach shows the "being debugged" banner, which reflows
      // the page. Attach up-front and let it settle before measuring/clicking.
      const firstAttach = !attached.has(tab.id);
      await ensureDebugger(tab.id);
      if (firstAttach) await sleep(200);
      // Scroll the target into view if it's below/above the fold (CDP clicks
      // only register inside the visible viewport), then take fresh coords.
      if (hasIndex) {
        await collectEls(tab.id, index);   // scrolls element `index` if off-screen
        await sleep(p.fast ? 60 : 180);    // let the scroll settle
        const els = await collectEls(tab.id);
        if (els[index]) { x = els[index].x; y = els[index].y; }
      }
      if (p.fast) {
        // Script replay: no glide animation. Cursor jumps to the target and a
        // single real mouseMoved lands there so hover handlers still fire.
        try { await chrome.tabs.sendMessage(tab.id, { type: "placeCursor", x, y }); } catch (_) {}
        await cdp(tab.id, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      } else {
        await moveWithHoverTrail(tab.id, x, y);
      }
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

      // FINAL authoritative identity check, as late as possible before the
      // press: confirm the target is still the element the gate saw. Nothing is
      // awaited between this resolve and the CDP press below, so the residual
      // reflow window is a few ms of dispatch latency (inherent to coordinate-
      // based trusted clicks), not the ~1s cursor animation.
      if (guard) {
        const cur = hasIndex
          ? (await collectEls(tab.id))[index]
          : await hitTestAt(tab.id, x, y);
        const curText = (cur && (cur.text ?? "")) || "";
        if (!cur || curText !== expectText) {
          return {
            changed: true,
            actualText: cur ? curText : null,
            x: cur && hasIndex ? cur.x : x,
            y: cur && hasIndex ? cur.y : y,
          };
        }
        if (hasIndex) { x = cur.x; y = cur.y; }
      }

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
      await typeChars(tab.id, text, !!p.fast);
      return `Typed ${text.length} chars`;
    }

    case "fill_element": {
      // Focus + select-all inside the page, then type over the selection with
      // real key events (so frameworks see genuine, trusted input).
      await ensureDebugger(tab.id);
      await collectEls(tab.id, p.index); // refresh cache + scroll into view
      await sleep(p.fast ? 40 : 120);
      // TRANSACTIONAL fill. Apps that manage focus themselves (Google Sheets
      // and friends) can asynchronously steal it back at ANY point — even
      // between a passing focus check and the first keystroke — so no
      // pre-check is sufficient. Instead: focus + type, then VERIFY the text
      // actually arrived in the element (focus still there, or its value
      // changed). If the keystrokes were diverted, press Escape to cancel
      // whatever stray edit they may have opened elsewhere, and retry.
      const readState = (index) => {
        const el = (window.__otterEls || [])[index];
        if (!el) return { gone: true };
        const active = document.activeElement;
        return {
          focused: active === el || (active != null && el.contains(active)),
          value: el.value !== undefined ? el.value : (el.isContentEditable ? el.innerText : ""),
        };
      };
      const escapeKey = {
        key: "Escape", code: "Escape",
        windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27,
      };
      const text = p.text || "";
      let lastProblem = "";
      for (let attempt = 0; attempt < 3; attempt++) {
        const [res] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          args: [p.index],
          func: (index) => {
            const el = (window.__otterEls || [])[index];
            if (!el) {
              return { fatal: true, error: `No element with index ${index}. Call read_elements first.` };
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
            return {
              tag: el.tagName.toLowerCase(),
              value: el.value !== undefined ? el.value : (el.isContentEditable ? el.innerText : ""),
            };
          },
        });
        const info = res.result;
        if (info.fatal) throw new Error(info.error);

        if (!text) {
          // Empty text = clear: delete the selected content, verify it emptied.
          await cdp(tab.id, "Input.dispatchKeyEvent", {
            type: "keyDown", key: "Backspace", windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8,
          });
          await cdp(tab.id, "Input.dispatchKeyEvent", {
            type: "keyUp", key: "Backspace", windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8,
          });
          const [chk] = await chrome.scripting.executeScript({
            target: { tabId: tab.id }, args: [p.index], func: readState,
          });
          const st = chk.result;
          if (st.gone || st.focused || st.value !== info.value || info.value === "") {
            return `Cleared element ${p.index} (${info.tag})`;
          }
          lastProblem = "the clear keystroke was diverted by the page";
        } else {
          await typeChars(tab.id, text, !!p.fast);
          const [chk] = await chrome.scripting.executeScript({
            target: { tabId: tab.id }, args: [p.index], func: readState,
          });
          const st = chk.result;
          // Accept when focus survived the typing, or the element's content
          // demonstrably changed (covers apps that advance focus when done).
          if (st.gone || st.focused || st.value !== info.value) {
            return `Filled element ${p.index} (${info.tag}) with ${text.length} chars`;
          }
          lastProblem = "the keystrokes were diverted by the page";
        }
        // Diverted keystrokes may have opened an edit somewhere else (e.g. a
        // spreadsheet cell). Escape cancels it before we try again.
        await cdp(tab.id, "Input.dispatchKeyEvent", { type: "rawKeyDown", ...escapeKey });
        await cdp(tab.id, "Input.dispatchKeyEvent", { type: "keyUp", ...escapeKey });
        await sleep(200);
      }
      throw new Error(
        `fill_element ${p.index} failed after 3 attempts: ${lastProblem}. ` +
        `Any stray input was cancelled with Escape. Verify the page state and retry.`,
      );
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
      if (p.fast) {
        // Script replay: no animation, but still a REAL move sequence — drag
        // handlers (sliders, sortables) need intermediate mousemove events,
        // so interpolate a short linear path instead of teleporting.
        try { await chrome.tabs.sendMessage(tab.id, { type: "placeCursor", x: fromX, y: fromY }); } catch (_) {}
        await cdp(tab.id, "Input.dispatchMouseEvent", { type: "mouseMoved", x: fromX, y: fromY });
        await cdp(tab.id, "Input.dispatchMouseEvent", {
          type: "mousePressed", x: fromX, y: fromY, button: "left", clickCount: 1,
        });
        const STEPS = 8;
        for (let i = 1; i <= STEPS; i++) {
          const x = Math.round(fromX + ((toX - fromX) * i) / STEPS);
          const y = Math.round(fromY + ((toY - fromY) * i) / STEPS);
          await cdp(tab.id, "Input.dispatchMouseEvent", {
            type: "mouseMoved", x, y, button: "left", buttons: 1,
          });
        }
      } else {
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
      // e.g. Enter, Tab, Escape. Named keys need code + windowsVirtualKeyCode:
      // frameworks that check event.keyCode (Google apps among them) ignore a
      // dispatch that carries only the key name.
      const key = p.key;
      const NAMED = {
        Enter:      { code: "Enter",      vk: 13, text: "\r" },
        Tab:        { code: "Tab",        vk: 9 },
        Escape:     { code: "Escape",     vk: 27 },
        Backspace:  { code: "Backspace",  vk: 8 },
        Delete:     { code: "Delete",     vk: 46 },
        ArrowUp:    { code: "ArrowUp",    vk: 38 },
        ArrowDown:  { code: "ArrowDown",  vk: 40 },
        ArrowLeft:  { code: "ArrowLeft",  vk: 37 },
        ArrowRight: { code: "ArrowRight", vk: 39 },
        Home:       { code: "Home",       vk: 36 },
        End:        { code: "End",        vk: 35 },
        PageUp:     { code: "PageUp",     vk: 33 },
        PageDown:   { code: "PageDown",   vk: 34 },
        Space:      { key: " ", code: "Space", vk: 32, text: " " },
      };
      const m = NAMED[key];
      if (m) {
        const base = {
          key: m.key || key, code: m.code,
          windowsVirtualKeyCode: m.vk, nativeVirtualKeyCode: m.vk,
        };
        await cdp(tab.id, "Input.dispatchKeyEvent",
          m.text ? { type: "keyDown", ...base, text: m.text }
                 : { type: "rawKeyDown", ...base });
        await cdp(tab.id, "Input.dispatchKeyEvent", { type: "keyUp", ...base });
      } else if (key.length === 1) {
        // Printable character: text-based dispatch types it.
        await cdp(tab.id, "Input.dispatchKeyEvent", { type: "keyDown", text: key });
        await cdp(tab.id, "Input.dispatchKeyEvent", { type: "keyUp", text: key });
      } else {
        await cdp(tab.id, "Input.dispatchKeyEvent", { type: "keyDown", key });
        await cdp(tab.id, "Input.dispatchKeyEvent", { type: "keyUp", key });
      }
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
      //
      // The user's own (read-only) tab is the exception: attaching the debugger
      // there would put the "being debugged" banner on their tab, so use
      // captureVisibleTab instead — it only sees the active tab of a window,
      // which is exactly what get_user_tab returns.
      if (p.readOnly) {
        if (p.fullPage) throw new Error("full_page screenshots aren't available on the user's tab.");
        if (!tab.active) throw new Error(`Tab ${tab.id} is no longer the visible tab in the user's window; call get_user_tab again.`);
      } else {
        await ensureDebugger(tab.id);
      }
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
      const cap = p.readOnly
        ? {
            data: (await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 80 }))
              .replace(/^data:image\/jpeg;base64,/, ""),
          }
        : await cdp(tab.id, "Page.captureScreenshot", capParams);
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
chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.status !== "complete") return;
  // Only agent tabs get the cursor back; the user's own tabs never show it.
  await agentsReady;
  if (Object.keys(agents).length && !ownerOf(tab)) return;
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
