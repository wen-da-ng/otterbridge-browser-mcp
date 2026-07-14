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
    return { ...DEFAULTS, ...(stored || {}) };
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

  root.OtterConfig = {
    KEY, DEFAULTS, PRESETS,
    applyPreset, normalize,
    moveDuration, curveFactor, typeDelay, scrollAmount, easingFn, EASINGS,
    load, save,
  };
})(typeof self !== "undefined" ? self : this);
