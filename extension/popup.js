// Toolbar popup: connection + pairing, profile name, speed preset, the three
// quick switches, and links out. Settings live in the same chrome.storage.sync
// the options page uses; the pairing code and this profile's name live in
// storage.local (per profile, never synced).
const C = OtterConfig;
const $ = (id) => document.getElementById(id);
let state = { ...C.DEFAULTS };

// ---- Speed preset + switches ----
function matchPreset(s) {
  for (const name of Object.keys(C.PRESETS)) {
    const p = C.PRESETS[name];
    if (Object.keys(p).every((k) => s[k] === p[k])) return name;
  }
  return "custom";
}

function reflect() {
  const active = matchPreset(state);
  document.querySelectorAll("#presets button").forEach((b) => {
    b.setAttribute("aria-pressed", String(b.dataset.preset === active));
  });
  $("customTag").hidden = active !== "custom";
  $("cursorEnabled").checked = !!state.cursorEnabled;
  $("fastMode").checked = state.agentSpeed === "fast";
  const auto = state.approvalMode === "auto";
  $("fullAuto").checked = auto;
  $("autoNote").hidden = !auto;
}

// ---- This profile's name (what the AI sees) ----
async function initProfile() {
  const input = $("profileName");
  const { profileName } = await chrome.storage.local.get("profileName");
  input.value = profileName || "";
  let email = "";
  try {
    email = (await new Promise((r) => chrome.identity.getProfileUserInfo({ accountStatus: "ANY" }, r))).email || "";
  } catch (_) {}
  if (!input.value && email) input.placeholder = email.split("@")[0];
  $("profileEmail").textContent = email || "Not signed in to Chrome";
  $("profileEmail").hidden = false;
  input.addEventListener("change", () => chrome.storage.local.set({ profileName: input.value.trim() }));
}

// ---- Connection + pairing ----
let pairEditing = false;
let lastStatus = { required: false, hasCode: false, state: "idle" };
let flash = null; // { hint: [tone, text], until } — a local message the live refresh keeps for a moment
const flashHint = (hint) => { flash = { hint, until: Date.now() + 4000 }; setSub($("pairHint"), hint); };

async function getStatus() {
  try {
    return (await chrome.runtime.sendMessage({ type: "pairingStatus" })) ||
      { required: false, hasCode: false, state: "idle" };
  } catch (_) {
    return { required: false, hasCode: false, state: "idle" };
  }
}

// Header status: one word or two, a coloured dot.
const STATUS = {
  connected: ["ok", "Connected"],
  open: ["warn", "Connected"],
  waiting: ["warn", "Approve in AI app"],
  unpaired: ["danger", "Needs pairing"],
  mismatch: ["danger", "Wrong code"],
  refused: ["danger", "Pairing required"],
  "old-server": ["danger", "Update OtterBridge"],
  idle: ["idle", "No AI app running"],
};

// Under the pairing switch: only what needs saying right now.
function hintFor(st) {
  switch (st.state) {
    case "mismatch":
      return st.locked ? ["danger", "Too many tries. Wait a minute, then paste again."]
        : ["danger", "That code doesn't match. Paste it again."];
    case "unpaired": return ["", "Ask Claude to pair this browser, or copy it from a paired profile."];
    case "waiting": return ["warn", "Allow it in your AI app, or turn pairing back on."];
    case "refused": return ["danger", "This computer requires pairing. Turn it on and pair."];
    case "old-server": return ["danger", "Update OtterBridge, then restart your AI app."];
    default:
      if (st.required && !st.hasCode) return ["", "Ask Claude to pair this browser, or copy it from a paired profile."];
      return ["", ""];
  }
}

function setSub(el, [tone, text]) {
  el.textContent = text;
  el.className = `sub${tone ? ` ${tone}` : ""}`;
  el.hidden = !text;
}

function render(st) {
  const [tone, label] = STATUS[st.state] || STATUS.idle;
  $("status").dataset.tone = tone;
  $("statusText").textContent = label;

  $("requirePairing").checked = st.required;
  setSub($("reqSub"), st.required
    ? (st.computerOff ? ["warn", "Off for this computer (another profile turned it off)"]
      : ["ok", "On · extra security for this computer"])
    : ["", "Switch on for extra security"]);

  const needsCode = st.required && (pairEditing || !st.hasCode || st.state === "mismatch");
  $("pairForm").hidden = !needsCode;
  const paired = st.required && !needsCode && st.hasCode;
  $("pairLinks").hidden = !paired;
  if (!paired) hideCode();
  if (flash && Date.now() < flash.until) setSub($("pairHint"), flash.hint);
  else setSub($("pairHint"), pairEditing && st.state !== "mismatch" ? ["", ""] : hintFor(st));
}

async function refresh() {
  lastStatus = await getStatus();
  render(lastStatus);
}

// Wait (up to 5 s) for the connection to settle after a change.
async function settle() {
  let st = await getStatus();
  for (let i = 0; i < 20 && !["connected", "open", "mismatch", "refused"].includes(st.state); i++) {
    await new Promise((r) => setTimeout(r, 250));
    st = await getStatus();
  }
  render(st);
  return st;
}

async function pair() {
  const input = $("pairCode");
  const btn = $("pairBtn");
  const code = C.normalizePairingCode(input.value);
  if (!code) {
    flashHint(["danger", "That doesn't look like a pairing code."]);
    input.focus();
    return;
  }
  btn.disabled = true;
  btn.textContent = "Pairing…";
  const { pairingCode: old } = await chrome.storage.local.get("pairingCode");
  if (old === code) await chrome.runtime.sendMessage({ type: "retryPairing" }).catch(() => {});
  else await chrome.storage.local.set({ pairingCode: code });
  input.value = "";
  pairEditing = false;
  const st = await settle();
  btn.disabled = false;
  btn.textContent = "Pair";
  if (st.state === "idle") flashHint(["ok", "Saved. Connects when your AI app runs."]);
}

// A paired profile can show its code, to pair another Chrome profile with it.
function hideCode() {
  $("codeReveal").hidden = true;
  $("codeText").textContent = "";
  $("showCode").textContent = "Show code";
  $("showCode").setAttribute("aria-expanded", "false");
}
async function toggleCode() {
  if (!$("codeReveal").hidden) { hideCode(); return; }
  const { pairingCode } = await chrome.storage.local.get("pairingCode");
  if (!pairingCode) return;
  $("codeText").textContent = pairingCode.match(/.{4}/g).join("-");
  $("codeReveal").hidden = false;
  $("showCode").textContent = "Hide code";
  $("showCode").setAttribute("aria-expanded", "true");
}
async function copyCode() {
  const btn = $("copyCode");
  try {
    await navigator.clipboard.writeText($("codeText").textContent);
    btn.textContent = "Copied";
  } catch (_) {
    btn.textContent = "Select it";
  }
  setTimeout(() => { btn.textContent = "Copy"; }, 1500);
}

async function initPairing() {
  await refresh();
  requestAnimationFrame(() => document.body.classList.add("ready"));
  // Stay live while open: connections change on their own (an AI app starts,
  // the server asks the user, a code is accepted).
  setInterval(refresh, 600);
  $("pairBtn").addEventListener("click", pair);
  $("pairCode").addEventListener("keydown", (e) => { if (e.key === "Enter") pair(); });
  $("showCode").addEventListener("click", toggleCode);
  $("copyCode").addEventListener("click", copyCode);
  $("pairChange").addEventListener("click", async () => {
    pairEditing = true;
    await refresh();
    $("pairCode").focus();
  });
  $("requirePairing").addEventListener("change", async (e) => {
    const on = e.target.checked;
    pairEditing = false;
    // Show the result of the switch at once; the live refresh fills in the
    // connection state as it settles. Turning it off forgets the code.
    render({ ...lastStatus, required: on, hasCode: on && lastStatus.hasCode, state: on ? "unpaired" : lastStatus.state });
    if (on) $("pairCode").focus();
    await chrome.runtime.sendMessage({ type: "setRequirePairing", on }).catch(() => {});
    await refresh();
  });
}

// ---- Wiring ----
async function init() {
  state = await C.load();
  reflect();
  initProfile();
  initPairing();

  document.querySelectorAll("#presets button").forEach((b) => {
    b.addEventListener("click", async () => {
      state = C.applyPreset(b.dataset.preset, state);
      await C.save(state);
      reflect();
    });
  });

  $("cursorEnabled").addEventListener("change", async (e) => {
    state.cursorEnabled = e.target.checked;
    state.preset = matchPreset(state);
    await C.save(state);
  });

  $("fastMode").addEventListener("change", async (e) => {
    state.agentSpeed = e.target.checked ? "fast" : "watch";
    await C.save(state);
    reflect();
  });

  $("fullAuto").addEventListener("change", async (e) => {
    state.approvalMode = e.target.checked ? "auto" : "ask";
    await C.save(state);
    reflect();
  });

  $("cleanup").addEventListener("click", async () => {
    const msg = $("cleanupMsg");
    msg.textContent = "Closing…";
    const res = await chrome.runtime.sendMessage({ type: "closeAgentWindows" });
    msg.textContent = res && res.error
      ? `Couldn't close: ${res.error}`
      : res && res.closed
        ? `Closed ${res.closed} agent window${res.closed === 1 ? "" : "s"}.`
        : "No agent windows open.";
  });

  $("adv").addEventListener("click", () => {
    if (chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage();
    else window.open(chrome.runtime.getURL("options.html"));
  });
}

init();
