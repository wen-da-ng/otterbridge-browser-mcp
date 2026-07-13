// ===== OtterBridge cursor (designed in Cursor Studio) =====
// The cursor is created lazily on the first agent command (so it never appears
// during normal browsing) and then stays visible for the life of the page.
const CURSOR_SIZE = 32;
const CURSOR_TIP = { x: (4 / 24) * CURSOR_SIZE, y: (2 / 24) * CURSOR_SIZE }; // arrow hotspot
const CURSOR_GLOW =
  "drop-shadow(0 0 10px rgba(247,98,36,0.65)) drop-shadow(0 0 19px rgba(247,98,36,0.36))";
const IDLE_DRIFT = true;      // subtle at-rest cursor drift (human tell)

let cursor = null;
let restLeft = 40, restTop = 40;   // logical resting position of the cursor's top-left
let isAnimating = false;
let visible = false;
let driftRaf = null;

function ensureCursor() {
  if (cursor && document.documentElement.contains(cursor)) return cursor;
  cursor = document.createElement("div");
  cursor.id = "__agent_cursor";
  Object.assign(cursor.style, {
    position: "fixed",
    left: restLeft + "px",
    top: restTop + "px",
    width: CURSOR_SIZE + "px",
    height: CURSOR_SIZE + "px",
    zIndex: "2147483647",      // stay on top of everything
    pointerEvents: "none",      // CRITICAL: real clicks must pass through it
    opacity: "0",               // hidden until the agent acts
    transition: "opacity .25s ease, transform .12s ease",
    transform: "scale(1)",
    transformOrigin: "0 0",
    filter: CURSOR_GLOW,
  });
  cursor.innerHTML = `<svg viewBox="0 0 24 24" width="${CURSOR_SIZE}" height="${CURSOR_SIZE}">
    <defs>
      <linearGradient id="__agent_cursor_grad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#FFE014"/>
        <stop offset="1" stop-color="#F24E07"/>
      </linearGradient>
    </defs>
    <path d="M4 2 L4 21 L9.6 16 L12.6 23 L16 21.4 L12.9 15 L20 15 Z"
          fill="url(#__agent_cursor_grad)"
          stroke="#F24E07" stroke-width="1.25"
          stroke-linejoin="round" stroke-linecap="round"/>
  </svg>`;
  document.documentElement.appendChild(cursor);
  return cursor;
}

// ===== Show lifecycle =====
// Once the agent acts, the cursor appears and stays visible until the page
// reloads/navigates (a fresh page starts hidden again). hideCursor is kept
// available but not called automatically.
function showCursor() {
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

// ===== Human-like motion: quadratic bezier + ease-in-out =====
// Returns sampled path points so background.js can fire CDP mouseMoved
// along the same trajectory (hover states trigger for real).
function moveCursorTo(tx, ty, samples = 12) {
  return new Promise((resolve) => {
    const c = ensureCursor();
    const sx = parseFloat(c.style.left) || 0;
    const sy = parseFloat(c.style.top) || 0;
    const dist = Math.hypot(tx - sx, ty - sy);
    const duration = Math.min(1200, 200 + dist * 1.5); // farther = longer, capped

    // Control point offset perpendicular to the path -> gentle arc
    const mx = (sx + tx) / 2 + (ty - sy) * 0.15;
    const my = (sy + ty) / 2 - (tx - sx) * 0.15;

    const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
    const bezier = (e) => ({
      x: (1 - e) ** 2 * sx + 2 * (1 - e) * e * mx + e * e * tx,
      y: (1 - e) ** 2 * sy + 2 * (1 - e) * e * my + e * e * ty,
    });

    const path = [];
    for (let i = 1; i <= samples; i++) {
      const p = bezier(ease(i / samples));
      path.push({ x: Math.round(p.x), y: Math.round(p.y) });
    }

    isAnimating = true;
    const start = performance.now();
    function frame(now) {
      const t = Math.min(1, (now - start) / duration);
      const p = bezier(ease(t));
      c.style.left = p.x + "px";
      c.style.top = p.y + "px";
      if (t < 1) {
        requestAnimationFrame(frame);
      } else {
        restLeft = tx; restTop = ty; isAnimating = false;
        resolve({ path });
      }
    }
    requestAnimationFrame(frame);
  });
}

// ===== Click pulse (press-down effect) + expanding ring ripple =====
function clickPulse() {
  const c = ensureCursor();
  c.style.transform = "scale(0.82)";
  setTimeout(() => (c.style.transform = "scale(1)"), 130);

  // Ring ripple centered on the cursor's tip (the actual click point).
  const cx = (parseFloat(c.style.left) || 0) + CURSOR_TIP.x;
  const cy = (parseFloat(c.style.top) || 0) + CURSOR_TIP.y;
  const ring = document.createElement("div");
  Object.assign(ring.style, {
    position: "fixed",
    left: cx + "px",
    top: cy + "px",
    width: CURSOR_SIZE * 0.5 + "px",
    height: CURSOR_SIZE * 0.5 + "px",
    border: "2px solid rgba(242,78,7,0.9)",   // #F24E07
    borderRadius: "50%",
    transform: "translate(-50%, -50%)",
    pointerEvents: "none",
    zIndex: "2147483646",
    opacity: "1",
    transition: "width .45s ease-out, height .45s ease-out, opacity .45s ease-out",
  });
  document.documentElement.appendChild(ring);
  requestAnimationFrame(() => {
    const end = CURSOR_SIZE * 2.6;
    ring.style.width = end + "px";
    ring.style.height = end + "px";
    ring.style.opacity = "0";
  });
  setTimeout(() => ring.remove(), 480);
}

// ===== Idle micro-drift: tiny at-rest movement (subtle human tell) =====
function startDrift() {
  if (!IDLE_DRIFT || driftRaf) return;
  let phase = 0;
  function step() {
    if (cursor && visible && !isAnimating) {
      phase += 0.05;
      const dx = Math.sin(phase * 1.3) * 0.6 + (Math.random() - 0.5) * 0.35;
      const dy = Math.cos(phase) * 0.6 + (Math.random() - 0.5) * 0.35;
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

// ===== Message handling (each cursor command shows it & resets the hide timer) =====
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "moveCursor") {
    showCursor();
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
