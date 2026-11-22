// ===== OtterBridge shared settings =====
// One source of truth for tunable cursor/input parameters, loaded by:
//   - content.js  (content script; classic, shares this file's globals)
//   - background.js (service worker; via importScripts)
//   - options.js / popup.js (pages; via <script src="config.js">)
//
// Runtime code only ever reads CONCRETE values from the stored settings object.
// A "preset" is just a label: picking one writes its concrete numbers; nudging
// any advanced control flips the label to "custom". Settings live in
// chrome.storage.sync (roams across the user's signed-in Chromes), keyed by
// OtterConfig.KEY.
(function (root) {
  const KEY = "otterSettings";

  // DEFAULTS == the original hardcoded behavior == the "Natural" preset.
  const DEFAULTS = {
    preset: "natural",

    // --- Motion ---
    moveSpeed: 1, // multiplier; higher = faster travel (scales move duration)
    curvature: 1, // 0 (straight) .. 1 (full arc; maps to the 0.15 offset factor)
    easing: "natural", // "natural" (ease-in-out) | "snappy" (ease-out) | "linear"
    trailSamples: 12, // path points that fire real mouseMoved (hover fidelity)

    // --- Typing ---
    typeSpeed: 1, // multiplier; higher = faster per-character typing
    thinkingPauses: true, // occasional longer hesitation between keystrokes

    // --- Scrolling ---
    scrollDistance: 600, // px per scroll
    scrollJitter: true, // randomize each scroll amount +/-15%

    // --- Behavior ---
    idleDrift: true, // subtle at-rest cursor wobble (human tell)
    driftIntensity: 1, // multiplier on drift amplitude
    cursorVisibility: "active", // "always" | "active" | "off"
    cursorEnabled: true, // master switch for the visible cursor

    // --- Agent speed ---
    // "watch": animated cursor glide + human-paced typing, nice to follow.
    // "fast": no glide, no typing delay — still real, trusted input events,
    // just without the waiting. (Script replays are always fast.)
    agentSpeed: "watch",

    // --- Agent windows ---
    // Close (ungroup first, so Chrome doesn't keep the tab group on the
    // bookmarks bar) an agent's window once its AI client has been gone for
    // 5 minutes. On by default since 0.9.1: windows left open — or closed by
    // hand — are what made "Otter · ..." groups pile up on the bookmarks bar.
    autoCloseWindows: true,

    // Bumped when a default changes for everyone (see normalize).
    settingsVersion: 2,

    // --- Approvals ---
    // "ask": destructive clicks and evaluate_js prompt for approval in the AI
    // client. "auto": Full Auto — no prompts (evaluate_js still needs
    // allowJsEval). Only the user can flip this; no tool can.
    approvalMode: "ask",

    // --- Advanced ---
    allowJsEval: false, // permit the evaluate_js tool to run JS in pages (opt-in)

    // --- Site rules ---
    // [{ pattern: "bank.com", mode: "block" | "read" | "ask" }], set only by
    // the user (popup / options) — no tool can change them. See siteRuleFor.
    siteRules: [],

    // --- Appearance ---
    size: 32, // px
    colorStart: "#FFE014", // gradient top
    colorEnd: "#F24E07", // gradient bottom + stroke base
    glow: true, // neon drop-shadow (auto-derived from colorStart)
    ripple: true, // expanding ring on click
    clickPulse: true, // press-down shrink on click
  };

  // Presets = partial overrides layered on DEFAULTS. Appearance (size/colors)
  // is intentionally NOT touched by presets — presets are about feel/speed.
  const PRESETS = {
    natural: {
      moveSpeed: 1, curvature: 1, easing: "natural", trailSamples: 12,
      typeSpeed: 1, thinkingPauses: true,
      scrollDistance: 600, scrollJitter: true,
      idleDrift: true, driftIntensity: 1,
      ripple: true, glow: true, clickPulse: true,
    },
    fast: {
      moveSpeed: 2, curvature: 0.4, easing: "snappy", trailSamples: 8,
      typeSpeed: 3, thinkingPauses: false,
      scrollDistance: 800, scrollJitter: true,
      idleDrift: false, driftIntensity: 1,
      ripple: true, glow: true, clickPulse: true,
    },
    instant: {
      moveSpeed: 8, curvature: 0, easing: "linear", trailSamples: 4,
      typeSpeed: 12, thinkingPauses: false,
      scrollDistance: 1000, scrollJitter: false,
      idleDrift: false, driftIntensity: 1,
      ripple: false, glow: false, clickPulse: true,
    },
  };

  // Expand a preset name into a full concrete settings object (appearance kept).
  function applyPreset(name, current) {
    const base = current || DEFAULTS;
    return { ...base, ...(PRESETS[name] || {}), preset: name };
  }

  // Merge stored (possibly partial / older) settings over DEFAULTS.
  function normalize(stored) {
    const s = { ...DEFAULTS, ...(stored || {}) };
    // v2 (0.9.1): auto-close agent windows became the default. Settings saved
    // earlier stored `false` only because it was the old default.
    if (stored && (stored.settingsVersion || 1) < 2) {
      s.autoCloseWindows = true;
      s.settingsVersion = 2;
    }
    s.siteRules = normalizeSiteRules(stored && stored.siteRules);
    return s;
  }

  // ---- Site rules ----
  // What AI agents may do on a site: "block" (nothing — not open, read or
  // act), "read" (look, not touch), "ask" (every action needs the user's OK,
  // even in Full Auto). No rule: as usual. Enforced by background.js.
  const SITE_MODES = ["block", "read", "ask"];

  // "https://www.Bank.com:443/login" -> "www.bank.com"; "*.bank.com" ->
  // "bank.com". null unless what's left is a hostname.
  function normalizeSitePattern(input) {
    let s = String(input == null ? "" : input).trim().toLowerCase();
    s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, ""); // scheme
    s = s.replace(/[/?#].*$/, "");                // path, query, fragment
    s = s.replace(/^[^@]*@/, "");                 // user:pass@
    s = s.replace(/:\d*$/, "");                   // port
    s = s.replace(/^\*\./, "");                   // leading *.
    s = s.replace(/\.$/, "");                     // trailing dot
    if (!s || s.length > 253 || !/^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(s)) return null;
    return s;
  }

  // Valid rules only, one per pattern (the last one wins), patterns normalised.
  function normalizeSiteRules(rules) {
    const byPattern = new Map();
    for (const r of Array.isArray(rules) ? rules : []) {
      if (!r || !SITE_MODES.includes(r.mode)) continue;
      const pattern = normalizeSitePattern(r.pattern);
      if (pattern) byPattern.set(pattern, { pattern, mode: r.mode });
    }
    return [...byPattern.values()];
  }

  // The rule for a page, or null. A pattern covers its host and every
  // subdomain; the longest (most specific) matching pattern wins, so
  // "news.bank.com: read" carves an exception out of "bank.com: block".
  function siteRuleFor(url, rules) {
    let u;
    try { u = new URL(url); } catch (_) { return null; }
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    const host = u.hostname.toLowerCase().replace(/\.$/, "");
    let best = null;
    for (const r of rules || []) {
      if (!r || !SITE_MODES.includes(r.mode)) continue;
      const p = normalizeSitePattern(r.pattern);
      if (!p || !(host === p || host.endsWith("." + p))) continue;
      if (!best || p.length > best.pattern.length) best = { pattern: p, mode: r.mode };
    }
    return best;
  }

  // ---- Derived motion values (kept here so content/background agree) ----
  // Move duration mirrors the original min(1200, 200 + dist*1.5), divided by
  // the speed multiplier, with a small floor so "instant" still animates enough
  // to fire hover events along the path.
  function moveDuration(dist, s) {
    const m = s.moveSpeed || 1;
    return Math.max(50, Math.min(1200 / m, (200 + dist * 1.5) / m));
  }

  // Perpendicular control-point offset factor for the bezier arc.
  function curveFactor(s) {
    return 0.15 * (s.curvature == null ? 1 : s.curvature);
  }

  // Per-character typing delay (ms). Mirrors original 60 + rand*100, scaled by
  // typeSpeed; optional "thinking" pause folded in when enabled.
  function typeDelay(s, rand) {
    const speed = s.typeSpeed || 1;
    const base = (60 + rand() * 100) / speed;
    if (s.thinkingPauses && rand() < 0.08) {
      return base + (200 + rand() * 300) / speed;
    }
    return base;
  }

  // Scroll amount (px) for a requested target, applying jitter if enabled.
  function scrollAmount(s, target, rand) {
    const base = target != null ? target : (s.scrollDistance || 600);
    return s.scrollJitter ? base * (0.85 + rand() * 0.3) : base;
  }

  // Easing functions by name. t in [0,1].
  const EASINGS = {
    natural: (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),
    snappy: (t) => 1 - Math.pow(1 - t, 3), // ease-out cubic
    linear: (t) => t,
  };
  function easingFn(s) {
    return EASINGS[s.easing] || EASINGS.natural;
  }

  // ---- storage helpers (promise-based; work in all extension contexts) ----
  function load() {
    return new Promise((resolve) => {
      try {
        chrome.storage.sync.get(KEY, (res) => resolve(normalize(res && res[KEY])));
      } catch (_) {
        resolve({ ...DEFAULTS });
      }
    });
  }

  function save(settings) {
    return new Promise((resolve) => {
      try {
        chrome.storage.sync.set({ [KEY]: settings }, () => resolve());
      } catch (_) {
        resolve();
      }
    });
  }

  // ---- Pairing code (must match normalizeCode in server/src/index.ts) ----
  // Crockford base32 without I L O U. Uppercase, read the look-alikes O/I/L
  // as 0/1/1, drop dashes and spaces; valid only with exactly 20 left.
  const PAIR_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  function normalizePairingCode(s) {
    const t = String(s || "")
      .toUpperCase()
      .replace(/O/g, "0")
      .replace(/[IL]/g, "1")
      .split("")
      .filter((ch) => PAIR_ALPHABET.includes(ch))
      .join("");
    return t.length === 20 ? t : null;
  }

  // ---- Second line of defence for the approval gate ----
  // The server asks the user before destructive actions and marks the command
  // `gated: true` once they approved. The extension independently recognises
  // the same actions and refuses one that arrives unmarked — so a server code
  // path that forgets to gate can't slip through. Approval prompts stay in the
  // server; this never asks anything itself.
  // DANGER_SOURCE must equal DANGER_RE in server/src/index.ts (test/gate.mjs
  // fails the build if they drift apart).
  const DANGER_SOURCE =
    "\\b(buy|purchase|pay|checkout|order|place\\s+order|delete|remove|send|submit|confirm|transfer|withdraw|post|publish|unsubscribe)\\b";
  const DANGER_RE = new RegExp(DANGER_SOURCE, "i");
  const isDanger = (text) => DANGER_RE.test(String(text || ""));

  // kind: "click" | "dialog" (accepting a non-alert dialog whose text is
  // known) | "dialog_unread" | "upload" | "eval". True = refuse.
  function refuseUngated({ kind, text, gated, approvalMode }) {
    if (approvalMode === "auto") return false; // Full Auto: the user's own switch
    if (gated === true) return false;
    if (kind === "click" || kind === "dialog") return isDanger(text);
    return kind === "dialog_unread" || kind === "upload" || kind === "eval";
  }

  root.OtterConfig = {
    KEY, DEFAULTS, PRESETS,
    applyPreset, normalize,
    moveDuration, curveFactor, typeDelay, scrollAmount, easingFn, EASINGS,
    load, save,
    normalizePairingCode,
    DANGER_SOURCE, isDanger, refuseUngated,
    SITE_MODES, normalizeSitePattern, normalizeSiteRules, siteRuleFor,
  };
})(typeof self !== "undefined" ? self : this);
