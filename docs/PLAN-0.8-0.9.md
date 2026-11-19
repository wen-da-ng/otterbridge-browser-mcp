# Implementation plan: bridge pairing, extension-side gate check, web-app analysis tools

Written against commit `94a29f6` (v0.7.0). Line numbers below refer to that commit; re-locate by the quoted identifiers if they have moved.

**Two releases, in this order:**

| Release | Phases | What ships |
|---|---|---|
| 0.8.0 | A + B | Bridge pairing (shared secret), extension-side gate check |
| 0.9.0 | C | `perf_audit`, `perf_record`, `throttle`, `css_coverage` |

Finish and hand over 0.8.0 before starting Phase C. Each phase ends with a checkpoint where the user must act (reload the extension, reconnect the MCP client).

---

## 0. Ground rules for whoever implements this

1. **Never `git commit`, `git branch`, `git tag` or push.** The user commits manually. Leave changes in the working tree.
2. **Do not start a long-running server for the user.** `npm test` (which spawns short-lived servers itself) is fine. If port 8000 or 18765–18774 is busy, stop and tell the user instead of killing processes.
3. **Windows 11, PowerShell.** Paths use `os.homedir()` / `path.join`; never hard-code `/` home paths.
4. **The extension is plain JS with no build step and no ES modules.** `background.js` uses `importScripts("config.js")`. Do not add `import`/`export` to any file under `extension/`.
5. **The server is one file, `server/src/index.ts`.** Keep it one file. Match its style: comments explain *why*, user-facing strings are plain English.
6. **Do not change behaviour that this plan does not name.** In particular keep: tab ownership / read-only rules, `withTabLock`, `raceDialog`, profile routing, registry takeover, session numbers, the `expectText` re-check in `click`.
7. **Stderr only.** In `--stdio` mode stdout is the MCP channel. Use `log()`, never `console.log`, in the server.
8. **The pairing code is a secret.** It must never appear in: a tool result, a thrown `Error` message that reaches the model, the audit log, or stderr. The only places it may appear are the pairing file, an MCP *elicitation* message (shown to the human, not the model), the stdout of the explicit `--pairing-code` CLI flag, and the extension's own storage.
9. If something in this plan turns out to be impossible as written (an API behaves differently), stop at that step, keep everything else working, and report it to the user. Do not invent a different design.

---

## Phase A — Bridge pairing

### A.1 Why, and what it does and does not protect

Today the extension dials `ws://localhost:8765` and obeys whatever answers; it also sends that listener the profile name and Google account email. The server accepts any client that sends no `Origin` header as "the extension". The approval gate lives in the server, so a process that takes a bridge port gets ungated control of the user's logged-in Chrome.

After this phase both sides prove knowledge of one shared secret before anything else is exchanged.

Be accurate about the limit in docs and changelog: the secret sits in a file in the user's home directory, so a program running **as the same user with file access** can read it. Pairing protects against: other OS users on the machine, containers/VMs/WSL sharing loopback, sandboxed apps, any unrelated program that happens to listen on those ports (which today receives the user's email), and local clients impersonating the extension. Do not claim more than this.

### A.2 The secret and its file

- Directory: `OTTERBRIDGE_HOME` env var if set, else `path.join(os.homedir(), ".otterbridge")`. Create with `mkdir(..., { recursive: true, mode: 0o700 })`.
- File: `<dir>/pairing.json`, content `{"v":1,"code":"XXXX-XXXX-XXXX-XXXX-XXXX"}`, written with mode `0o600`.
- Code: 20 characters from the Crockford base32 alphabet `0123456789ABCDEFGHJKMNPQRSTVWXYZ` (no I, L, O, U), generated from `crypto.randomBytes` (use rejection-free mapping: take 20 bytes, `alphabet[byte & 31]`). Displayed in 5 groups of 4 joined by `-`.
- **Normalisation** (both sides, before any use): uppercase; map `O`→`0`, `I`→`1`, `L`→`1`; remove every character not in the alphabet. Valid only if exactly 20 characters remain.
- **HMAC key** = UTF-8 bytes of the normalised 20-character string.
- Creation must be race-safe, because several server processes can start at once: open with flag `"wx"` (exclusive create). On `EEXIST`, read the existing file; if it fails to parse, retry the read up to 5 times, 100 ms apart, then fail with a clear startup error. Never overwrite an existing file.
- Load once at startup into a module constant, before `startBridge()`.

### A.3 Handshake (protocol v2)

All messages are JSON text frames. `port` is always **the port of the listener the socket is connected to** — the server takes it from the listener (pass it into `onConnection` through a closure when attaching the `"connection"` handler in `startBridge` and `becomeRegistry`); the extension takes it from the `port` argument of `connectPort`. Binding the port into the MAC is what stops a rogue listener on one port from relaying the handshake to the real server on another. Do not drop it.

Nonces: 16 random bytes, lowercase hex. MACs: HMAC-SHA256, lowercase hex.

```
server → ext   {"type":"challenge","v":2,"nonce":"<Ns>"}                    sent immediately on connection
ext → server   {"type":"auth","v":2,"nonce":"<Ne>","mac":"<M1>"}            if the extension has a code
               {"type":"unpaired","v":2}                                    if it has none
server → ext   {"type":"auth_ok","mac":"<M2>"}                              on success
               {"type":"auth_failed","reason":"mismatch"|"locked"}          then close(4401)

M1 = HMAC(key, "otterbridge/v2/ext|" + Ns + "|" + Ne + "|" + port)
M2 = HMAC(key, "otterbridge/v2/srv|" + Ns + "|" + Ne + "|" + port)
```

Server rules (`onConnection`, non-`/register` path, currently `server/src/index.ts:327-395`):

- A socket starts **unauthenticated**. Until `auth` succeeds it must **not** be added to `extSockets` or `profiles`, must **not** receive `bridges`, `ping` or any command, and every message other than `auth` / `unpaired` is ignored. Today the socket is registered as an unnamed profile at once (lines 327-338); move all of that to after successful auth.
- Compare `M1` with `crypto.timingSafeEqual` on equal-length buffers (reject on length mismatch first).
- On `unpaired`: add the socket to a module-level `unpairedSockets` set (removed on close). Keep it open. Send it nothing further.
- No `auth`/`unpaired` within 5000 ms of connecting: record `lastLegacyKnock = Date.now()` and close with code 4400. (This is what a 0.7.0 extension looks like: it sends `hello` and never answers the challenge.)
- Failed MAC: record `lastMismatch = Date.now()`, reply `auth_failed` `mismatch`, close. Keep a global list of failure timestamps; with 5 or more in the last 60 s, answer every `auth` with `auth_failed` `locked` without checking it.
- After `auth_ok`, behave exactly as today from line 327 on (unnamed profile until `hello`, `sendBridges`, message handler, close handler).

Extension rules (`connectPort`, currently `extension/background.js:116-150`):

- On open: send nothing. Start a 4000 ms timer.
- First message must be `challenge` with `v === 2`. If the timer fires first, or the first message is anything else: close, set that port's state to `"old-server"`, and do not dial that port again for 30 s.
- With a code stored: reply `auth`, then wait for `auth_ok`; verify `M2`. Only after `M2` verifies: mark the socket trusted, call `sayHello(sock)`, and start honouring `bridges`, `ping` and commands. If `M2` is wrong or `auth_failed` arrives: close, set state `"mismatch"`, do not dial that port again for 30 s.
- With no code stored: reply `unpaired`, set state `"unpaired"`, and ignore everything else on that socket.
- **Nothing else may be processed on an untrusted socket** — in particular not `bridges` (it tells the extension where to dial) and not commands. Guard at the top of `onmessage`.
- HMAC via `crypto.subtle.importKey("raw", …, { name: "HMAC", hash: "SHA-256" }, false, ["sign"])` and `crypto.subtle.sign`.
- Code lives in `chrome.storage.local` under `pairingCode` (already normalised). At worker start call `chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })` in a try/catch, so content scripts cannot read it. (Verified: `content.js` does not use `storage.local`; only `background.js` and `popup.js` do.)
- When `pairingCode` changes (`chrome.storage.onChanged`, area `local`): close every socket, clear all per-port back-off and state, call `scanBridges()`.
- `sayHello` gains one field: `version: chrome.runtime.getManifest().version`.

### A.4 Server-to-server registration

`/register` (lines 295-325) gets the same protection so only a paired server can make the registry advertise a port.

- Registrant URL becomes `ws://localhost:<BASE>/register?port=<N>&ts=<Date.now()>&mac=<M>` with `M = HMAC(key, "otterbridge/v2/reg|" + N + "|" + ts)`.
- Registry rejects (closes) unless the MAC verifies and `|Date.now() - ts| < 60000`. Existing checks (`isRegistry`, port in range, port ≠ base) stay.
- A new server meeting an old registry (or the reverse) will fail to register. That is acceptable: all clients on one machine run the same installed version after an update. Mention it in the changelog ("restart all AI clients after updating").

### A.5 HTTP MCP endpoint

`startHttp` (lines 2116-2217) currently lets any local process drive the browser.

- Require `Authorization: Bearer <code>` on every `/mcp` request. Normalise the presented value as in A.2 and compare SHA-256 digests with `timingSafeEqual`. On failure: `401`, JSON-RPC error body with message `Unauthorized: add the header "Authorization: Bearer <pairing code>" (run "node dist/index.js --pairing-code" to see the code).`
- Check order: host/origin guard first (existing, 403), then bearer (401).
- stdio mode is unaffected.
- New CLI flag: `node dist/index.js --pairing-code` prints the formatted code to **stdout** and exits 0, before binding any port. This is the one sanctioned way to show the code in a terminal.

### A.6 Getting the code to the human

The model must never see the code (rule 0.8). Flow:

1. `waitForProfile` (lines 473-494): when it is about to throw "Chrome extension is not connected", choose the message by what was seen, in this priority:
   - `unpairedSockets.size > 0` → throw a new `PairingNeededError` (a subclass of `Error`).
   - `Date.now() - lastMismatch < 60000` → "The pairing code saved in the Otter extension doesn't match this computer's code. Ask the user to open the Otter popup in Chrome and enter the code again."
   - `Date.now() - lastLegacyKnock < 15000` → "The Otter Chrome extension is older than this OtterBridge server. Ask the user to update the extension to <server version> and reload it at chrome://extensions."
   - otherwise the existing message.
2. In `buildServer`, wrap `cmd` (lines 775-780) so that a `PairingNeededError` from `profileFor()` or `sendCmd()` triggers `promptPairing()` and then **one** retry of the same command.
3. `promptPairing()`:
   - Deduplicate concurrent calls with a per-session in-flight promise (parallel tool calls must produce one prompt).
   - If this session already prompted within the last 120 s, skip the prompt and throw the plain text error from step 5.
   - Call `server.server.elicitInput({ message, requestedSchema: { type: "object", properties: {} } })` with this message:
     ```
     Otter needs a one-time pairing code before it can control Chrome.

     1. Click the Otter icon in Chrome's toolbar.
     2. Paste this code and press Pair:

         XXXX-XXXX-XXXX-XXXX-XXXX

     Then press Accept here.
     ```
   - `accept` → wait up to 30 s for a connected profile (reuse `waitForProfile` with `ms = 30000`), then let the retry run.
   - `decline` / `cancel` → throw `Error("The user cancelled pairing. Ask them whether to continue; the browser can't be used until the Otter extension is paired.")`.
4. If `elicitInput` throws (client cannot elicit): throw the step-5 error.
5. Plain error text (no code in it): `The Otter extension is installed but not paired with this computer yet. Ask the user to open the file <absolute path to pairing.json>, copy the code, click the Otter icon in Chrome and paste it there.`
6. `list_profiles` does not go through `cmd`. Add `unpaired_extension_waiting: true` to its JSON when `unpairedSockets.size > 0`.
7. Audit every pairing event with `audit("pairing", undefined, "<event>")` — events only, never the code.

### A.7 Extension UI

Popup (`popup.html`, `popup.js`): a block directly under the header, driven by a status the background reports.

- Background answers `chrome.runtime.sendMessage({ type: "pairingStatus" })` (add to the existing `onMessage` listener near line 583) with `{ hasCode: boolean, state }` where `state` is the best state over all ports: `"connected"` (at least one trusted socket) > `"mismatch"` > `"unpaired"` > `"old-server"` > `"idle"` (nothing listening).
- Not paired or mismatch: show a text input (placeholder `XXXX-XXXX-XXXX-XXXX-XXXX`), a **Pair** button and one hint line. Hints: unpaired → "Ask your AI to open any website — it will show you the pairing code."; mismatch → "That code doesn't match this computer's. Paste it again."; old-server → "The OtterBridge server is out of date — update it and restart your AI app."
- Pair: normalise; if not 20 characters show "That doesn't look like a pairing code." and store nothing; else `chrome.storage.local.set({ pairingCode })`, then poll status for up to 5 s and show "Paired ✓" or the mismatch hint.
- Paired and connected: one muted line "Paired with this computer ✓" and a small "Change code" link that reveals the input again.
- Options page: no pairing UI needed. Do not add the code to `OtterConfig`/`chrome.storage.sync` — it must not roam between machines.
- Toolbar: when state is `"unpaired"` or `"mismatch"`, show badge text `!` with a red background. `reflectApprovalMode()` (lines 52-70) currently forces the badge to `""`; make one function own the badge so the two don't fight: pairing attention wins, otherwise current behaviour.

### A.8 Tests

All seven suites in `server/test/` contain a hand-rolled fake extension; all would break.

- New `server/test/_ext.mjs` exporting:
  - `useTempHome()` — creates a temp dir, sets `process.env.OTTERBRIDGE_HOME` (spawned servers inherit it), returns the dir. **Every suite calls this first**, so tests never touch the user's real `~/.otterbridge`.
  - `pairingCode()` — reads the code from that dir (poll until the spawned server has created it).
  - `connectFakeExtension(port, { onCommand, hello })` — performs the v2 handshake, optionally sends `hello`, routes commands to `onCommand(msg) → result`, ignores `bridges`/`ping` but exposes announced ports. Returns `{ ws, seen, announced }`.
  - `bearer()` — `{ requestInit: { headers: { Authorization: "Bearer <code>" } } }` for `StreamableHTTPClientTransport`.
- Convert every suite to these helpers. Do not change what each suite asserts, except tool counts (Phase C).
- Also check `server/demo/*.mjs`; update any fake extension or HTTP client there the same way.
- New `server/test/pairing.mjs`, added to the `test` script in `server/package.json`:
  1. correct code → `auth_ok`, a tool call round-trips;
  2. wrong code → `auth_failed` `mismatch`, socket closed, a tool call fails with the "doesn't match" text;
  3. `unpaired` → tool call (client without elicitation support) fails with the pairing text, **and that text does not contain the code**;
  4. client **with** elicitation support: the elicitation message contains the code, the tool result does not; pairing a fake extension before answering `accept` makes the original call succeed;
  5. silent client (0.7.0 behaviour: sends `hello`, never `auth`) → closed after ~5 s, never listed by `list_profiles`, receives no command;
  6. MAC computed with a different port → rejected (the relay defence);
  7. 5 failures → sixth is `locked`;
  8. `/register` without or with a bad MAC → closed, port not announced;
  9. HTTP without bearer → 401; with → passes;
  10. `--pairing-code` prints the code and exits 0.
- Extend `security.mjs`: "WS accepts no-origin native client" now means *the TCP/WS connection opens*; add that it receives nothing but `challenge`.

### A.9 Docs

- README: install step for pairing (after step 3: "the first time you ask Claude to use the browser it shows a pairing code — paste it into the Otter popup"); Security section (what pairing does and its limit, per A.1); developer Option B command with `--header "Authorization: Bearer <code>"`; troubleshooting entries for "not paired", "code doesn't match", "extension older than server".
- `server/README.md`: remove "byte-compatible with the Python server"; document `OTTERBRIDGE_HOME`, `--pairing-code`.
- `legacy/README.md`: one line — the Python server does not speak pairing and no longer works with extension ≥ 0.8.0.

---

## Phase B — Extension-side gate check ("light" version)

### B.1 Scope — read this before writing any code

**Approval prompts stay exactly where they are**: in the server, through MCP elicitation, shown in the AI client. `approved()`, `BROWSER_AGENT_GATE`, `BROWSER_AGENT_GATE_FALLBACK`, the `.mcpb` checkboxes and Full Auto all keep their current behaviour. Do **not** add any approval UI to the extension.

What is added: the extension independently recognises a gated action and refuses to perform it unless the command carries `gated: true`. This catches a server code path that forgets to gate. It does not stop a server that lies; pairing (Phase A) is what keeps untrusted servers out.

### B.2 One danger pattern, two copies, kept identical by a test

- `extension/config.js`: add to `OtterConfig`
  - `DANGER_SOURCE` — the exact regex source of `DANGER_RE` at `server/src/index.ts:52-53`, flags `i`;
  - `isDanger(text)`;
  - `refuseUngated({ kind, text, gated, approvalMode })` → boolean, a pure function:
    - `approvalMode === "auto"` → `false`
    - `gated === true` → `false`
    - `kind === "click"` → `isDanger(text)`
    - `kind === "dialog"` → `isDanger(text)` (caller only asks for an accepted, non-alert dialog)
    - `kind === "dialog_unread"`, `"upload"`, `"eval"` → `true`
- New `server/test/gate.mjs` (add to the `test` script):
  - loads `extension/config.js` with `createRequire(import.meta.url)` (it is a classic script whose IIFE attaches `OtterConfig` to `this`, i.e. `module.exports` under CommonJS) and checks the truth table above;
  - reads `server/src/index.ts` as text, extracts the `DANGER_RE` literal, and asserts its source equals `OtterConfig.DANGER_SOURCE`. This is what keeps the two copies in sync — do not skip it.

### B.3 Server: say when the gate ran

Add `gated: true` to the command params only on the paths where `approved()` returned true:

| Where | Change |
|---|---|
| `gatedClick` (lines 902-955) | track `let gated = false`; set it to `true` after `approved()` passes for the current `expectText`; reset to `false` whenever `expectText` changes; send `gated` with the `click` command. |
| `answerDialog` (lines 960-982) | pass `gated: true` to `handle_dialog` in the two branches that called `approved()`. |
| `evaluate_js` tool (line 1470) | pass `gated: true`. |
| `upload_file` tool (line 1852) | pass `gated: true` on the real call (not on the `dryRun` probe). |

In `gatedClick`, handle a new reply shape `{ changed: true, ungated: true, actualText }` **before** the generic `changed` branch: if `actualText !== expectText`, set `expectText = actualText` and `continue` (the loop then gates it); otherwise return `"Click refused by the browser extension: '<text>' looks destructive and was not approved."` and audit it.

### B.4 Extension: refuse ungated actions

`extension/background.js`, all inside `perform()`:

- **`click`** (lines 1300-1376). After the final identity check and before `pulse(tab.id)`: for a **left** click, take the live text (`hit.text` on the index path; on the coordinate path call `hitTestAll` even when `guard` is false) and, if `OtterConfig.refuseUngated({ kind: "click", text, gated: p.gated, approvalMode: S.approvalMode })`, return `{ changed: true, ungated: true, actualText: text, x, y }` without pressing. If the live text cannot be determined (no page library on that tab), allow the click as today. Right clicks are never refused (same reasoning as the server comment at lines 891-894).
- **`handle_dialog`** (lines 1753-1781), only when `p.accept` is true: if a dialog record exists and its type is not `alert`, use kind `"dialog"` with its message; if no record exists, use kind `"dialog_unread"`. On refusal `throw new Error("Refused: accepting this dialog needs the user's approval.")`.
- **`evaluate_js`** (lines 1711-1744): after the `allowJsEval` check, kind `"eval"`; on refusal throw `"Refused: evaluate_js needs the user's approval."`.
- **`uploadFile`** (lines 1935-1981): after the `p.dryRun` early return, kind `"upload"`; on refusal throw `"Refused: uploading files needs the user's approval."`.

### B.5 Tests

- `gate.mjs` as in B.2.
- In `env.mjs` (gate off) assert the fake extension received `gated: true` on the destructive click.
- In the suite that already exercises elicitation (find it with `grep -n elicit server/test/*.mjs`): approve → `click` carries `gated: true`; a click on non-danger text carries no `gated: true`.
- Fake extension replying `{ changed: true, ungated: true, actualText: "Delete" }` to a click whose text was "Home": the server must then ask for approval for "Delete" (or deny when it cannot elicit).

### B.6 Known gap, deliberately not fixed here

`press_key("Enter")` in a form field submits the form without any approval, and so do `fill_element` and `type_text` into fields that auto-submit. This plan does not change that. Do not try to fix it in passing; note it in the changelog's "known limitations" so it is not forgotten.

---

## Checkpoint: release 0.8.0

1. Bump `0.7.0` → `0.8.0` in: `server/package.json`, `server/package-lock.json` (both `version` fields at the top), `server/manifest.json`, `extension/manifest.json`, `server/src/index.ts` (the `McpServer` constructor). Check with `grep -rn "0\.7\.0"` excluding `CHANGELOG.md` and `node_modules`.
2. `CHANGELOG.md`: new `## 0.8.0 — <date>` section in the existing voice — Added (pairing; `--pairing-code`; extension refuses ungated destructive actions), Changed (HTTP endpoint needs the bearer header; restart all AI clients after updating; Python server no longer compatible), Security (what pairing covers and its limit), Known limitations (B.6).
3. In `server/`: `npm test`. All suites must pass.
4. `npm run pack` to rebuild `server/otterbridge-browser.mcpb` (it is committed and linked from the README). If the pack step cannot run, say so.
5. **Stop and ask the user to:** reload the extension at `chrome://extensions`; reconnect the MCP client (`/mcp` in Claude Code); if they use the HTTP transport, re-add the server with the bearer header. Then verify live with the OtterBridge tools: the first call must produce the pairing prompt; after pairing, open a page and click an ordinary link (works) and a button labelled Delete/Submit on a test page (asks for approval).
6. Do not start Phase C until the user confirms 0.8.0 works.

---

## Phase C — Web-app analysis tools

### C.1 What Chrome allows (verified against the `chrome.debugger` documentation)

An extension may only use these debugger domains: Accessibility, Audits, CacheStorage, Console, CSS, Database, Debugger, DOM, DOMDebugger, DOMSnapshot, Emulation, Fetch, IO, Input, Inspector, Log, Network, Overlay, Page, Performance, Runtime, Storage, Target, Tracing, WebAudio, WebAuthn.

**`Profiler` and `HeapProfiler` are not available.** Consequences, already designed around below — do not attempt these:

- no JavaScript coverage (it needs `Profiler.startPreciseCoverage`) → CSS coverage only;
- no CPU profile → script attribution comes from the browser's `long-animation-frame` performance entries, which name the script URL and function behind each slow frame;
- no heap snapshot or forced garbage collection → memory is reported as heap-size and DOM-node deltas from `Performance.getMetrics`, labelled as approximate.

### C.2 General rules for all four tools

- Each is a new `case` in `perform()` in `background.js` plus a `tool(...)` registration and a `META` row in `index.ts`. They go through `handle()` unchanged, so ownership (own tabs only — none of these is in `READ_ONLY`), the tab lock and dialog racing apply automatically.
- Enable extra debugger domains lazily inside the action (`Performance.enable`, `DOM.enable` + `CSS.enable`), not in `ensureDebugger`.
- **Degrade, don't fail.** Wrap each optional data source in try/catch; on failure put a string in the report's `unavailable` array (e.g. `"cpu throttling: <error message>"`) and continue. Only fail the whole call when the page cannot be loaded at all.
- Page-side measurement code is fixed code shipped in `extension/page.js` (as new `window.__otter` methods), run with `chrome.scripting.executeScript` in the top frame (`frameIds: [0]`) in the default isolated world. It is **not** model-supplied code and does **not** go through `evaluate_js` or its gate.
- Outputs are JSON text, compact, with every list capped (10 items unless stated). Durations in ms, sizes in bytes, rounded to integers.
- Per-tab state these tools add (`throttleState`, `cssTracking`, `perfRec`) must be deleted in the existing `chrome.tabs.onRemoved` listener (lines 278-285) and in `chrome.debugger.onDetach` (line 196), because a detach silently ends throttling and tracking.

### C.3 Richer network capture (prerequisite)

In the `chrome.debugger.onEvent` listener (lines 219-276), store extra fields **under one sub-object `perf`** on each network entry, and strip `perf` in `read_network` (line 1680: add it to the destructured fields that are dropped) so `read_network` output is unchanged.

| Event | Add to `entry.perf` |
|---|---|
| `Network.requestWillBeSent` | `t0: params.timestamp`, `initiator: params.initiator && params.initiator.type` |
| `Network.responseReceived` | `protocol`, `fromCache: !!(r.fromDiskCache \|\| r.fromPrefetchCache)`, `fromSW: !!r.fromServiceWorker`, `enc` (content-encoding header), `cache` (cache-control header), `waitMs` (`timing.receiveHeadersEnd - timing.sendEnd` when `timing` exists) — look headers up case-insensitively |
| `Network.dataReceived` (new branch) | `decoded += params.dataLength` |
| `Network.loadingFinished` | `t1: params.timestamp` |

Raise `NETWORK_CAP` from 300 to 1000 so a heavy page load fits. `read_network`'s `limit` currently clamps to `NETWORK_CAP`; clamp it to a new constant `NETWORK_READ_MAX = 300` instead so its behaviour does not change.

### C.4 `throttle`

Tool: `throttle(network?, cpu?, reset?, tab?)` — META `{ title: "Throttle network / CPU", idem: true }`.

- `network`: `"offline" | "slow-3g" | "fast-3g" | "fast-4g" | "none"`. `cpu`: number 1–20 (slowdown multiplier, 1 = none). `reset: true` clears both. At least one argument is required.
- Presets for `Network.emulateNetworkConditions` (`offline`, `latency` ms, `downloadThroughput` / `uploadThroughput` bytes per second):

  | Preset | latency | download | upload |
  |---|---|---|---|
  | slow-3g | 2000 | 50000 | 50000 |
  | fast-3g | 563 | 180000 | 84375 |
  | fast-4g | 165 | 1012500 | 168750 |
  | offline | 0 | 0 | 0 (with `offline: true`) |
  | none | 0 | -1 | -1 |

- CPU: `Emulation.setCPUThrottlingRate({ rate })`.
- Implement as one helper `applyThrottle(tabId, { network, cpu })` that also records `throttleState.set(tabId, { network, cpu })` (delete the entry when both are off). `perf_audit` reuses it.
- Result text states what is now active and how to undo it, e.g. `Throttling this tab: network slow-3g, CPU 4× slower. It stays on until throttle(reset=true) or the tab closes.`
- Description must tell the model that throttling persists and to reset it when done.

### C.5 `perf_audit`

Tool: `perf_audit(url?, cold?, network?, cpu?, settle_ms?, tab?)` — META `{ title: "Performance audit", world: true }` (not read-only: it reloads the page). Bridge timeout 90 s.

- `url`: page to load; omitted → reload the tab's current page. `cold` (default true): bypass and disable the HTTP cache for the run. `network` / `cpu`: throttling applied **for this run only**. `settle_ms` (default 1000, max 10000): extra wait after the network goes quiet.
- Add `"perf_audit"` to the `VISIBLE` set (line 1035) so the tab is brought to the front of its window: a hidden tab does not paint, and paint metrics would be missing.

Sequence in the extension:

1. `ensureDebugger`; `Performance.enable`. Remember any existing `throttleState` for the tab.
2. Clear the tab's console and network buffers; note `auditStart = Date.now()`.
3. If `cold`: `Network.setCacheDisabled({ cacheDisabled: true })`. If `network`/`cpu` given: `applyThrottle`.
4. Load: `chrome.tabs.update(tab.id, { url })` or `chrome.tabs.reload(tab.id, { bypassCache: cold })`, then `waitForLoad(tab.id, 45000)`.
5. Network idle: poll every 100 ms until no network entry that started after `auditStart` is still unfinished (no `doneMs` and no `error`) for 500 ms; cap 10 s. Then sleep `settle_ms`.
6. Collect, each in its own try/catch:
   - page metrics via new `__otter.perfCollect()` (C.5.1);
   - `Performance.getMetrics`;
   - network entries with their `perf` data;
   - console entries of level `error` since `auditStart` (count + first 5 texts, each clipped to 200 chars).
7. **In a `finally`**: `Network.setCacheDisabled({ cacheDisabled: false })` and restore the remembered throttle state (or clear throttling if there was none). The tab must never be left throttled or cache-disabled by an audit.

#### C.5.1 `__otter.perfCollect()` in `page.js`

Returns a Promise. For each type in `["navigation", "paint", "largest-contentful-paint", "layout-shift", "longtask", "long-animation-frame", "resource"]` that is in `PerformanceObserver.supportedEntryTypes`, create an observer with `{ type, buffered: true }`, gather entries, and resolve after one `setTimeout(…, 0)` tick (buffered entries are delivered asynchronously); disconnect all observers. Return:

- `visibility`: `document.visibilityState`
- `ttfb` (`responseStart`), `dom_content_loaded`, `load` — from the navigation entry
- `fcp` — the `first-contentful-paint` paint entry
- `lcp`: `{ time, size, element, url }` from the **last** LCP entry; `element` is a short descriptor: tag name plus `#id` or the first two classes, clipped to 80 chars
- `cls`: the largest *session window* of layout shifts — ignore entries with `hadRecentInput`; a window continues while the gap to the previous shift is under 1 s and the window is under 5 s long; report the maximum window sum, 3 decimals
- `tbt`: sum of `duration - 50` over `longtask` entries starting after `fcp`
- `long_frames`: the 10 longest `long-animation-frame` entries as `{ start, duration, blocking: blockingDuration, scripts: [{ url: sourceURL, fn: sourceFunctionName, invoker, duration }] }`, at most 3 scripts each, URLs clipped to 120 chars
- `render_blocking`: `name` of resource entries whose `renderBlockingStatus === "blocking"`
- `dom`: `{ nodes: document.getElementsByTagName("*").length, max_depth }`

If `executeScript` does not deliver the awaited value in the user's Chrome, fall back to two calls (start observers and stash on `window.__otterPerf`; read after 50 ms). Decide by testing, and say which one was used.

#### C.5.2 Report shape

```json
{
  "url": "…", "cold": true, "throttle": { "network": "none", "cpu": 1 },
  "warnings": ["…"], "unavailable": ["…"],
  "metrics": { "ttfb": 0, "fcp": 0, "lcp": 0, "cls": 0.0, "tbt": 0,
               "dom_content_loaded": 0, "load": 0 },
  "lcp_element": { "element": "img#hero", "url": "…", "size": 0 },
  "page": { "dom_nodes": 0, "dom_max_depth": 0, "js_heap_bytes": 0,
            "script_ms": 0, "layout_ms": 0, "style_recalc_ms": 0 },
  "network": { "requests": 0, "transfer_bytes": 0, "decoded_bytes": 0,
               "by_type": { "script": { "requests": 0, "transfer_bytes": 0 } },
               "third_party": [{ "host": "…", "requests": 0, "transfer_bytes": 0 }],
               "largest": [{ "url": "…", "type": "…", "transfer_bytes": 0 }],
               "slowest": [{ "url": "…", "type": "…", "ms": 0, "wait_ms": 0 }],
               "failed": [{ "url": "…", "status": 0, "error": "…" }] },
  "long_frames": [ … ],
  "console_errors": { "count": 0, "first": ["…"] },
  "findings": [{ "severity": "high|medium|low", "what": "…", "evidence": "…" }]
}
```

- Build the report **in the server** from raw data returned by the extension, so the rules are type-checked and testable with a fake extension. The extension returns `{ page, cdpMetrics, requests, consoleErrors, visibility, throttle, unavailable }`.
- `third_party`: hosts whose registrable domain differs from the page's — approximate with "last two labels of the hostname differ"; say "approximate" in the tool description rather than adding a public-suffix list.
- URLs in the report are clipped to 120 characters and stripped of their query string and fragment (queries can carry tokens).
- `warnings`: add `"The tab was hidden during the audit, so paint metrics (FCP, LCP, CLS) are missing or unreliable. Bring the Otter window into view and run again."` when `visibility !== "visible"` or `fcp` is missing.

#### C.5.3 Findings rules

Emit a finding only when its condition holds; order high → medium → low; cap 15. `evidence` names the numbers and up to 3 URLs.

| Condition | Severity |
|---|---|
| LCP > 4000 ms / > 2500 ms | high / medium |
| CLS > 0.25 / > 0.1 | high / medium |
| TBT > 600 ms / > 200 ms | high / medium |
| TTFB > 1800 ms / > 800 ms | high / medium |
| any render-blocking resource | medium |
| text response (script, stylesheet, document, or mime containing `json`, `svg`, `xml`) over 1400 decoded bytes with no content-encoding and not from cache | medium |
| image over 200 000 transfer bytes | medium |
| single script over 300 000 transfer bytes | medium |
| same URL requested more than once | low |
| static asset (script, stylesheet, image, font) with no `cache-control`, or with `no-store` / `max-age=0` | low |
| any request with status ≥ 400 or a load error | medium |
| document served over `http/1.1` | low |
| DOM nodes > 3000 / > 1500 | medium / low |
| a long frame over 200 ms with a script attribution | medium (evidence: script URL + function) |
| console errors during load > 0 | low |
| total transfer > 3 000 000 bytes | medium |

Tool description: say what it returns, that it reloads the page, that numbers come from one run on this machine (lab data, vary run to run), and that the model should run it before and after a change to compare.

### C.6 `perf_record`

Measures an interaction instead of a page load; also the memory-leak check.

Tool: `perf_record(action: "start" | "stop", tab?)` — META `{ title: "Record interaction performance" }`.

- **start**: `Performance.enable`; store `perfRec.set(tabId, { t: Date.now(), metrics: <Performance.getMetrics>, url: tab.url })`; run new `__otter.perfRecStart()`, which installs live observers for `longtask`, `long-animation-frame`, `layout-shift` and `event` (`durationThreshold: 40`) writing into an array on `window`, and records `performance.now()`. Returns `"Recording. Perform the interaction, then call perf_record(action='stop')."`
- **stop**: error `"No recording in progress — call perf_record(action='start') first."` if none. Otherwise run `__otter.perfRecStop()` (returns and clears the entries; if the array is gone because the page navigated, return `{ navigated: true }` and let the server add a warning), take `Performance.getMetrics` again, and collect network entries with `startMs` ≥ the recording start.
- Report: `{ duration_ms, warnings, slowest_interactions: [{ type: entry.name, duration, target }]` (10 longest `event` entries)`, long_frames` (as in C.5.1)`, cls, deltas: { script_ms, layout_ms, style_recalc_ms, js_heap_bytes, dom_nodes }, requests: { count, transfer_bytes, slowest: […] } }`.
- Description must explain the leak check: start → repeat an action several times → stop; steadily growing `dom_nodes` across repeated recordings suggests a leak; heap numbers are approximate because garbage collection cannot be forced.

### C.7 `css_coverage`

Tool: `css_coverage(action: "start" | "stop", tab?)` — META `{ title: "CSS coverage" }`.

- **start**: `DOM.enable`, `CSS.enable`, `CSS.startRuleUsageTracking`; set `cssTracking`. Add a `CSS.styleSheetAdded` branch to the `onEvent` listener that records `header.styleSheetId → { url: header.sourceURL, length: header.length, inline: header.isInline }` per tab (existing sheets are announced when `CSS.enable` is called).
- **stop**: `CSS.stopRuleUsageTracking` → `ruleUsage: [{ styleSheetId, startOffset, endOffset, used }]`. Per stylesheet: `used_bytes` = sum of `endOffset - startOffset` over used rules; `unused_pct` = `1 - used_bytes / length`. Report `{ total_bytes, unused_bytes, unused_pct, sheets: [{ url, bytes, unused_bytes, unused_pct }] }`, sheets sorted by `unused_bytes` descending, capped at 15, inline sheets merged into one row labelled `(inline styles)`. Then `CSS.disable`.
- **Reload behaviour must be tested, not assumed.** Check live whether tracking started before a `reload` still reports usage for the reloaded page.
  - If it does: describe the tool as "start, then reload and/or interact, then stop".
  - If it does not: describe it as "start on the loaded page, interact, then stop — rules used only during the initial load count as unused, so treat the result as an upper bound", and add that sentence to the result as a `note`.
- The description must say that this is CSS only, and that JavaScript coverage is not available through a browser extension.

### C.8 Server wiring

- `META` (lines 651-688): four new rows as given above. Fix the stale comment "all 28 tools".
- Server `instructions` (lines 605-639): extend the debugging sentence to "…Debug web apps with read_console, read_network, get_network_body and evaluate_js; measure them with perf_audit (page load), perf_record (an interaction), css_coverage and throttle."
- If the extension answers `Unknown action: <name>` (an extension older than the server), turn it into: `The Otter Chrome extension is older than this server and doesn't support <tool>. Ask the user to update the extension and reload it at chrome://extensions.` Do this in one place — `sendCmd`, where `data.error` is thrown (line 522).
- `server/manifest.json` `tools` array: four entries. README: "Thirty-six tools" → forty, a new collapsible section "Measure & optimise (4)", and the roadmap. `server/README.md`: fix "28 tools".

### C.9 Tests

- `stdio.mjs:47` and `http.mjs:131`: 36 → 40 tools (the `http.mjs` list is ordered — insert the new names where they are registered).
- New `server/test/perf.mjs` (add to the `test` script), using a fake extension that returns canned raw data:
  - a "slow page" fixture produces the expected findings in severity order, and a "clean page" fixture produces none;
  - report URLs have no query string;
  - hidden-tab fixture produces the warning;
  - an `unavailable` entry from the extension is passed through;
  - `throttle` with no arguments returns the usage message and sends nothing to the extension;
  - an `Unknown action` reply becomes the "update the extension" message.
- The extension-side code cannot be covered by these suites. Verify it live (checkpoint below) and report exactly what was and was not verified.

---

## Checkpoint: release 0.9.0

1. Version bump `0.8.0` → `0.9.0` in the same five places; changelog section (Added: the four tools; Changed: network buffer 300 → 1000; Notes: lab data, CSS-only coverage and why).
2. `npm test`, then `npm run pack`.
3. **Stop and ask the user to** reload the extension and reconnect the MCP client. Then verify live, on a real page, and report each result:
   - `perf_audit` returns non-zero FCP/LCP and at least the network section; which `unavailable` entries appeared, if any;
   - `perf_audit` with `network: "slow-3g"` is clearly slower, and a following plain `read_page`/reload is back to normal speed (throttle restored);
   - `throttle` on and `reset`;
   - `perf_record` start → click something → stop returns a report;
   - `css_coverage` — and the outcome of the reload test in C.7;
   - with the Otter window fully covered by another window, whether the hidden-tab warning appears.

---

## Out of scope — do not build these now

Moving approval prompts into the extension; native messaging; per-site allow/block lists; prompt-injection filtering; gating of Enter-key form submits (B.6); flow recorder; session timeline; `a11y_audit`; `mock_request`; `read_storage`; `export_har`; Tracing-based profiles; Chrome Web Store packaging; npm publishing; moving or rotating `agent_actions.log`.
