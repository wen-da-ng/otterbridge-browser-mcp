// ===== OtterBridge cursor (designed in Cursor Studio) =====
// The cursor is created lazily on the first agent command (so it never appears
// during normal browsing) and then stays visible for the life of the page.
//
// All tunables (size, colors, glow, motion speed/curve/easing, drift, click FX,
// visibility) come from OtterConfig / chrome.storage.sync and update live via
// storage.onChanged — no page reload needed. config.js runs before this file
// (see manifest content_scripts), so OtterConfig is available here.

let S = OtterConfig.DEFAULTS; // live settings; replaced once storage loads
OtterConfig.load().then((s) => {
  S = s;
  applyAppearance();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && changes[OtterConfig.KEY]) {
    S = OtterConfig.normalize(changes[OtterConfig.KEY].newValue);
    applyAppearance();
    // If the cursor was turned off, hide it immediately.
    if (!cursorShowable()) hideCursor();
  }
});

const CURSOR_TIP_RATIO = { x: 4 / 24, y: 2 / 24 }; // arrow hotspot, as fraction of size
const tip = () => ({ x: CURSOR_TIP_RATIO.x * S.size, y: CURSOR_TIP_RATIO.y * S.size });

// Neon glow derived from the gradient's start color.
function glowFilter() {
  if (!S.glow) return "none";
  const c = hexToRgb(S.colorStart) || { r: 247, g: 152, b: 36 };
  return (
    `drop-shadow(0 0 10px rgba(${c.r},${c.g},${c.b},0.65)) ` +
    `drop-shadow(0 0 19px rgba(${c.r},${c.g},${c.b},0.36))`
  );
}

function hexToRgb(hex) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || "");
  return m ? { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) } : null;
}

let cursor = null;
let restLeft = 40, restTop = 40; // logical resting position of the cursor's top-left
let isAnimating = false;
let visible = false;
let driftRaf = null;

function cursorShowable() {
  return S.cursorEnabled && S.cursorVisibility !== "off";
}

function ensureCursor() {
  if (cursor && document.documentElement.contains(cursor)) return cursor;
  cursor = document.createElement("div");
  cursor.id = "__agent_cursor";
  Object.assign(cursor.style, {
    position: "fixed",
    left: restLeft + "px",
    top: restTop + "px",
    zIndex: "2147483647", // stay on top of everything
    pointerEvents: "none", // CRITICAL: real clicks must pass through it
    opacity: "0", // hidden until the agent acts
    transition: "opacity .25s ease, transform .12s ease",
    transform: "scale(1)",
    transformOrigin: "0 0",
  });
  document.documentElement.appendChild(cursor);
  applyAppearance();
  return cursor;
}

// Apply size/colors/glow to the (possibly already-rendered) cursor element.
function applyAppearance() {
  if (!cursor) return;
  cursor.style.width = S.size + "px";
  cursor.style.height = S.size + "px";
  cursor.style.filter = glowFilter();
  cursor.innerHTML = `<svg viewBox="0 0 24 24" width="${S.size}" height="${S.size}">
    <defs>
      <linearGradient id="__agent_cursor_grad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="${S.colorStart}"/>
        <stop offset="1" stop-color="${S.colorEnd}"/>
      </linearGradient>
    </defs>
    <path d="M4 2 L4 21 L9.6 16 L12.6 23 L16 21.4 L12.9 15 L20 15 Z"
          fill="url(#__agent_cursor_grad)"
          stroke="${S.colorEnd}" stroke-width="1.25"
          stroke-linejoin="round" stroke-linecap="round"/>
  </svg>`;
}

// ===== Show lifecycle =====
// Once the agent acts, the cursor appears and stays visible until the page
// reloads/navigates (a fresh page starts hidden again). hideCursor is kept
// available but not called automatically.
function showCursor() {
  if (!cursorShowable()) return; // respect master switch / "off" visibility
  const c = ensureCursor();
  visible = true;
  c.style.opacity = "1";
  startDrift();
}

function hideCursor() {
  visible = false;
  stopDrift();
  if (cursor) cursor.style.opacity = "0";
}

// ===== Human-like motion: quadratic bezier + configurable easing =====
// Returns sampled path points so background.js can fire CDP mouseMoved
// along the same trajectory (hover states trigger for real).
function moveCursorTo(tx, ty, samples) {
  const c = ensureCursor();
  const n = samples || S.trailSamples;
  const sx = parseFloat(c.style.left) || 0;
  const sy = parseFloat(c.style.top) || 0;
  const dist = Math.hypot(tx - sx, ty - sy);
  const duration = OtterConfig.moveDuration(dist, S);

  // Control point offset perpendicular to the path -> gentle arc.
  const k = OtterConfig.curveFactor(S);
  const mx = (sx + tx) / 2 + (ty - sy) * k;
  const my = (sy + ty) / 2 - (tx - sx) * k;

  const ease = OtterConfig.easingFn(S);
  const bezier = (e) => ({
    x: (1 - e) ** 2 * sx + 2 * (1 - e) * e * mx + e * e * tx,
    y: (1 - e) ** 2 * sy + 2 * (1 - e) * e * my + e * e * ty,
  });

  const path = [];
  for (let i = 1; i <= n; i++) {
    const p = bezier(ease(i / n));
    path.push({ x: Math.round(p.x), y: Math.round(p.y) });
  }

  const animate = (onDone) => {
    isAnimating = true;
    const start = performance.now();
    function frame(now) {
      const t = Math.min(1, (now - start) / duration);
      const p = bezier(ease(t));
      c.style.left = p.x + "px";
      c.style.top = p.y + "px";
      if (t < 1) requestAnimationFrame(frame);
      else { restLeft = tx; restTop = ty; isAnimating = false; if (onDone) onDone(); }
    }
    requestAnimationFrame(frame);
  };

  // Visible tab: await the animation so the click syncs with the cursor's
  // arrival (nice for the watching user). Hidden/background tab: rAF is
  // throttled/paused, so awaiting would hang the click — resolve the path
  // immediately and let the (cosmetic) animation run detached. This is what
  // lets parallel agents click tabs the user isn't looking at.
  if (document.hidden) {
    animate();
    return Promise.resolve({ path });
  }
  return new Promise((resolve) => animate(() => resolve({ path })));
}

// ===== Click pulse (press-down effect) + expanding ring ripple =====
function clickPulse() {
  const c = ensureCursor();
  if (S.clickPulse) {
    c.style.transform = "scale(0.82)";
    setTimeout(() => (c.style.transform = "scale(1)"), 130);
  }

  if (!S.ripple) return;
  // Ring ripple centered on the cursor's tip (the actual click point).
  const t = tip();
  const cx = (parseFloat(c.style.left) || 0) + t.x;
  const cy = (parseFloat(c.style.top) || 0) + t.y;
  const rgb = hexToRgb(S.colorEnd) || { r: 242, g: 78, b: 7 };
  const ring = document.createElement("div");
  Object.assign(ring.style, {
    position: "fixed",
    left: cx + "px",
    top: cy + "px",
    width: S.size * 0.5 + "px",
    height: S.size * 0.5 + "px",
    border: `2px solid rgba(${rgb.r},${rgb.g},${rgb.b},0.9)`,
    borderRadius: "50%",
    transform: "translate(-50%, -50%)",
    pointerEvents: "none",
    zIndex: "2147483646",
    opacity: "1",
    transition: "width .45s ease-out, height .45s ease-out, opacity .45s ease-out",
  });
  document.documentElement.appendChild(ring);
  requestAnimationFrame(() => {
    const end = S.size * 2.6;
    ring.style.width = end + "px";
    ring.style.height = end + "px";
    ring.style.opacity = "0";
  });
  setTimeout(() => ring.remove(), 480);
}

// ===== Idle micro-drift: tiny at-rest movement (subtle human tell) =====
function startDrift() {
  if (!S.idleDrift || driftRaf) return;
  let phase = 0;
  function step() {
    if (cursor && visible && !isAnimating && S.idleDrift) {
      const amp = 0.6 * (S.driftIntensity || 1);
      const rnd = 0.35 * (S.driftIntensity || 1);
      phase += 0.05;
      const dx = Math.sin(phase * 1.3) * amp + (Math.random() - 0.5) * rnd;
      const dy = Math.cos(phase) * amp + (Math.random() - 0.5) * rnd;
      cursor.style.left = restLeft + dx + "px";
      cursor.style.top = restTop + dy + "px";
    }
    driftRaf = requestAnimationFrame(step);
  }
  driftRaf = requestAnimationFrame(step);
}

function stopDrift() {
  if (driftRaf) { cancelAnimationFrame(driftRaf); driftRaf = null; }
}

// ===== Message handling (each cursor command shows it) =====
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "moveCursor") {
    showCursor();
    // Still return a path even if the cursor is hidden, so background.js can
    // fire the CDP hover trail regardless of cursor visibility.
    moveCursorTo(msg.x, msg.y, msg.samples).then(sendResponse);
    return true; // async response
  }
  if (msg.type === "clickPulse") {
    showCursor();
    clickPulse();
    sendResponse({ ok: true });
  }
  if (msg.type === "placeCursor") {
    const c = ensureCursor();
    restLeft = msg.x; restTop = msg.y;
    c.style.left = msg.x + "px";
    c.style.top = msg.y + "px";
    showCursor();
    sendResponse({ ok: true });
  }
});
