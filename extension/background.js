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
}

chrome.debugger.onDetach.addListener(({ tabId }) => attached.delete(tabId));

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

  lastAgentActivity = Date.now();
  const tab = await activeTab();

  switch (action) {
    case "navigate": {
      await chrome.tabs.update(tab.id, { url: p.url });
      await waitForLoad(tab.id);
      return `Navigated to ${p.url}`;
    }

    case "read_page": {
      const [res] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => ({
          url: location.href,
          title: document.title,
          text: document.body.innerText.slice(0, 20000),
          devicePixelRatio: window.devicePixelRatio,
        }),
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
      // Human-like typing: per-character key events with jittered timing.
      // Speed and the occasional "thinking" pause are settings-driven.
      const text = p.text || "";
      for (const ch of text) {
        await cdp(tab.id, "Input.dispatchKeyEvent", { type: "keyDown", text: ch });
        await cdp(tab.id, "Input.dispatchKeyEvent", { type: "keyUp", text: ch });
        await sleep(OtterConfig.typeDelay(S, Math.random));
      }
      return `Typed ${text.length} chars`;
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
      // captureVisibleTab grabs the viewport at PHYSICAL pixels (viewport
      // CSS size x devicePixelRatio). We scale it back down to CSS pixels
      // in an OffscreenCanvas so coordinates read off the image map 1:1 to
      // the CSS viewport coords that click() expects — no DPR math needed.
      const [meta] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => ({
          w: window.innerWidth,
          h: window.innerHeight,
          dpr: window.devicePixelRatio,
        }),
      });
      const { w, h, dpr } = meta.result;
      // JPEG q80: ~5-10x smaller than PNG on photo-heavy pages.
      const dataUrl = await chrome.tabs.captureVisibleTab(null, {
        format: "jpeg", quality: 80,
      });
      const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
      const canvas = new OffscreenCanvas(w, h);
      canvas.getContext("2d").drawImage(bitmap, 0, 0, w, h);
      const buf = await (await canvas.convertToBlob({
        type: "image/jpeg", quality: 0.8,
      })).arrayBuffer();
      const bytes = new Uint8Array(buf);
      let binary = "";
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      // capturedWidth/Height = native (physical) capture; width/height = CSS
      // viewport the image is scaled to. Diagnostic for the coordinate drift.
      return {
        base64: btoa(binary), format: "jpeg",
        width: w, height: h, dpr,
        capturedWidth: bitmap.width, capturedHeight: bitmap.height,
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
