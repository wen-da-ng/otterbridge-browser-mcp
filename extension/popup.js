// Toolbar popup: quick preset switch + master cursor toggle + link to the full
// options page. Writes to the same chrome.storage.sync the options page uses.
const C = OtterConfig;
let state = { ...C.DEFAULTS };

function matchPreset(s) {
  for (const name of Object.keys(C.PRESETS)) {
    const p = C.PRESETS[name];
    if (Object.keys(p).every((k) => s[k] === p[k])) return name;
  }
  return "custom";
}

function reflect() {
  const active = matchPreset(state);
  document.querySelectorAll(".preset").forEach((b) => {
    b.setAttribute("aria-pressed", String(b.dataset.preset === active));
  });
  document.getElementById("cursorEnabled").checked = !!state.cursorEnabled;
  const fast = state.agentSpeed === "fast";
  document.getElementById("fastMode").checked = fast;
  document.getElementById("fastHint").textContent = fast
    ? "No cursor animation or typing delays"
    : "Animated cursor, human-paced typing";
  const auto = state.approvalMode === "auto";
  document.getElementById("fullAuto").checked = auto;
  const hint = document.getElementById("autoHint");
  hint.textContent = auto ? "No approval prompts" : "Ask before destructive clicks";
  hint.classList.toggle("on", auto);
}

async function init() {
  state = await C.load();
  reflect();

  document.querySelectorAll(".preset").forEach((b) => {
    if (b.dataset.preset === "custom") return;
    b.addEventListener("click", async () => {
      state = C.applyPreset(b.dataset.preset, state);
      await C.save(state);
      reflect();
    });
  });

  document.getElementById("cursorEnabled").addEventListener("change", async (e) => {
    state.cursorEnabled = e.target.checked;
    state.preset = matchPreset(state);
    await C.save(state);
  });

  document.getElementById("fastMode").addEventListener("change", async (e) => {
    state.agentSpeed = e.target.checked ? "fast" : "watch";
    await C.save(state);
    reflect();
  });

  document.getElementById("fullAuto").addEventListener("change", async (e) => {
    state.approvalMode = e.target.checked ? "auto" : "ask";
    await C.save(state);
    reflect();
  });

  document.getElementById("cleanup").addEventListener("click", async () => {
    const msg = document.getElementById("cleanupMsg");
    msg.textContent = "Closing…";
    const res = await chrome.runtime.sendMessage({ type: "closeAgentWindows" });
    msg.textContent = res && res.error
      ? `Couldn't close: ${res.error}`
      : res && res.closed
        ? `Closed ${res.closed} agent window${res.closed === 1 ? "" : "s"}.`
        : "No agent windows open.";
  });

  document.getElementById("adv").addEventListener("click", () => {
    if (chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage();
    else window.open(chrome.runtime.getURL("options.html"));
  });
}

init();
