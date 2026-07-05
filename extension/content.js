// ===== Cursor element =====
let cursor = null;

function ensureCursor() {
  if (cursor && document.documentElement.contains(cursor)) return cursor;
  cursor = document.createElement("div");
  cursor.id = "__agent_cursor";
  Object.assign(cursor.style, {
    position: "fixed",
    left: "40px",
    top: "40px",
    width: "24px",
    height: "24px",
    zIndex: "2147483647",     // stay on top of everything
    pointerEvents: "none",     // CRITICAL: real clicks must pass through it
    transition: "none",
    transform: "scale(1)",
  });
  cursor.innerHTML = `<svg viewBox="0 0 24 24" width="24" height="24">
    <path d="M4 2 L4 20 L9 15 L12 22 L15 20.5 L12 14 L19 14 Z"
          fill="#111" stroke="#fff" stroke-width="1.5"/>
  </svg>`;
  document.documentElement.appendChild(cursor);
  return cursor;
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

    const start = performance.now();
    function frame(now) {
      const t = Math.min(1, (now - start) / duration);
      const p = bezier(ease(t));
      c.style.left = p.x + "px";
      c.style.top = p.y + "px";
      if (t < 1) requestAnimationFrame(frame);
      else resolve({ path });
    }
    requestAnimationFrame(frame);
  });
}

// ===== Click pulse (press-down effect) =====
function clickPulse() {
  const c = ensureCursor();
  c.style.transform = "scale(0.85)";
  setTimeout(() => (c.style.transform = "scale(1)"), 120);
}

// ===== Message handling =====
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "moveCursor") {
    moveCursorTo(msg.x, msg.y, msg.samples).then(sendResponse);
    return true; // async response
  }
  if (msg.type === "clickPulse") {
    clickPulse();
    sendResponse({ ok: true });
  }
  if (msg.type === "placeCursor") {
    const c = ensureCursor();
    c.style.left = msg.x + "px";
    c.style.top = msg.y + "px";
    sendResponse({ ok: true });
  }
});

ensureCursor();
