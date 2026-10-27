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
// by accident: a small fast-forward mark (▶▶) in the icon's corner — "runs
// on its own" — and the tooltip spells it out. Static on purpose: a pulsing
// dot reads as a recording light, and a text badge can't fit "AUTO".
const ACTION_TITLE = "Otter — Browser Control for AI";
const ICON_SIZES = [16, 32];
let autoIcon = null; // drawn once

async function drawAutoIcon() {
  const imageData = {};
  for (const s of ICON_SIZES) {
    const blob = await (await fetch(chrome.runtime.getURL(`icons/icon${s}.png`))).blob();
    const g = new OffscreenCanvas(s, s).getContext("2d");
    g.drawImage(await createImageBitmap(blob), 0, 0, s, s);
    // White rounded backing so the mark stays legible over the otter.
    const w = s * 0.66, h = s * 0.46, x = s - w, y = s - h, rad = h * 0.3;
    g.beginPath();
    g.roundRect(x, y, w, h, rad);
    g.fillStyle = "#FFFFFF";
    g.fill();
    // Two orange triangles: ▶▶
    const pad = h * 0.2, th = h - 2 * pad, tw = (w - 2 * pad) / 2;
    g.fillStyle = "#F24E07";
    for (let i = 0; i < 2; i++) {
      const tx = x + pad + i * tw;
      g.beginPath();
      g.moveTo(tx, y + pad);
      g.lineTo(tx + tw, y + pad + th / 2);
      g.lineTo(tx, y + pad + th);
      g.closePath();
      g.fill();
    }
    imageData[s] = g.getImageData(0, 0, s, s);
  }
  return imageData;
}

async function reflectApprovalMode() {
  const auto = S.approvalMode === "auto";
  chrome.action.setBadgeText({ text: "" });
  chrome.action.setTitle({
    title: auto ? `${ACTION_TITLE}
Full Auto is ON — no approval prompts` : ACTION_TITLE,
  });
  if (!auto) {
    chrome.action.setIcon({ path: Object.fromEntries(ICON_SIZES.map((s) => [s, `icons/icon${s}.png`])) });
    return;
  }
  try {
    autoIcon = autoIcon || (await drawAutoIcon());
    if (S.approvalMode === "auto") chrome.action.setIcon({ imageData: autoIcon });
  } catch (_) {
    chrome.action.setBadgeText({ text: "▶▶" }); // can't draw: fall back to a badge
    chrome.action.setBadgeBackgroundColor({ color: "#F24E07" });
  }
}

// ===== WebSocket bridge =====
// Every MCP client (Claude Code, Claude Desktop, background sessions...) runs
// its own server process. The server owning 8765 is the REGISTRY: the others
// register their own ports with it, and it sends us {type:"bridges", ports}.
// So we only ever dial 8765 plus ports we were told about — never empty ports,
// whose refused connections Chrome would log as extension errors. Each reply
// goes back on the socket its command arrived on.
const REGISTRY_PORT = 8765; // must match BASE_PORT in server/src/index.ts
const sockets = new Map(); // port -> WebSocket

function connectPort(port) {
  const sock = new WebSocket(`ws://localhost:${port}`);
  sockets.set(port, sock);
  sock.onopen = () => console.log(`[agent] connected to MCP bridge on :${port}`);
  sock.onmessage = async (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === "bridges") {
      for (const p of msg.ports || []) {
        const s = sockets.get(p);
        if (!s || s.readyState === WebSocket.CLOSED) connectPort(p);
      }
      return;
    }
    const { id, action, params } = msg;
    let result = null, error = null;
    try {
      result = await handle(action, params || {});
    } catch (err) {
      error = err.message || String(err);
    }
    if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify({ id, result, error }));
  };
  // Registered servers that go away stay gone; the registry lists them again
  // if they come back.
  sock.onclose = () => { if (sockets.get(port) === sock) sockets.delete(port); };
  sock.onerror = () => sock.close();
}

function scanBridges() {
  const s = sockets.get(REGISTRY_PORT);
  if (!s || s.readyState === WebSocket.CLOSED) connectPort(REGISTRY_PORT);
}
scanBridges();
setInterval(scanBridges, 3000);

// MV3 service workers can be suspended; a periodic alarm keeps reconnection alive.
chrome.alarms.create("keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(scanBridges);

// ===== Small helpers =====
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const IS_MAC = /Mac/.test(navigator.userAgent);
const hostOf = (url) => { try { return new URL(url).host || url; } catch (_) { return url; } };
// Frame label: host + path, so sibling frames on one site stay distinguishable.
const frameLabel = (url) => {
  try {
    const u = new URL(url);
    return clip(u.host ? u.host + (u.pathname === "/" ? "" : u.pathname) : url, 80);
  } catch (_) { return url; }
};
const clip = (s, n) => (s.length > n ? s.slice(0, n) + "…" : s);

// ===== CDP helpers =====
const attached = new Set();

const enableErrors = new Map(); // tabId -> ["Page.enable: ...", ...] (diagnostics)

async function ensureDebugger(tabId) {
  if (attached.has(tabId)) return;
  await chrome.debugger.attach({ tabId }, "1.3");
  attached.add(tabId);
  // Console/network capture and dialog detection ride along with every
  // attach. Best-effort: an enable failure must never block the action that
  // triggered the attach — but it's recorded (dialog_info reports it).
  const errs = [];
  for (const domain of ["Page", "Runtime", "Log", "Network"]) {
    try { await chrome.debugger.sendCommand({ tabId }, `${domain}.enable`); }
    catch (e) { errs.push(`${domain}.enable: ${e.message}`); }
  }
  enableErrors.set(tabId, errs);
}

chrome.debugger.onDetach.addListener(({ tabId }) => attached.delete(tabId));

// ===== Console + network capture (per-tab ring buffers) =====
// Filled by CDP events while a debugger is attached. Buffers survive a detach
// (the data stays readable); they're dropped when the tab closes.
const consoleBuf = new Map(); // tabId -> [{ ts, level, text, url?, source? }]
const networkBuf = new Map(); // tabId -> Map(requestId -> entry), insertion-ordered
const CONSOLE_CAP = 500, NETWORK_CAP = 300;

// ===== JavaScript dialogs (alert / confirm / prompt / beforeunload) =====
// An open dialog freezes the page: scripts, input and screenshots all stall
// until it's answered. We track them per tab (CDP Page events) so actions can
// report one instead of hanging into a timeout, and handle_dialog can answer.
const dialogs = new Map();       // tabId -> { type, message, defaultPrompt, url }
const dialogWaiters = new Map(); // tabId -> Set(callback)

function pushConsole(tabId, entry) {
  let buf = consoleBuf.get(tabId);
  if (!buf) consoleBuf.set(tabId, (buf = []));
  buf.push(entry);
  if (buf.length > CONSOLE_CAP) buf.splice(0, buf.length - CONSOLE_CAP);
}

chrome.debugger.onEvent.addListener(({ tabId }, method, params) => {
  if (tabId == null) return;
  if (method === "Page.javaScriptDialogOpening") {
    const d = {
      type: params.type, message: params.message || "",
      defaultPrompt: params.defaultPrompt || "", url: params.url,
    };
    dialogs.set(tabId, d);
    for (const cb of dialogWaiters.get(tabId) || []) cb(d);
  } else if (method === "Page.javaScriptDialogClosed") {
    dialogs.delete(tabId);
  } else if (method === "Runtime.consoleAPICalled") {
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
      startMs: Date.now(), // local clock, for wait_for(url) after an action
    });
    if (buf.size > NETWORK_CAP) buf.delete(buf.keys().next().value);
  } else if (method === "Network.responseReceived") {
    const e = (networkBuf.get(tabId) || new Map()).get(params.requestId);
    if (e) { e.status = params.response.status; e.mimeType = params.response.mimeType; }
  } else if (method === "Network.loadingFailed") {
    const e = (networkBuf.get(tabId) || new Map()).get(params.requestId);
    if (e) { e.error = params.errorText; e.doneMs = Date.now(); }
  } else if (method === "Network.loadingFinished") {
    const e = (networkBuf.get(tabId) || new Map()).get(params.requestId);
    if (e) { e.encodedBytes = Math.round(params.encodedDataLength); e.doneMs = Date.now(); }
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  consoleBuf.delete(tabId);
  networkBuf.delete(tabId);
  dialogs.delete(tabId);
  elementRefs.delete(tabId);
  childTabs.delete(tabId);
  lastActionTs.delete(tabId);
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
// The registry lives in chrome.storage.local: MV3 suspends this worker when
// idle (wiping its globals) and the extension may be reloaded, and an agent —
// whose id is stable across its client's reconnects — must find its window
// again instead of opening a new one. Entries whose window is gone are pruned
// at startup.
const GROUP_COLORS = ["orange", "blue", "green", "purple", "cyan", "pink", "yellow", "red", "grey"];
let agents = {};       // agentId -> { windowId, groupId, label, color }
let adoptedTabs = {};  // tabId -> agentId: popups an agent's page opened (own window)
let agentSeq = 0;      // numbers agent labels across ALL connected servers
const agentsReady = chrome.storage.local.get(["agents", "agentSeq", "adoptedTabs"]).then(async (r) => {
  agents = r.agents || {};
  agentSeq = r.agentSeq || 0;
  adoptedTabs = r.adoptedTabs || {};
  // Window ids don't survive a browser restart (and may be reused), so an
  // entry only stands if its window still holds a group with its label.
  for (const [id, ag] of Object.entries(agents)) {
    let ok = false;
    try {
      const groups = await chrome.tabGroups.query({ windowId: ag.windowId });
      const g = groups.find((x) => x.title === ag.label);
      if (g) { ag.groupId = g.id; ok = true; }
    } catch (_) {}
    if (!ok) delete agents[id];
  }
  for (const id of Object.keys(adoptedTabs)) {
    try { await chrome.tabs.get(Number(id)); } catch (_) { delete adoptedTabs[id]; }
    if (!agents[adoptedTabs[id]]) delete adoptedTabs[id];
  }
  if (!Object.keys(agents).length) agentSeq = 0; // labels restart at 1
  await chrome.storage.local.set({ agents, agentSeq, adoptedTabs });
});
const saveAgents = () =>
  chrome.storage.local.set({ agents, agentSeq, adoptedTabs }).catch(() => {});

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

// Which agent (if any) owns a tab: anything in its window or its group, plus
// popups its pages opened.
function ownerOf(tab) {
  const adopted = adoptedTabs[tab.id];
  if (adopted && agents[adopted]) return adopted;
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
// doesn't grab the user's keyboard) and in its group. reuse: an agent that
// already has a window (e.g. its client reconnected) continues in that
// window's current tab instead of opening another.
async function openAgentTab(agentId, clientName, url, reuse) {
  await agentsReady;
  return withAgentLock(agentId, async () => {
    const ag = agentRecord(agentId, clientName);
    let tab;
    const [current] = reuse && (await windowAlive(ag.windowId))
      ? await chrome.tabs.query({ windowId: ag.windowId, active: true })
      : [];
    if (current) {
      tab = current;
      if (url) await chrome.tabs.update(tab.id, { url });
    } else if (await windowAlive(ag.windowId)) {
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
chrome.tabs.onRemoved.addListener(async (tabId) => {
  await agentsReady;
  if (adoptedTabs[tabId]) { delete adoptedTabs[tabId]; saveAgents(); }
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

// Tabs opened BY a tab (window.open, target=_blank): remembered per opener so
// an action can report "opened a new tab", and popups an agent's page opens
// in their own window (e.g. "Sign in with Google") belong to that agent —
// otherwise they'd count as the user's and be read-only.
const childTabs = new Map(); // openerTabId -> [{ id, ts, popup }]
async function trackOpenedTab(tab) {
  if (tab.openerTabId == null) return;
  let popup = false;
  try { popup = (await chrome.windows.get(tab.windowId)).type === "popup"; } catch (_) {}
  const kids = childTabs.get(tab.openerTabId) || [];
  kids.push({ id: tab.id, ts: Date.now(), popup });
  childTabs.set(tab.openerTabId, kids.slice(-20));
  await agentsReady;
  let opener;
  try { opener = await chrome.tabs.get(tab.openerTabId); } catch (_) { return; }
  const owner = ownerOf(opener);
  if (owner && ownerOf(tab) !== owner) {
    adoptedTabs[tab.id] = owner;
    saveAgents();
    try { await ensureDebugger(tab.id); } catch (_) {} // dialogs + capture from the start
  }
}

chrome.tabs.onCreated.addListener((tab) => {
  adoptIntoAgentGroup(tab.id, tab.windowId);
  trackOpenedTab(tab);
});
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
// events along the same path so :hover states genuinely trigger. The content
// script is cosmetic: where it isn't running (tabs opened before an extension
// reload, data: URLs, some special pages) we fall back to a straight path and
// the input still happens.
let lastCursor = { x: 40, y: 40 };

function straightPath(from, to, n) {
  const pts = [];
  for (let i = 1; i <= n; i++) {
    pts.push({
      x: Math.round(from.x + ((to.x - from.x) * i) / n),
      y: Math.round(from.y + ((to.y - from.y) * i) / n),
    });
  }
  return pts;
}

async function cursorPath(tabId, x, y) {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: "moveCursor", x, y, samples: S.trailSamples });
    if (res && res.path) return res.path;
  } catch (_) {}
  return straightPath(lastCursor, { x, y }, S.trailSamples || 12);
}

async function moveWithHoverTrail(tabId, x, y) {
  for (const p of await cursorPath(tabId, x, y)) {
    await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: p.x, y: p.y });
  }
}

const placeCursor = (tabId, x, y) =>
  chrome.tabs.sendMessage(tabId, { type: "placeCursor", x, y }).catch(() => {});
const pulse = (tabId) =>
  chrome.tabs.sendMessage(tabId, { type: "clickPulse" }).catch(() => {});

// ===== Human-like typing (shared by type_text and fill_element) =====
// Per-character key events with jittered timing. Speed and the occasional
// "thinking" pause are settings-driven. fast=true (script replay, Fast mode)
// drops the inter-key delay entirely — still real trusted key events.
async function typeChars(tabId, text, fast) {
  for (const ch of text) {
    await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyDown", text: ch });
    await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyUp", text: ch });
    if (!fast) await sleep(OtterConfig.typeDelay(S, Math.random));
  }
}

// ===== Keys =====
// Named keys need code + windowsVirtualKeyCode: frameworks that check
// event.keyCode (Google apps among them) ignore a dispatch with the name only.
const NAMED_KEYS = {
  Enter: { code: "Enter", vk: 13, text: "\r" },
  Tab: { code: "Tab", vk: 9 },
  Escape: { code: "Escape", vk: 27 },
  Backspace: { code: "Backspace", vk: 8 },
  Delete: { code: "Delete", vk: 46 },
  Insert: { code: "Insert", vk: 45 },
  ArrowUp: { code: "ArrowUp", vk: 38 },
  ArrowDown: { code: "ArrowDown", vk: 40 },
  ArrowLeft: { code: "ArrowLeft", vk: 37 },
  ArrowRight: { code: "ArrowRight", vk: 39 },
  Home: { code: "Home", vk: 36 },
  End: { code: "End", vk: 35 },
  PageUp: { code: "PageUp", vk: 33 },
  PageDown: { code: "PageDown", vk: 34 },
  Space: { key: " ", code: "Space", vk: 32, text: " " },
  ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`F${i + 1}`, { code: `F${i + 1}`, vk: 112 + i }])),
};
const MODIFIERS = {
  Alt: { bit: 1, code: "AltLeft", vk: 18 },
  Control: { bit: 2, code: "ControlLeft", vk: 17 },
  Meta: { bit: 4, code: "MetaLeft", vk: 91 },
  Shift: { bit: 8, code: "ShiftLeft", vk: 16 },
};
const MOD_ALIASES = { ctrl: "Control", control: "Control", alt: "Alt", option: "Alt", shift: "Shift", meta: "Meta", cmd: "Meta", command: "Meta", win: "Meta" };

function keyInfo(name) {
  const named = NAMED_KEYS[name];
  if (named) return { key: named.key || name, code: named.code, vk: named.vk, text: named.text };
  if (name.length === 1) {
    const up = name.toUpperCase();
    if (/[A-Z]/.test(up)) return { key: name, code: `Key${up}`, vk: up.charCodeAt(0), text: name };
    if (/[0-9]/.test(name)) return { key: name, code: `Digit${name}`, vk: name.charCodeAt(0), text: name };
    return { key: name, text: name };
  }
  return { key: name };
}

// macOS routes editing shortcuts through the OS, so CDP needs the command
// spelled out there. Other platforms handle the key events themselves.
const MAC_COMMANDS = { a: "selectAll", c: "copy", v: "paste", x: "cut", z: "undo" };

// "Enter", "a", "Control+A", "Shift+Tab", "Control+Shift+P", "Meta+K"...
async function pressKey(tabId, combo) {
  const parts = combo === "+" ? ["+"] : combo.split("+").filter((s, i, a) => s !== "" || i === a.length - 1);
  const mainName = parts.pop() || "+";
  const mods = parts.map((m) => MOD_ALIASES[m.toLowerCase()] || m);
  for (const m of mods) if (!MODIFIERS[m]) throw new Error(`Unknown modifier '${m}'. Use Control, Shift, Alt or Meta.`);
  const bits = mods.reduce((b, m) => b | MODIFIERS[m].bit, 0);
  let held = 0;
  for (const m of mods) {
    held |= MODIFIERS[m].bit;
    await cdp(tabId, "Input.dispatchKeyEvent", {
      type: "rawKeyDown", key: m, code: MODIFIERS[m].code,
      windowsVirtualKeyCode: MODIFIERS[m].vk, nativeVirtualKeyCode: MODIFIERS[m].vk, modifiers: held,
    });
  }
  const k = keyInfo(mainName);
  const shiftOnly = (bits & ~8) === 0;
  let text = shiftOnly ? k.text : undefined; // Ctrl/Alt/Meta combos must not type
  let key = k.key;
  // Letters report the case a real keyboard would: 'a' for Control+A, 'A'
  // only with Shift held.
  if (/^[a-z]$/i.test(mainName) && mods.length) key = bits & 8 ? mainName.toUpperCase() : mainName.toLowerCase();
  if (text && bits & 8 && text.length === 1) { text = text.toUpperCase(); key = text; }
  const base = { key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk, modifiers: bits };
  const down = text ? { type: "keyDown", ...base, text } : { type: "rawKeyDown", ...base };
  if (IS_MAC && bits & 4 && MAC_COMMANDS[mainName.toLowerCase()]) {
    down.commands = [bits & 8 && mainName.toLowerCase() === "z" ? "redo" : MAC_COMMANDS[mainName.toLowerCase()]];
  }
  await cdp(tabId, "Input.dispatchKeyEvent", down);
  await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...base });
  for (const m of [...mods].reverse()) {
    held &= ~MODIFIERS[m].bit;
    await cdp(tabId, "Input.dispatchKeyEvent", {
      type: "keyUp", key: m, code: MODIFIERS[m].code,
      windowsVirtualKeyCode: MODIFIERS[m].vk, nativeVirtualKeyCode: MODIFIERS[m].vk, modifiers: held,
    });
  }
}

// ===== In-page library (page.js) across frames =====
// Every DOM operation goes through page.js, injected into all frames of the
// tab. Elements are addressed by a GLOBAL index (what read_elements shows)
// that maps to { frameId, local } — the frame and its own cached element.
const elementRefs = new Map(); // tabId -> [{ frameId, local }]
const lastActionTs = new Map(); // tabId -> ms; wait_for(url) watches from here

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === "loading") {
    elementRefs.delete(tabId); // new document
    suspectedDialog.delete(tabId);
  }
  // Re-subscribe to Page events after each navigation, in case Chrome dropped
  // the subscription with the old document (dialog events depend on it).
  if (info.status === "complete" && attached.has(tabId)) {
    chrome.debugger.sendCommand({ tabId }, "Page.enable").catch(() => {});
  }
});

// Chrome doesn't always report dialogs to an extension's debugger. Fallback:
// a dialog freezes the page's script engine, so a page that stops answering
// a trivial script right after an action almost certainly has one open.
const suspectedDialog = new Map(); // tabId -> true

async function pageResponsive(tabId, ms = 1000) {
  const probe = chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, func: () => 1 })
    .then(() => true, () => true); // an error (e.g. mid-navigation) isn't a freeze
  return Promise.race([probe, sleep(ms).then(() => false)]);
}

const FROZEN_NOTE =
  "The page stopped responding — most likely a JavaScript dialog (alert / confirm / prompt) " +
  "is open, which pauses the page. Answer it with handle_dialog(accept=true|false) " +
  "(its text couldn't be read).";

async function ensureLib(tabId) {
  await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ["page.js"] });
}

async function inFrames(tabId, func, args = []) {
  const res = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func, args });
  return res.map((r) => ({ frameId: r.frameId, result: r.result }));
}

// One frame; null when the frame (or its library) is gone.
async function inFrame(tabId, frameId, func, args = []) {
  try {
    const [r] = await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, func, args });
    return r ? r.result : null;
  } catch (_) {
    return null;
  }
}

// frameId -> top-left corner in top-viewport CSS pixels (+ viewport info).
// Single-frame pages cost one call; with iframes, page.js relays offsets down
// the frame tree by postMessage and we collect them.
async function frameOffsets(tabId) {
  const dims = (i) => ({ w: i.w, h: i.h, scrollX: i.scrollX, scrollY: i.scrollY, dpr: i.dpr, host: frameLabel(i.url), url: i.url });
  const info = await inFrames(tabId, () => (window.__otter ? window.__otter.frameInfo(null) : null));
  const map = new Map();
  const top = info.find((r) => r.frameId === 0);
  if (top && top.result) map.set(0, { x: 0, y: 0, ...dims(top.result) });
  const subs = info.filter((r) => r.frameId !== 0 && r.result);
  if (!subs.length) return map;
  const token = Math.random().toString(36).slice(2);
  await inFrame(tabId, 0, (t) => window.__otter && window.__otter.broadcast(t), [token]);
  for (let tries = 0; tries < 6; tries++) {
    await sleep(tries ? 40 : 15);
    const res = await inFrames(tabId, (t) => (window.__otter ? window.__otter.frameInfo(t) : null), [token]);
    let missing = 0;
    for (const r of res) {
      if (r.frameId === 0 || !r.result) continue;
      if (r.result.offset) map.set(r.frameId, { ...r.result.offset, ...dims(r.result) });
      else missing++;
    }
    if (!missing) break;
  }
  return map; // frames without an offset are hidden (zero-size) — left out
}

// Global, numbered list of interactive elements across all visible frames.
async function collectAll(tabId) {
  await ensureLib(tabId);
  const offsets = await frameOffsets(tabId);
  const res = await inFrames(tabId, () => (window.__otter ? window.__otter.collect() : null));
  const frames = res
    .filter((r) => Array.isArray(r.result) && offsets.has(r.frameId))
    .sort((a, b) => {
      if (a.frameId === 0) return -1;
      if (b.frameId === 0) return 1;
      const oa = offsets.get(a.frameId), ob = offsets.get(b.frameId);
      return oa.y - ob.y || oa.x - ob.x;
    });
  const top = offsets.get(0) || { w: Infinity, h: Infinity };
  const list = [], refs = [];
  for (const fr of frames) {
    const off = offsets.get(fr.frameId);
    fr.result.forEach((e, local) => {
      refs.push({ frameId: fr.frameId, local });
      const ent = { index: list.length, ...e, x: Math.round(e.x + off.x), y: Math.round(e.y + off.y) };
      if (fr.frameId !== 0) {
        ent.frame = off.host;
        if (ent.x < 0 || ent.y < 0 || ent.x >= top.w || ent.y >= top.h) ent.offscreen = true;
      }
      list.push(ent);
    });
  }
  elementRefs.set(tabId, refs);
  return { list, refs, offsets };
}

// Global index -> live ref. Uses the list the model last saw; if that element
// is gone (re-render, navigation), re-collects and takes the same index again
// (the click guard then confirms it's still the right element).
async function resolveRef(tabId, index) {
  let refs = elementRefs.get(tabId);
  if (refs && refs[index]) {
    const alive = await inFrame(tabId, refs[index].frameId,
      (i) => !!(window.__otter && window.__otter.rect(i)), [refs[index].local]);
    if (alive) return refs[index];
  }
  ({ refs } = await collectAll(tabId));
  return refs[index] || null;
}

// Live position of a ref: frame-local (lx, ly) and top-viewport (x, y, left, top).
async function refPos(tabId, ref) {
  const r = await inFrame(tabId, ref.frameId, (i) => (window.__otter ? window.__otter.rect(i) : null), [ref.local]);
  if (!r) return null;
  let off = { x: 0, y: 0 };
  if (ref.frameId !== 0) {
    off = (await frameOffsets(tabId)).get(ref.frameId);
    if (!off) return null;
  }
  return {
    ...r, lx: r.x, ly: r.y,
    x: Math.round(r.x + off.x), y: Math.round(r.y + off.y),
    left: r.left + off.x, top: r.top + off.y,
  };
}

// Topmost element at a top-viewport point, answered by the deepest frame that
// covers it — so the gate sees the "Pay" button inside a payment iframe, not
// the <iframe> element around it.
async function hitTestAll(tabId, x, y) {
  await ensureLib(tabId);
  await frameOffsets(tabId); // refresh each frame's own offset
  const res = await inFrames(tabId, (x, y) => (window.__otter ? window.__otter.hitTestTop(x, y) : null), [x, y]);
  let best = null;
  for (const r of res) {
    const h = r.result;
    if (!h || h.frame) continue;
    if (!best || h.depth > best.depth) best = h;
  }
  return best ? { text: best.text, tag: best.tag } : null;
}

// ===== Dialog race + "what changed" report =====
function dialogNote(d, triggered) {
  const what = `a JavaScript ${d.type} dialog: "${clip(d.message, 200)}"`;
  return (triggered ? `→ The action opened ${what}.` : `There is ${what}.`) +
    ` The page is paused until it's answered — call handle_dialog(accept=true|false${d.type === "prompt" ? ", text" : ""}).`;
}

// Resolve with the action's result, or with a dialog notice the moment a
// dialog opens (the action itself would hang until the dialog is answered).
function raceDialog(tabId, promise) {
  return new Promise((resolve, reject) => {
    let done = false;
    const waiters = dialogWaiters.get(tabId) || new Set();
    dialogWaiters.set(tabId, waiters);
    const finish = (fn, v) => {
      if (done) return;
      done = true;
      waiters.delete(onDialog);
      clearInterval(watchdog);
      fn(v);
    };
    const onDialog = (d) => finish(resolve, dialogNote(d, true));
    waiters.add(onDialog);
    // Watchdog for dialogs Chrome didn't report: every 2 s while the action
    // is still running, check the page still answers.
    let probing = false;
    const watchdog = setInterval(async () => {
      if (done || probing) return;
      probing = true;
      const ok = await pageResponsive(tabId);
      probing = false;
      if (!ok && !done) {
        suspectedDialog.set(tabId, true);
        finish(resolve, `→ ${FROZEN_NOTE}`);
      }
    }, 2000);
    promise.then((v) => finish(resolve, v), (e) => finish(reject, e));
  });
}

// Actions whose result should say what happened next, so the model doesn't
// need a follow-up read just to find out.
const REPORT = new Set(["click", "press_key", "select_option", "hover"]);

async function beforeState(tab) {
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, files: ["page.js"] });
    await inFrame(tab.id, 0, () => window.__otter && window.__otter.watchMutations());
  } catch (_) {}
  return { url: tab.url, title: tab.title, ts: Date.now() };
}

// Let the page settle (navigation finished, DOM quiet for ~200 ms, max
// ~1.5 s), then describe the difference.
async function afterReport(tab, before) {
  const t0 = Date.now();
  let last = -2, quiet = 0, navigated = false;
  while (Date.now() - t0 < 1500) {
    await sleep(100);
    let t;
    try { t = await chrome.tabs.get(tab.id); } catch (_) { return "→ The tab was closed."; }
    if (t.status === "loading" || t.url !== before.url) {
      // A "loading" tab isn't proof of navigation — iframes and ads loading
      // flip it too. It's a new page only if the URL changed or the marker
      // we left in the old document (the mutation counter) is gone.
      await waitForLoad(tab.id, 10000);
      const c = await inFrame(tab.id, 0, () => (window.__otter ? window.__otter.mutationCount() : -1));
      let url = t.url;
      try { url = (await chrome.tabs.get(tab.id)).url; } catch (_) {}
      navigated = url !== before.url || c === -1;
      if (navigated) break;
      if (c === last) { if (++quiet >= 2) break; } else { quiet = 0; last = c; }
      continue;
    }
    if (dialogs.has(tab.id)) break;
    const c = await inFrame(tab.id, 0, () => (window.__otter ? window.__otter.mutationCount() : -1));
    if (c === last) { if (++quiet >= 2) break; } else { quiet = 0; last = c; }
  }
  const notes = [];
  let now;
  try { now = await chrome.tabs.get(tab.id); } catch (_) { return "→ The tab was closed."; }
  if (now.url !== before.url) notes.push(`→ Navigated to ${now.url}${now.title ? ` ("${now.title}")` : ""}`);
  else if (navigated) notes.push(`→ A new page loaded at the same URL (form submitted or page reloaded)${now.title ? `: "${now.title}"` : ""}.`);
  else if (now.title !== before.title) notes.push(`→ The page title is now "${now.title}".`);
  for (const k of (childTabs.get(tab.id) || []).filter((k) => k.ts >= before.ts)) {
    let url = "";
    try { url = (await chrome.tabs.get(k.id)).pendingUrl || (await chrome.tabs.get(k.id)).url; } catch (_) { continue; }
    notes.push(`→ Opened ${k.popup ? "a popup window" : "a new tab"} (tab ${k.id}${url ? `: ${url}` : ""}) — use_tab ${k.id} to work in it.`);
  }
  if (dialogs.has(tab.id)) notes.push(dialogNote(dialogs.get(tab.id), true));
  try {
    const dl = await chrome.downloads.search({ startedAfter: new Date(before.ts).toISOString(), limit: 3 });
    for (const it of dl) notes.push(`→ A download started: ${it.filename || it.url} (wait_for_download to get the file).`);
  } catch (_) {}
  if (!notes.length && !navigated) {
    if (last > 0) notes.push("→ The page updated.");
    else if (last === 0) notes.push("→ No visible change on the page.");
  }
  return notes.join("\n");
}

// ===== Cursor visibility gating =====
// The animated cursor is only shown while the agent is active. We stamp the
// time of each real command; the post-navigation cursor restore only fires
// within this window, so ordinary browsing never shows the cursor.
let lastAgentActivity = 0;
const CURSOR_ACTIVE_WINDOW_MS = 15000;

// Actions that may run on a tab that isn't this session's: they observe
// without changing the page (find_text's scroll is forced off; screenshot
// avoids the debugger there).
const READ_ONLY = new Set([
  "read_page", "read_elements", "find_text", "wait_for", "screenshot", "page_snapshot",
  "hit_test", "locate_element", "resolve_element",
]);
// Actions that still work while a JS dialog is open.
const DIALOG_OK = new Set(["handle_dialog", "dialog_info", "read_console", "read_network", "get_network_body"]);
// Visible actions bring the agent's tab to the front of ITS OWN window.
const VISIBLE = new Set([
  "navigate", "go_back", "go_forward", "reload",
  "click", "fill_element", "select_option", "hover", "drag",
  "type_text", "press_key", "scroll", "upload_file",
]);
// Actions that start "something happening" — wait_for(url) watches from here.
const ACTING = new Set([
  "navigate", "reload", "click", "fill_element", "select_option", "press_key",
  "type_text", "drag", "upload_file", "handle_dialog",
]);

// ===== Per-tab serialization =====
// Subagents of one client share a session, and may hit the same tab at once.
// Actions on one tab run one at a time, so two fill_element calls can never
// interleave keystrokes or mouse moves. (The lock is released when the caller
// gets its answer — an action stuck behind a dialog doesn't block the tab.)
const tabLocks = new Map(); // tabId -> tail promise
function withTabLock(tabId, fn) {
  const prev = tabLocks.get(tabId) || Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => {});
  tabLocks.set(tabId, tail);
  tail.then(() => { if (tabLocks.get(tabId) === tail) tabLocks.delete(tabId); });
  return run;
}
// Actions in flight per window: bring a tab to the front only when its window
// is idle, so parallel subagents' tabs don't flicker back and forth.
const busyWindows = new Map(); // windowId -> count

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
    const { tab: created, ag } = await openAgentTab(p.agentId, p.clientName, p.url, p.reuse);
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
    for (const [id, owner] of Object.entries(adoptedTabs)) {
      if (owner !== p.agentId) continue;
      try { tabs.push(await chrome.tabs.get(Number(id))); } catch (_) {}
    }
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
  if (action === "wait_for_download") {
    return waitForDownload(p);
  }

  lastAgentActivity = Date.now();
  await agentsReady;
  await settingsReady;
  const tab = await resolveTab(p);
  // Agents act only inside their own window. Any other tab — the user's, or
  // another agent's — is read-only.
  const owned = !p.agentId || ownerOf(tab) === p.agentId;
  if (!owned) {
    if (!READ_ONLY.has(action)) {
      throw new Error(
        `Tab ${tab.id} isn't in this session's window, so it is read-only ` +
        `(read_page, read_elements, page_snapshot, find_text, wait_for, screenshot). ` +
        `To work with that page, open_tab its URL in the session's own window.`,
      );
    }
    p = { ...p, scroll: false, readOnly: true };
  }

  // A JS dialog freezes the page: refuse page work until it's answered.
  const openDialog = dialogs.get(tab.id);
  if (openDialog && !DIALOG_OK.has(action)) throw new Error(dialogNote(openDialog, false));
  if (suspectedDialog.has(tab.id) && !DIALOG_OK.has(action)) {
    if (await pageResponsive(tab.id)) suspectedDialog.delete(tab.id);
    else throw new Error(FROZEN_NOTE);
  }

  // Bring the agent's tab to the front of ITS OWN window on visible actions so
  // the user can watch. Activating a tab never focuses its window, so this
  // can't steal focus from the user's window or from other agents (each has
  // its own window). p.background suppresses it for silent script replays.
  if (owned && p.tabId != null && VISIBLE.has(action) && !p.background && !tab.active &&
      !busyWindows.get(tab.windowId)) {
    await chrome.tabs.update(tab.id, { active: true });
  }
  if (ACTING.has(action)) lastActionTs.set(tab.id, Date.now());

  // Fast = no cursor glide and no typing delays (still real, trusted input):
  // script replays always, interactive calls when the user picked Fast mode.
  const fast = !!p.fast || S.agentSpeed === "fast";

  const run = async () => {
    if (!REPORT.has(action) || p.noReport) return perform(action, p, tab, fast);
    const before = await beforeState(tab);
    const res = await perform(action, p, tab, fast);
    if (typeof res !== "string") return res;
    const notes = await afterReport(tab, before);
    return notes ? `${res}\n${notes}` : res;
  };
  if (DIALOG_OK.has(action)) return run(); // answering a dialog never waits in line
  return withTabLock(tab.id, async () => {
    busyWindows.set(tab.windowId, (busyWindows.get(tab.windowId) || 0) + 1);
    try {
      return await raceDialog(tab.id, run());
    } finally {
      const n = (busyWindows.get(tab.windowId) || 1) - 1;
      if (n > 0) busyWindows.set(tab.windowId, n); else busyWindows.delete(tab.windowId);
    }
  });
}

async function perform(action, p, tab, fast) {
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
      // Top frame's text, then each visible iframe's under a marker.
      const offset = Math.max(0, p.offset || 0);
      const maxChars = Math.min(Math.max(1, p.maxChars || 20000), 100000);
      await ensureLib(tab.id);
      const offsets = await frameOffsets(tab.id);
      const res = await inFrames(tab.id, () => (window.__otter ? window.__otter.pageText() : null));
      let full = (res.find((r) => r.frameId === 0) || {}).result || "";
      const byPosition = (a, b) =>
        offsets.get(a.frameId).y - offsets.get(b.frameId).y || offsets.get(a.frameId).x - offsets.get(b.frameId).x;
      for (const r of res.filter((r) => r.frameId !== 0 && offsets.has(r.frameId)).sort(byPosition)) {
        if (!r.result) continue;
        const t = r.result.trim();
        if (t) full += `\n\n--- frame: ${offsets.get(r.frameId).host} ---\n${t}`;
      }
      const top = offsets.get(0) || {};
      return {
        url: tab.url, title: tab.title,
        text: full.slice(offset, offset + maxChars),
        offset, total_chars: full.length, devicePixelRatio: top.dpr,
      };
    }

    case "read_elements": {
      // Number every clickable/typable element so the model can act by index.
      let { list } = await collectAll(tab.id);
      const total = list.length;
      if (p.scope === "viewport") list = list.filter((e) => !e.offscreen);
      if (p.query) {
        const q = p.query.toLowerCase();
        list = list.filter((e) => e.text.toLowerCase().includes(q) || (e.href || "").toLowerCase().includes(q));
      }
      const max = Math.min(Math.max(p.max || 300, 1), 2000);
      if (list.length <= max) return list;
      return {
        total, shown: max, elements: list.slice(0, max),
        note: `Showing ${max} of ${list.length} matching elements. Narrow with scope="viewport" or query, or raise max.`,
      };
    }

    case "page_snapshot":
      return snapshotPage(tab, p);

    case "hit_test": {
      // Text/tag of the topmost interactive element at (x, y), so the server
      // can run its destructive-action check on ANY click.
      return (await hitTestAll(tab.id, p.x, p.y)) || { text: "", tag: "" };
    }

    case "locate_element": {
      // Resolve a read_elements index to the live element's center.
      await ensureLib(tab.id);
      const ref = await resolveRef(tab.id, p.index);
      const pos = ref && (await refPos(tab.id, ref));
      return pos ? { found: true, text: pos.text, x: pos.x, y: pos.y } : { found: false };
    }

    case "resolve_element": {
      // Resolve a DURABLE element descriptor — CSS selector and/or visible
      // text (+ optional tag filter, nth pick) — to a live global index. This
      // is what makes recorded scripts replayable across sessions: indices
      // shift between visits, selectors and labels don't.
      const { list, refs } = await collectAll(tab.id);
      const res = await inFrames(tab.id,
        (s, t, g) => (window.__otter ? window.__otter.match(s, t, g) : null),
        [p.selector ?? null, p.text ?? null, p.tag ?? null]);
      const globalIx = new Map(refs.map((r, i) => [`${r.frameId}:${r.local}`, i]));
      const cands = [];
      for (const r of res) {
        if (!r.result) continue;
        if (r.result.error) throw new Error(r.result.error);
        for (const local of r.result.matches) {
          const g = globalIx.get(`${r.frameId}:${local}`);
          if (g != null) cands.push(g);
        }
      }
      cands.sort((a, b) => a - b);
      if (!cands.length) return { found: false };
      const pick = cands[Math.min(p.nth || 0, cands.length - 1)];
      const e = list[pick];
      return { found: true, index: pick, matches: cands.length, text: e.text, tag: e.tag, x: e.x, y: e.y };
    }

    case "click": {
      // p: { x, y, index?, expectText?, button?, double? } in CSS viewport
      // coordinates. expectText, when present, is the text the SERVER ran the
      // destructive-action gate against. We confirm the live target one last
      // time right before pressing and REFUSE to press if it changed,
      // returning { changed } so the server can re-gate. Without this, a
      // reflow between the gate and the press could swap an approved-safe
      // element for an ungated destructive one.
      let { x, y } = p;
      const hasIndex = p.index !== undefined && p.index !== null;
      const guard = p.expectText !== undefined && p.expectText !== null;
      const expectText = p.expectText || "";
      const button = p.button === "right" ? "right" : "left";
      // The first CDP attach shows the "being debugged" banner, which reflows
      // the page. Attach up-front and let it settle before measuring/clicking.
      const firstAttach = !attached.has(tab.id);
      await ensureDebugger(tab.id);
      if (firstAttach) await sleep(200);
      let ref = null;
      if (hasIndex) {
        await ensureLib(tab.id);
        ref = await resolveRef(tab.id, p.index);
        if (!ref) return { changed: true, actualText: null, x, y };
        // CDP clicks only land inside the visible viewport: scroll first.
        await inFrame(tab.id, ref.frameId, (i) => window.__otter && window.__otter.scrollTo(i), [ref.local]);
        await sleep(fast ? 60 : 180);
        const pos = await refPos(tab.id, ref);
        if (pos) { x = pos.x; y = pos.y; }
      }
      if (fast) {
        placeCursor(tab.id, x, y);
        await cdp(tab.id, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      } else {
        await moveWithHoverTrail(tab.id, x, y);
      }
      // FINAL authoritative identity check, as late as possible before the
      // press: the live element under the pointer must still be the one the
      // gate saw. For index clicks that's the element itself (not covered by
      // an overlay); for coordinate clicks, the same text at that point.
      if (hasIndex) {
        const pos = await refPos(tab.id, ref);
        if (!pos) return { changed: true, actualText: null, x, y };
        x = pos.x; y = pos.y;
        if (!fast) placeCursor(tab.id, x, y);
        const hit = await inFrame(tab.id, ref.frameId,
          (i, lx, ly) => window.__otter && window.__otter.hitIs(i, lx, ly), [ref.local, pos.lx, pos.ly]);
        if (hit && !hit.ok && !hit.gone) {
          return { changed: true, covered: true, actualText: hit.text || "", x, y };
        }
        if (guard && (!hit || hit.text !== expectText)) {
          return { changed: true, actualText: hit ? hit.text : null, x, y };
        }
      } else if (guard) {
        const cur = await hitTestAll(tab.id, x, y);
        const curText = (cur && (cur.text ?? "")) || "";
        if (!cur || curText !== expectText) return { changed: true, actualText: cur ? curText : null, x, y };
      }
      pulse(tab.id);
      lastCursor = { x, y };
      if (button === "right") {
        // Right button held while down (buttons=2) → Chrome fires mousedown,
        // mouseup and contextmenu, which web apps use for their own menus.
        await cdp(tab.id, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "right", buttons: 2, clickCount: 1 });
        await cdp(tab.id, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "right", buttons: 0, clickCount: 1 });
        return `Right-clicked at (${x}, ${y})`;
      }
      await cdp(tab.id, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
      await cdp(tab.id, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
      if (p.double) {
        // A real double-click is two press/release pairs, the second with
        // clickCount 2 (that's what fires dblclick).
        await cdp(tab.id, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 2 });
        await cdp(tab.id, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 2 });
        return `Double-clicked at (${x}, ${y})`;
      }
      return `Clicked at (${x}, ${y})`;
    }

    case "type_text": {
      const text = p.text || "";
      await typeChars(tab.id, text, fast);
      return `Typed ${text.length} chars`;
    }

    case "fill_element": {
      // Focus + select-all inside the page, then type over the selection with
      // real key events (so frameworks see genuine, trusted input).
      await ensureDebugger(tab.id);
      await ensureLib(tab.id);
      const ref = await resolveRef(tab.id, p.index);
      if (!ref) throw new Error(`No element with index ${p.index}. Call read_elements first.`);
      await inFrame(tab.id, ref.frameId, (i) => window.__otter && window.__otter.scrollTo(i), [ref.local]);
      await sleep(fast ? 40 : 120);
      // TRANSACTIONAL fill. Apps that manage focus themselves (Google Sheets
      // and friends) can asynchronously steal it back at ANY point, so no
      // pre-check is sufficient. Instead: focus + type, then VERIFY the text
      // actually arrived (focus still there, or its value changed). If the
      // keystrokes were diverted, press Escape to cancel whatever stray edit
      // they may have opened elsewhere, and retry.
      const focusSel = () => inFrame(tab.id, ref.frameId,
        (i) => window.__otter && window.__otter.focusSelect(i), [ref.local]);
      const state = () => inFrame(tab.id, ref.frameId,
        (i) => window.__otter && window.__otter.fieldState(i), [ref.local]);
      const escapeKey = { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 };
      const text = p.text || "";
      let lastProblem = "";
      for (let attempt = 0; attempt < 3; attempt++) {
        let info = await focusSel();
        if (!info) throw new Error(`No element with index ${p.index}. Call read_elements first.`);
        if (info.fatal) throw new Error(info.error);
        if (!info.focused) {
          // Script focus didn't take (a cross-origin iframe that doesn't have
          // focus yet, or an app refusing programmatic focus): a real click
          // on the field gives it focus, then select again.
          const pos = await refPos(tab.id, ref);
          if (pos) {
            await cdp(tab.id, "Input.dispatchMouseEvent", { type: "mousePressed", x: pos.x, y: pos.y, button: "left", clickCount: 1 });
            await cdp(tab.id, "Input.dispatchMouseEvent", { type: "mouseReleased", x: pos.x, y: pos.y, button: "left", clickCount: 1 });
            await sleep(80);
            info = (await focusSel()) || info;
          }
        }

        if (!text) {
          // Empty text = clear: delete the selected content, verify it emptied.
          await cdp(tab.id, "Input.dispatchKeyEvent", {
            type: "keyDown", key: "Backspace", windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8,
          });
          await cdp(tab.id, "Input.dispatchKeyEvent", {
            type: "keyUp", key: "Backspace", windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8,
          });
          const st = (await state()) || { gone: true };
          if (st.gone || st.focused || st.value !== info.value || info.value === "") {
            return `Cleared element ${p.index} (${info.tag})`;
          }
          lastProblem = "the clear keystroke was diverted by the page";
        } else {
          await typeChars(tab.id, text, fast);
          const st = (await state()) || { gone: true };
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
      await ensureLib(tab.id);
      const ref = await resolveRef(tab.id, p.index);
      if (!ref) throw new Error(`No element with index ${p.index}. Call read_elements first.`);
      const r = await inFrame(tab.id, ref.frameId,
        (i, v, l) => window.__otter && window.__otter.selectOption(i, v, l),
        [ref.local, p.value ?? null, p.label ?? null]);
      if (!r) throw new Error(`No element with index ${p.index}. Call read_elements first.`);
      if (!r.ok) {
        throw new Error(r.error + (r.options ? ` Available options: ${JSON.stringify(r.options)}` : ""));
      }
      return `Selected '${r.selected.label}' (value=${r.selected.value}) in element ${p.index}`;
    }

    case "hover": {
      // click() minus the press/release: glide + real mouseMoved so :hover
      // styles and JS mouseover handlers genuinely trigger.
      let { x, y, index } = p;
      const firstAttach = !attached.has(tab.id);
      await ensureDebugger(tab.id);
      if (firstAttach) await sleep(200);
      if (index !== undefined && index !== null) {
        await ensureLib(tab.id);
        const ref = await resolveRef(tab.id, index);
        if (!ref) throw new Error(`No interactive element with index ${index}. Call read_elements first.`);
        await inFrame(tab.id, ref.frameId, (i) => window.__otter && window.__otter.scrollTo(i), [ref.local]);
        await sleep(fast ? 60 : 180);
        const pos = await refPos(tab.id, ref);
        if (!pos) throw new Error(`No interactive element with index ${index}. Call read_elements first.`);
        x = pos.x;
        y = pos.y;
      }
      if (fast) placeCursor(tab.id, x, y);
      else await moveWithHoverTrail(tab.id, x, y);
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
      if (fast) {
        // No animation, but still a REAL move sequence — drag handlers
        // (sliders, sortables) need intermediate mousemove events.
        placeCursor(tab.id, fromX, fromY);
        await cdp(tab.id, "Input.dispatchMouseEvent", { type: "mouseMoved", x: fromX, y: fromY });
        await cdp(tab.id, "Input.dispatchMouseEvent", {
          type: "mousePressed", x: fromX, y: fromY, button: "left", clickCount: 1,
        });
        for (const pt of straightPath({ x: fromX, y: fromY }, { x: toX, y: toY }, 8)) {
          await cdp(tab.id, "Input.dispatchMouseEvent", {
            type: "mouseMoved", x: pt.x, y: pt.y, button: "left", buttons: 1,
          });
        }
      } else {
        await moveWithHoverTrail(tab.id, fromX, fromY);
        lastCursor = { x: fromX, y: fromY };
        pulse(tab.id);
        await cdp(tab.id, "Input.dispatchMouseEvent", {
          type: "mousePressed", x: fromX, y: fromY, button: "left", clickCount: 1,
        });
        for (const pt of await cursorPath(tab.id, toX, toY)) {
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
      await ensureLib(tab.id);
      const search = async () => {
        const offsets = await frameOffsets(tab.id);
        const res = await inFrames(tab.id, (q) => (window.__otter ? window.__otter.findText(q, 50) : null), [p.query]);
        const top = offsets.get(0) || { w: Infinity, h: Infinity };
        const out = [];
        const pos = (r) => offsets.get(r.frameId) || { x: Infinity, y: Infinity };
        for (const r of res.sort((a, b) => pos(a).y - pos(b).y || pos(a).x - pos(b).x)) {
          const off = offsets.get(r.frameId);
          if (!Array.isArray(r.result) || !off) continue;
          r.result.forEach((m, li) => {
            const x = Math.round(m.x + off.x), y = Math.round(m.y + off.y);
            const visible = m.visible && x >= 0 && y >= 0 && x < top.w && y < top.h;
            const e = { frameId: r.frameId, li, x, y, visible, context: m.context };
            if (r.frameId !== 0) e.frame = off.host;
            out.push(e);
          });
        }
        return out.slice(0, 50);
      };
      let found = await search();
      if (!found.length) return { count: 0, matches: [] };
      if (p.scroll !== false) {
        const target = found[Math.min(p.nth || 0, found.length - 1)];
        await inFrame(tab.id, target.frameId, (i) => window.__otter && window.__otter.scrollToFind(i), [target.li]);
        found = await search(); // coordinates AFTER the scroll, so they're clickable
      }
      return {
        count: found.length,
        matches: found.map(({ frameId, li, ...m }, i) => ({ nth: i, ...m })),
      };
    }

    case "wait_for": {
      // Text and/or CSS selector (any frame, shadow DOM included), and/or a
      // network response whose URL contains p.url, started after the last
      // action in this tab.
      const timeout = Math.min(Math.max(p.timeoutMs || 10000, 100), 60000);
      const started = Date.now();
      const deadline = started + timeout;
      const since = lastActionTs.get(tab.id) || started;
      if (p.url) { try { await ensureDebugger(tab.id); } catch (_) {} }
      for (;;) {
        let textOk = p.text == null, selOk = p.selector == null, response = null;
        if (p.text != null || p.selector != null) {
          try {
            await ensureLib(tab.id);
            const res = await inFrames(tab.id,
              (t, s) => (window.__otter ? window.__otter.waitCheck(t, s) : null),
              [p.text ?? null, p.selector ?? null]);
            for (const r of res) {
              if (!r.result) continue;
              if (r.result.invalidSelector) throw new Error(`Invalid CSS selector: ${p.selector}`);
              textOk = textOk || r.result.textOk;
              selOk = selOk || r.result.selOk;
            }
          } catch (e) {
            if (/Invalid CSS selector/.test(e.message)) throw e;
            /* mid-navigation: frame briefly not scriptable — retry */
          }
        }
        if (p.url) {
          const want = p.url.toLowerCase();
          for (const e of (networkBuf.get(tab.id) || new Map()).values()) {
            if (e.startMs >= since && e.doneMs && e.url.toLowerCase().includes(want)) {
              response = { url: e.url, status: e.status ?? null, error: e.error };
              break;
            }
          }
        }
        if (textOk && selOk && (!p.url || response)) {
          return { found: true, elapsed_ms: Date.now() - started, ...(response ? { response } : {}) };
        }
        if (Date.now() >= deadline) {
          return { found: false, elapsed_ms: Date.now() - started, timeout_ms: timeout };
        }
        await sleep(300);
      }
    }

    case "press_key": {
      await pressKey(tab.id, p.key);
      return `Pressed ${p.key}`;
    }

    case "scroll": {
      // Variable increments read more naturally than fixed jumps. Distance and
      // whether to jitter are settings-driven; an explicit deltaY is jittered
      // too. The wheel lands on the element / point given (so inner panels
      // scroll), else the middle of the viewport.
      let x = p.x, y = p.y;
      if (p.index != null) {
        await ensureLib(tab.id);
        const ref = await resolveRef(tab.id, p.index);
        const pos = ref && (await refPos(tab.id, ref));
        if (!pos) throw new Error(`No interactive element with index ${p.index}. Call read_elements first.`);
        x = pos.x;
        y = pos.y;
      }
      if (x == null || y == null) {
        const lm = await cdp(tab.id, "Page.getLayoutMetrics");
        const vp = lm.cssLayoutViewport || lm.layoutViewport;
        x = Math.round(vp.clientWidth / 2);
        y = Math.round(vp.clientHeight / 2);
      }
      const amount = OtterConfig.scrollAmount(S, p.deltaY, Math.random);
      await cdp(tab.id, "Input.dispatchMouseEvent", {
        type: "mouseWheel", x, y, deltaX: 0, deltaY: Math.round(amount),
      });
      return "Scrolled";
    }

    case "screenshot":
      return screenshot(tab, p);

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
      let out = buf ? [...buf.values()].map(({ startMs, doneMs, ...e }) => e) : [];
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

    case "dialog_info": {
      const d = dialogs.get(tab.id);
      if (d) return { open: true, ...d };
      // Unknown ≠ none: if our Page events aren't arriving we can't know.
      return { open: false, attached: attached.has(tab.id), enableErrors: enableErrors.get(tab.id) || [] };
    }

    case "handle_dialog": {
      // Answer through CDP even when no dialog event was seen: Chrome itself
      // knows whether one is showing, and says so if not.
      const d = dialogs.get(tab.id) || { type: "JavaScript", message: "" };
      const before = tab.url;
      await ensureDebugger(tab.id);
      try {
        await chrome.debugger.sendCommand({ tabId: tab.id }, "Page.handleJavaScriptDialog", {
          accept: !!p.accept,
          ...(p.text != null ? { promptText: p.text } : {}),
        });
      } catch (e) {
        dialogs.delete(tab.id);
        suspectedDialog.delete(tab.id);
        if (/No dialog is showing/i.test(e.message)) throw new Error("No JavaScript dialog is open in this tab.");
        throw e;
      }
      dialogs.delete(tab.id);
      suspectedDialog.delete(tab.id);
      await sleep(300);
      let note = "";
      try {
        const now = await chrome.tabs.get(tab.id);
        if (now.status === "loading") await waitForLoad(tab.id, 10000);
        const after = await chrome.tabs.get(tab.id);
        if (after.url !== before) note = `\n→ Navigated to ${after.url}`;
      } catch (_) {}
      return `${p.accept ? "Accepted" : "Dismissed"} the ${d.type} dialog ("${clip(d.message, 80)}").${note}`;
    }

    case "upload_file":
      return uploadFile(tab, p);

    case "set_viewport": {
      if (p.reset) {
        await cdp(tab.id, "Emulation.clearDeviceMetricsOverride");
        await cdp(tab.id, "Emulation.setTouchEmulationEnabled", { enabled: false });
        return "Viewport reset to the window's real size.";
      }
      await cdp(tab.id, "Emulation.setDeviceMetricsOverride", {
        width: p.width, height: p.height, deviceScaleFactor: p.scale || 0, mobile: !!p.mobile,
      });
      await cdp(tab.id, "Emulation.setTouchEmulationEnabled", p.mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
      elementRefs.delete(tab.id); // layout changed: coordinates are stale
      return `Viewport set to ${p.width}x${p.height}${p.mobile ? " (mobile, touch)" : ""}. Use set_viewport(reset=true) to undo.`;
    }

    case "save_pdf": {
      const res = await cdp(tab.id, "Page.printToPDF", { printBackground: true, preferCSSPageSize: true });
      return { base64: res.data, title: tab.title, url: tab.url };
    }

    default:
      throw new Error(`Unknown action: ${action}`);
  }
}

// ===== page_snapshot =====
async function snapshotPage(tab, p) {
  const scope = p.scope === "page" ? "page" : "viewport";
  const max = Math.min(Math.max(p.maxLines || 250, 20), 2000);
  const { refs, offsets } = await collectAll(tab.id);
  const res = await inFrames(tab.id, (s, m) => (window.__otter ? window.__otter.snapshot(s, m) : null), [scope, max]);
  const globalIx = new Map(refs.map((r, i) => [`${r.frameId}:${r.local}`, i]));
  const top = res.find((r) => r.frameId === 0);
  const vp = (top && top.result && top.result.viewport) || {};
  const out = [];
  let truncated = false;
  const ordered = res
    .filter((r) => r.result && offsets.has(r.frameId))
    .sort((a, b) => (a.frameId === 0 ? -1 : b.frameId === 0 ? 1 : offsets.get(a.frameId).y - offsets.get(b.frameId).y));
  for (const r of ordered) {
    if (!r.result.lines.length) continue;
    if (r.frameId !== 0) out.push(`[frame ${offsets.get(r.frameId).host}]`);
    for (const l of r.result.lines) {
      const g = l.ref != null ? globalIx.get(`${r.frameId}:${l.ref}`) : null;
      out.push(`${r.frameId !== 0 ? "  " : ""}- ${l.text}${g != null ? ` [${g}]` : ""}`);
    }
    truncated = truncated || r.result.truncated;
  }
  const lines = out.slice(0, max);
  truncated = truncated || out.length > max;
  return [
    `${tab.url}`,
    `"${tab.title}" — viewport ${vp.w}x${vp.h}, scrolled ${vp.scrollY} of ${vp.scrollH}px` +
      (scope === "viewport" ? " (showing what's on screen; scope=\"page\" for everything)" : ""),
    `[n] = element index for click_element / fill_element / select_option.`,
    ...lines,
    ...(truncated ? [`… truncated at ${max} lines (raise max_lines${scope === "viewport" ? "" : " or use scope=\"viewport\""}).`] : []),
  ].join("\n");
}

// ===== screenshot =====
async function screenshot(tab, p) {
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
    if (p.fullPage || p.index != null) throw new Error("full_page and element screenshots aren't available on the user's tab.");
    if (!tab.active) throw new Error(`Tab ${tab.id} is no longer the visible tab in the user's window; call get_user_tab again.`);
  } else {
    await ensureDebugger(tab.id);
  }
  const viewport = () => inFrame(tab.id, 0, () => ({
    w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio,
    sx: window.scrollX, sy: window.scrollY,
  }));
  let meta = await viewport();
  if (!meta) throw new Error("This page can't be captured (Chrome blocks scripts on it).");
  let outW = meta.w, outH = meta.h;
  const capParams = { format: "jpeg", quality: 80 };
  if (p.index != null) {
    // One element: scroll it into view, clip to its box (document coordinates).
    await ensureLib(tab.id);
    const ref = await resolveRef(tab.id, p.index);
    if (!ref) throw new Error(`No interactive element with index ${p.index}. Call read_elements first.`);
    await inFrame(tab.id, ref.frameId, (i) => window.__otter && window.__otter.scrollTo(i), [ref.local]);
    await sleep(150);
    const pos = await refPos(tab.id, ref);
    if (!pos) throw new Error(`Element ${p.index} disappeared. Call read_elements again.`);
    meta = (await viewport()) || meta;
    // A few px of margin: subpixel edges otherwise shave off the last glyph.
    const PAD = 4;
    const left = Math.max(0, Math.floor(pos.left - PAD));
    const top = Math.max(0, Math.floor(pos.top - PAD));
    outW = Math.max(1, Math.ceil(pos.left + pos.width + PAD) - left);
    outH = Math.max(1, Math.ceil(pos.top + pos.height + PAD) - top);
    capParams.clip = { x: left + meta.sx, y: top + meta.sy, width: outW, height: outH, scale: 1 };
    capParams.captureBeyondViewport = true;
  } else if (p.fullPage) {
    // Full-page mode: clip to the document's content box. Height is capped —
    // an endless-feed page would otherwise blow past canvas size limits and
    // the bridge's 32 MiB frame cap.
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
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  // capturedWidth/Height = native (physical) capture; width/height = CSS
  // size the image is scaled to. Diagnostic for the coordinate drift.
  return {
    base64: btoa(binary), format: "jpeg",
    width: outW, height: outH, dpr: meta.dpr, fullPage: !!p.fullPage,
    capturedWidth: bitmap.width, capturedHeight: bitmap.height,
  };
}

// ===== upload_file =====
// Chrome can set a file input's files straight from local paths (CDP
// DOM.setFileInputFiles) — no file dialog involved. page.js tags the right
// <input type=file> (upload buttons usually hide it), CDP finds the tag.
// p.dryRun: only locate the input (the server asks for approval in between).
async function uploadFile(tab, p) {
  await ensureDebugger(tab.id);
  await ensureLib(tab.id);
  const token = Math.random().toString(36).slice(2);
  let mark = null;
  if (p.index != null) {
    const ref = await resolveRef(tab.id, p.index);
    if (!ref) throw new Error(`No interactive element with index ${p.index}. Call read_elements first.`);
    mark = await inFrame(tab.id, ref.frameId,
      (i, s, t) => window.__otter && window.__otter.markFileInput(i, s, t), [ref.local, null, token]);
  } else {
    const res = await inFrames(tab.id,
      (s, t) => (window.__otter ? window.__otter.markFileInput(null, s, t) : null), [p.selector ?? null, token]);
    const hits = res.filter((r) => r.result && r.result.ok);
    if (hits.length > 1 && !p.selector) {
      await inFrames(tab.id, (t) => window.__otter && window.__otter.unmarkFileInput(t), [token]);
      throw new Error("File inputs exist in several frames; pass the index of the upload control.");
    }
    mark = hits.length ? hits[0].result : (res.find((r) => r.result && r.result.error && !r.result.notFound) || {}).result;
  }
  if (!mark || !mark.ok) throw new Error((mark && mark.error) || "No file input found on the page.");
  try {
    if (!mark.multiple && p.files.length > 1) {
      throw new Error("That file input accepts only one file.");
    }
    if (p.dryRun) return { ok: true, url: mark.url, accept: mark.accept, multiple: mark.multiple };
    await cdp(tab.id, "DOM.getDocument", { depth: 0 });
    const { searchId, resultCount } = await cdp(tab.id, "DOM.performSearch", {
      query: `[data-otter-upload="${token}"]`,
    });
    try {
      if (!resultCount) {
        throw new Error("The file input is in a cross-origin frame Chrome can't reach from here.");
      }
      const { nodeIds } = await cdp(tab.id, "DOM.getSearchResults", { searchId, fromIndex: 0, toIndex: 1 });
      await cdp(tab.id, "DOM.setFileInputFiles", { files: p.files, nodeId: nodeIds[0] });
    } finally {
      await cdp(tab.id, "DOM.discardSearchResults", { searchId }).catch(() => {});
    }
    return `Attached ${p.files.length} file(s) to the file input${mark.accept ? ` (accepts ${mark.accept})` : ""}.`;
  } finally {
    await inFrames(tab.id, (t) => window.__otter && window.__otter.unmarkFileInput(t), [token]).catch(() => {});
  }
}

// ===== wait_for_download =====
// The newest download that started within the lookback window (default 15 s,
// so one triggered by the previous action counts), waited on until complete.
async function waitForDownload(p) {
  const started = Date.now();
  const since = started - (p.lookbackMs ?? 15000);
  const timeout = Math.min(Math.max(p.timeoutMs || 30000, 1000), 300000);
  for (;;) {
    const [it] = await chrome.downloads.search({
      startedAfter: new Date(since).toISOString(), orderBy: ["-startTime"], limit: 1,
    });
    if (it && it.state === "complete") {
      return { state: "complete", file: it.filename, url: it.finalUrl || it.url, bytes: it.fileSize || it.totalBytes, mime: it.mime };
    }
    if (it && it.state === "interrupted") throw new Error(`The download failed: ${it.error}`);
    if (Date.now() - started > timeout) {
      return it
        ? { state: it.state, file: it.filename, url: it.url, bytesReceived: it.bytesReceived, note: "Still downloading." }
        : { state: "none", note: "No download started." };
    }
    await sleep(400);
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
