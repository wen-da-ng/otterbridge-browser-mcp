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
  refreshFlows();
}

// ---- Flows: record this tab, saved flows ----
// The recording itself lives in the background (it outlives the popup); this
// shows its state on the same live refresh as the connection.
let popupTabId = null;
let nameTouched = false; // the user edited the name: the refresh mustn't overwrite it
let flowsKey = "";
let recBusy = false;

const flowMsg = async (type, extra = {}) => {
  try {
    return (await chrome.runtime.sendMessage({ type, ...extra })) || {};
  } catch (e) {
    return { error: e.message };
  }
};
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

async function refreshFlows() {
  if (popupTabId == null || recBusy) return;
  const st = await flowMsg("rec:popup", { tabId: popupTabId });
  if (st.error || !st.rec) return;
  const rec = st.rec;
  $("recIdle").hidden = rec.recording || rec.stopped;
  $("recLive").hidden = !rec.recording;
  $("recSave").hidden = !rec.stopped;
  $("recStart").disabled = !st.canRecord;
  $("recStartWrap").title = st.canRecord ? "" : st.reason;
  if (rec.recording) {
    $("recText").textContent = `Recording · ${plural(rec.steps, "step")}`;
    setSub($("recWhere"), rec.here ? ["", ""] : ["", `On ${rec.host}`]);
  } else if (rec.stopped) {
    if (!nameTouched && !$("recName").value) $("recName").value = st.defaultName || "";
    setSub($("recWhere"), ["", `${plural(rec.steps, "step")} from ${rec.host}`]);
  } else {
    nameTouched = false;
    $("recName").value = "";
    setSub($("recWhere"), ["", ""]);
  }
  if (recError && Date.now() < recError.until) setSub($("recWhere"), ["danger", recError.text]);
  renderFlowList(st.flows || []);
}

function renderFlowList(flows) {
  const key = JSON.stringify(flows.map((f) => [f.name, f.steps]));
  if (key === flowsKey) return;
  flowsKey = key;
  const ul = $("flowList");
  ul.textContent = "";
  for (const f of flows.slice(0, 5)) {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.className = "flow-name";
    name.textContent = f.name;
    name.title = f.startUrl ? `${f.name} — ${f.startUrl}` : f.name;
    const steps = document.createElement("span");
    steps.className = "flow-steps";
    steps.textContent = `· ${plural(f.steps, "step")}`;
    const del = document.createElement("button");
    del.className = "flow-del";
    del.textContent = "✕";
    del.title = "Delete";
    del.setAttribute("aria-label", `Delete the flow ${f.name}`);
    del.addEventListener("click", async () => {
      if (!confirm(`Delete the saved flow "${f.name}"?`)) return;
      await flowMsg("flows:delete", { name: f.name });
      refreshFlows();
    });
    li.append(name, steps, del);
    ul.append(li);
  }
  setSub($("flowMore"), ["", flows.length > 5 ? `and ${flows.length - 5} more` : ""]);
  $("flowHint").hidden = flows.length === 0;
}

let recError = null; // { text, until }: kept on screen through the live refresh
async function flowAction(fn) {
  recBusy = true;
  try {
    const res = await fn();
    recError = res && res.error ? { text: res.error, until: Date.now() + 5000 } : null;
  } finally {
    recBusy = false;
  }
  refreshFlows();
}

async function initFlows() {
  try {
    const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
    popupTabId = t ? t.id : null;
  } catch (_) {}
  $("recStart").addEventListener("click", () => flowAction(() => flowMsg("rec:start", { tabId: popupTabId })));
  $("recStop").addEventListener("click", () => flowAction(() => flowMsg("rec:stop")));
  $("recDiscard").addEventListener("click", () => flowAction(() => flowMsg("rec:discard")));
  $("recName").addEventListener("input", () => { nameTouched = true; });
  const save = () => flowAction(async () => {
    const name = $("recName").value.trim();
    let res = await flowMsg("rec:save", { name });
    if (res.exists) {
      if (!confirm(`Replace the saved flow "${res.name}"?`)) return {};
      res = await flowMsg("rec:save", { name, replace: true });
    }
    if (!res.error) { nameTouched = false; $("recName").value = ""; }
    return res;
  });
  $("recSaveBtn").addEventListener("click", save);
  $("recName").addEventListener("keydown", (e) => { if (e.key === "Enter") save(); });
  refreshFlows();
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
  initFlows();
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
