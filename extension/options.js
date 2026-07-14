// Options page: renders all tunables, auto-saves to chrome.storage.sync (which
// content.js/background.js pick up live), and shows a preview cursor that moves
// with the current settings using the SAME math as the real cursor.
const C = OtterConfig;

// Declarative control schema. type: range | select | toggle | color.
const SCHEMA = [
  { group: "motion", key: "moveSpeed", label: "Move speed", type: "range", min: 0.25, max: 3, step: 0.05, fmt: (v) => v.toFixed(2) + "×" },
  { group: "motion", key: "curvature", label: "Path curvature", type: "range", min: 0, max: 1, step: 0.05, fmt: (v) => Math.round(v * 100) + "%" },
  { group: "motion", key: "easing", label: "Easing", type: "select", options: [["natural", "Natural"], ["snappy", "Snappy"], ["linear", "Linear"]] },
  { group: "motion", key: "trailSamples", label: "Hover-trail samples", type: "range", min: 4, max: 20, step: 1, fmt: (v) => String(v) },

  { group: "typing", key: "typeSpeed", label: "Typing speed", type: "range", min: 0.25, max: 5, step: 0.05, fmt: (v) => v.toFixed(2) + "×" },
  { group: "typing", key: "thinkingPauses", label: "Thinking pauses", type: "toggle" },

  { group: "scroll", key: "scrollDistance", label: "Scroll distance", type: "range", min: 200, max: 1200, step: 50, fmt: (v) => v + "px" },
  { group: "scroll", key: "scrollJitter", label: "Scroll jitter", type: "toggle" },

  { group: "behavior", key: "cursorEnabled", label: "Show cursor", type: "toggle" },
  { group: "behavior", key: "cursorVisibility", label: "Cursor visibility", type: "select", options: [["always", "Always"], ["active", "While agent active"], ["off", "Off"]] },
  { group: "behavior", key: "idleDrift", label: "Idle drift", type: "toggle" },
  { group: "behavior", key: "driftIntensity", label: "Drift intensity", type: "range", min: 0, max: 2, step: 0.1, fmt: (v) => v.toFixed(1) + "×", dependsOn: "idleDrift" },

  { group: "appearance", key: "size", label: "Cursor size", type: "range", min: 20, max: 48, step: 1, fmt: (v) => v + "px" },
  { group: "appearance", key: "colorStart", label: "Color (top)", type: "color" },
  { group: "appearance", key: "colorEnd", label: "Color (bottom / stroke)", type: "color" },
  { group: "appearance", key: "glow", label: "Glow", type: "toggle" },
  { group: "appearance", key: "ripple", label: "Click ripple", type: "toggle" },
  { group: "appearance", key: "clickPulse", label: "Click pulse", type: "toggle" },
];

let state = { ...C.DEFAULTS };
const els = {}; // key -> input element
let savedTimer = null;

function matchPreset(s) {
  for (const name of Object.keys(C.PRESETS)) {
    const p = C.PRESETS[name];
    if (Object.keys(p).every((k) => s[k] === p[k])) return name;
  }
  return "custom";
}

function persist() {
  state.preset = matchPreset(state);
  C.save(state);
  reflectPreset();
  const saved = document.getElementById("saved");
  saved.classList.add("show");
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => saved.classList.remove("show"), 1200);
}

function reflectPreset() {
  document.querySelectorAll(".preset").forEach((b) => {
    b.setAttribute("aria-pressed", String(b.dataset.preset === state.preset));
  });
}

function makeRow(item) {
  const row = document.createElement("div");
  row.className = "row" + (item.type === "toggle" ? " toggle" : "");
  const label = document.createElement("label");
  label.textContent = item.label;
  label.setAttribute("for", "c_" + item.key);
  row.appendChild(label);

  let input, valEl;
  if (item.type === "range") {
    input = document.createElement("input");
    input.type = "range"; input.min = item.min; input.max = item.max; input.step = item.step;
    valEl = document.createElement("span"); valEl.className = "val";
    input.addEventListener("input", () => {
      state[item.key] = parseFloat(input.value);
      valEl.textContent = item.fmt(state[item.key]);
      persist(); applyDeps();
    });
    row.appendChild(input); row.appendChild(valEl);
  } else if (item.type === "select") {
    input = document.createElement("select");
    for (const [v, lbl] of item.options) {
      const o = document.createElement("option"); o.value = v; o.textContent = lbl; input.appendChild(o);
    }
    input.addEventListener("change", () => { state[item.key] = input.value; persist(); applyDeps(); });
    const spacer = document.createElement("span"); spacer.className = "val";
    row.appendChild(input); row.appendChild(spacer);
  } else if (item.type === "color") {
    input = document.createElement("input"); input.type = "color";
    input.addEventListener("input", () => { state[item.key] = input.value; persist(); });
    const spacer = document.createElement("span"); spacer.className = "val";
    row.appendChild(input); row.appendChild(spacer);
  } else if (item.type === "toggle") {
    const sw = document.createElement("label"); sw.className = "switch";
    input = document.createElement("input"); input.type = "checkbox";
    const sl = document.createElement("span"); sl.className = "slider";
    sw.appendChild(input); sw.appendChild(sl);
    input.addEventListener("change", () => { state[item.key] = input.checked; persist(); applyDeps(); });
    row.appendChild(sw);
  }
  input.id = "c_" + item.key;
  els[item.key] = { input, valEl, row, item };
  return row;
}

function syncControls() {
  for (const key of Object.keys(els)) {
    const { input, valEl, item } = els[key];
    const v = state[key];
    if (item.type === "toggle") input.checked = !!v;
    else if (item.type === "range") { input.value = v; if (valEl) valEl.textContent = item.fmt(v); }
    else input.value = v;
  }
  applyDeps();
}

// Grey out driftIntensity when idleDrift is off, etc.
function applyDeps() {
  for (const key of Object.keys(els)) {
    const { row, item } = els[key];
    if (item.dependsOn) row.classList.toggle("disabled", !state[item.dependsOn]);
  }
}

// ---- Live preview ----
const preview = { el: null, cursor: null, raf: null };
function setupPreview() {
  const box = document.getElementById("preview");
  const A = { x: 70, y: 100 }, B = { x: 0, y: 55 };
  const rect = () => box.getBoundingClientRect();
  function place() {
    const r = rect();
    B.x = r.width - 80;
    document.getElementById("dotA").style.cssText = `left:${A.x}px;top:${A.y}px`;
    document.getElementById("dotB").style.cssText = `left:${B.x}px;top:${B.y}px`;
  }
  const cur = document.createElement("div");
  cur.style.cssText = "position:absolute;transform-origin:0 0;pointer-events:none;transition:transform .12s ease;";
  box.appendChild(cur);
  preview.el = box; preview.cursor = cur;
  place();
  window.addEventListener("resize", place);

  let from = { ...A }, to = { ...B }, start = performance.now(), holding = 0;
  function drawCursor() {
    cur.style.width = state.size + "px"; cur.style.height = state.size + "px";
    cur.style.filter = state.glow ? `drop-shadow(0 0 8px ${state.colorStart})` : "none";
    cur.innerHTML = `<svg viewBox="0 0 24 24" width="${state.size}" height="${state.size}">
      <defs><linearGradient id="pg" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="${state.colorStart}"/><stop offset="1" stop-color="${state.colorEnd}"/>
      </linearGradient></defs>
      <path d="M4 2 L4 21 L9.6 16 L12.6 23 L16 21.4 L12.9 15 L20 15 Z" fill="url(#pg)"
        stroke="${state.colorEnd}" stroke-width="1.25" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
  }
  function ripple(x, y) {
    if (!state.ripple) return;
    const r = document.createElement("div");
    r.style.cssText = `position:absolute;left:${x}px;top:${y}px;width:${state.size * .5}px;height:${state.size * .5}px;border:2px solid ${state.colorEnd};border-radius:50%;transform:translate(-50%,-50%);opacity:1;transition:width .45s,height .45s,opacity .45s;pointer-events:none;`;
    preview.el.appendChild(r);
    requestAnimationFrame(() => { r.style.width = state.size * 2.6 + "px"; r.style.height = state.size * 2.6 + "px"; r.style.opacity = "0"; });
    setTimeout(() => r.remove(), 480);
  }
  function loop(now) {
    drawCursor();
    const dist = Math.hypot(to.x - from.x, to.y - from.y);
    const dur = C.moveDuration(dist, state);
    const k = C.curveFactor(state);
    const ease = C.easingFn(state);
    const mx = (from.x + to.x) / 2 + (to.y - from.y) * k;
    const my = (from.y + to.y) / 2 - (to.x - from.x) * k;
    let t = (now - start) / dur;
    if (t >= 1) {
      t = 1;
      if (!holding) { holding = now; if (state.clickPulse) { cur.style.transform = "scale(0.82)"; setTimeout(() => cur.style.transform = "scale(1)", 130); } ripple(to.x + state.size * (4 / 24), to.y + state.size * (2 / 24)); }
      if (now - holding > 700) { from = { ...to }; to = (to.x === B.x ? { ...A } : { ...B }); start = now; holding = 0; }
    }
    const e = ease(Math.min(1, t));
    const x = (1 - e) ** 2 * from.x + 2 * (1 - e) * e * mx + e * e * to.x;
    const y = (1 - e) ** 2 * from.y + 2 * (1 - e) * e * my + e * e * to.y;
    cur.style.left = x + "px"; cur.style.top = y + "px";
    preview.raf = requestAnimationFrame(loop);
  }
  preview.raf = requestAnimationFrame(loop);
}

async function init() {
  state = await C.load();
  for (const item of SCHEMA) {
    const container = document.querySelector(`.controls[data-group="${item.group}"]`);
    container.appendChild(makeRow(item));
  }
  syncControls();
  reflectPreset();
  setupPreview();

  document.querySelectorAll(".preset").forEach((b) => {
    if (b.dataset.preset === "custom") return;
    b.addEventListener("click", () => {
      state = C.applyPreset(b.dataset.preset, state);
      syncControls(); persist();
    });
  });
  document.getElementById("reset").addEventListener("click", () => {
    state = { ...C.DEFAULTS };
    syncControls(); persist();
  });
}

init();
