# Implementation plan: flow recorder (0.10.0) and per-site rules (0.11.0)

Written against `v0.9.3` (commit `7d1a4b8`). Re-locate code by the quoted identifiers if line numbers have moved.

| Release | Phase | What ships |
|---|---|---|
| 0.10.0 | D | Flow recorder: record what you do in your own tab, save it as a named flow, replay it with variables |
| 0.11.0 | E | Per-site rules: block / read-only / always-ask sites, enforced by the extension, set only by the user |

Finish, verify live and hand over 0.10.0 before starting Phase E.

---

## 0. Ground rules (same as the 0.8/0.9 plan, plus lessons from it)

1. **Never `git commit`, `git tag` or push.** The user does that; give them the commands at each checkpoint.
2. **Don't start long-running servers.** `npm test` is fine. Never kill processes on ports 8000 / 8765–8774 / 18765–18774; ask instead.
3. **Windows 11 + PowerShell.** Use `os.homedir()` / `path.join`. When editing files through a shell heredoc, escapes like `\n` and `\s` get mangled — use the Edit tool or a script file, then `node --check` / `tsc --noEmit`.
4. **Extension = plain classic scripts, no build, no modules.** `config.js` attaches `OtterConfig` to `this` so Node tests can `require` it — follow that pattern for any new pure-logic file.
5. **`page.js` is one closure.** A second `function x` silently replaces the first (this broke `read_elements` in 0.9.0). `test/gate.mjs` guards it; keep names unique and **bump `VERSION` in `page.js`** whenever it changes, or pages keep the old copy.
6. **The server is one file** (`server/src/index.ts`). Report-building / pure logic lives at module level so tests can drive it through a fake extension.
7. **Nothing typed reaches the audit log** (`redact()` handles `text`/`code` params — make sure new params carrying typed values are named `text` or are added to `redact()`).
8. **Privacy:** passwords and other sensitive field values are never recorded, stored, sent to the server, or shown to the model.
9. **The approval gate stays authoritative** (server prompts, extension refuses unmarked destructive actions). Nothing in this plan may add a path that acts without going through it.
10. Each checkpoint needs a **live check in the user's Chrome**; the Node suites can't drive Chrome. Report exactly what was and wasn't verified.
11. If something in this plan proves impossible as written, stop at that step, keep everything else working, and tell the user — don't improvise a different design.

---

## Phase D — Flow recorder (0.10.0)

### D.1 What the user gets

- In the Otter popup: **Record** (records the tab the popup was opened on — the user's own tab). The toolbar icon shows a red `REC` badge while recording. Reopening the popup shows `Recording · N steps` with **Stop**. After Stop: a name field (prefilled from the page title) with **Save** / **Discard**.
- The AI can do the same with `record_flow` (start asks the user for approval first).
- Saved flows are listed in the popup (name · step count · delete).
- The AI replays a flow with `run_flow(name, vars)` in its own agent window, through the same engine and approval gate as `run_script`. It can list, read, save (e.g. after editing) and delete flows with `flows`.

### D.2 Data model

A flow (stored per profile in `chrome.storage.local`, key `flows`, an object keyed by name; max 200 flows × 300 steps):

```json
{
  "v": 1,
  "name": "Order lunch",
  "createdAt": "2026-11-21T09:00:00.000Z",
  "startUrl": "https://shop.example.com/menu",
  "steps": [
    { "action": "navigate", "url": "https://shop.example.com/menu" },
    { "action": "click", "target": { "selector": "[data-testid=\"item-42\"]", "label": "Chicken rice" } },
    { "action": "fill", "target": { "selector": "input[name=\"email\"]", "label": "Email" }, "text": "{{email}}" },
    { "action": "fill", "target": { "selector": "input[name=\"password\"]", "label": "Password" }, "sensitive": true },
    { "action": "press_key", "key": "Enter" }
  ],
  "vars": { "email": "me@example.com" }
}
```

- `steps` use the existing `run_script` step schema (`server/src/index.ts`, `const Step = z.object(...)`), plus two **new optional fields**:
  - `target.label` — human-readable description for the popup / the AI; **ignored when resolving**.
  - `sensitive: true` on a `fill` step — no `text`; see D.6.
- Every recorded `fill` value becomes a variable: `text: "{{<slug>}}"`, the typed value stored as its default in `vars`. Slug = the field's label lowercased, non-alphanumerics → `_`, trimmed, max 30 chars, de-duplicated with `_2`, `_3`; empty label → `field`.
- Storage lives in the extension because flows belong to a browser profile and must survive server restarts. The server reads/writes them through new extension actions (D.5).

### D.3 Capturing events (extension)

**New file `extension/recorder.js`** (classic content script; plain JS). It never runs unless a recording is active:

- `background.js` starts a recording with `chrome.scripting.registerContentScripts([{ id: "otter-recorder", matches: ["<all_urls>"], js: ["page.js", "recorder.js"], allFrames: true, runAt: "document_idle", persistAcrossSessions: false }])` and also injects the two files into the recorded tab's existing frames with `executeScript({ target: { tabId, allFrames: true }, files: [...] })`. On stop / discard / tab close it calls `unregisterContentScripts({ ids: ["otter-recorder"] })`. Registration covers navigations and late iframes; because it applies to every tab, `recorder.js` first asks `chrome.runtime.sendMessage({ type: "rec:hello" })` and stays inert unless the background answers `{ recording: true }` for `sender.tab.id`.
- `recorder.js` listens in the **capture phase** on `document` for `click`, `change`, `input`, `keydown` (Enter, Escape, Tab only), and `submit`. Use `event.composedPath()[0]` as the target so shadow DOM works. Ignore `isTrusted === false` events (page scripts / Otter itself).
- For each event it builds a **durable target** with a new `page.js` function `__otter.durableTarget(el)` (D.4) and sends `chrome.runtime.sendMessage({ type: "rec:event", kind, target, value?, key?, sensitive?, frameUrl, ts })`. For `input` events it sends nothing per keystroke — it debounces (400 ms) and on `change`/blur sends one `kind: "fill"` with the final value. **For a sensitive field (D.6) it sends `sensitive: true` and no value — the value never leaves the page.**
- `<select>` → `kind: "select"` with the chosen option's visible label. Checkbox/radio clicks → `kind: "click"`.
- Recording does not capture: scrolling (replay targets auto-scroll), hovering, drags, file uploads, JS dialogs (the user's tab has no debugger attached). Document these as limitations in the popup's tooltip and the README.

**Background** (`background.js`, new section "Flow recorder"):
- State: `recording = { tabId, windowId, startUrl, startedAt, events: [] } | null`, mirrored to `chrome.storage.local` key `recording` so a worker restart resumes it.
- `rec:hello` → `{ recording: recording?.tabId === sender.tab.id }`. `rec:event` from another tab → ignored.
- Top-level navigations of the recorded tab **not** caused by a recorded click/submit/Enter within the previous 1.5 s (`chrome.tabs.onUpdated` with a changed `url`) → push `{ kind: "navigate", url }`.
- Badge: `REC` (red) while recording; integrate into the existing single `refreshBadge()` owner — order: pairing attention `!` > `REC` > Full Auto fallback.
- Refuse to record an agent's tab (`ownerOf(tab)` non-null) and non-http(s) pages: "Record in one of your own tabs on a website."

### D.4 Durable targets (`page.js`)

`durableTarget(el)` returns `{ selector?, text?, tag?, nth?, label }` that **resolves back to `el` through the same `match()` run_script uses** (`page.js`, `function match(selector, text, tag)`, exact → prefix → substring). Algorithm:

1. Climb from the event target to the nearest interactive element (reuse the `SEMANTIC` selector / the logic `collect()` uses), so a click on a `<span>` inside a button records the button.
2. Call `collect()` so `window.__otterEls` is fresh, and find `el`'s index `i`.
3. Try candidates in order; for each, run `match(...)` and accept the first whose result list **starts with `i`** and has length 1 (unique). If none is unique, accept the first whose list **contains** `i` and record `nth` = position of `i` in it:
   1. `[data-testid="…"]`, `[data-test="…"]`, `[data-qa="…"]`, `[data-cy="…"]`
   2. `#id` — only if the id looks stable: no run of 4+ digits, not matching `/^(:r|ember|react-|mui-|radix-)/i`, length ≤ 40
   3. `tag[name="…"]` for form fields
   4. `[aria-label="…"]`
   5. `{ text: labelOf(el), tag }` (text clipped to 80 chars)
   6. last resort: a CSS path of `tag:nth-of-type(k)` from the nearest ancestor with a stable id (max 5 levels)
4. `label` = `labelOf(el)` clipped to 80 chars.
5. CSS-escape attribute values with `CSS.escape` / quote escaping.

Known limit (document it): `nth` is computed within the frame; `run_script` ranks matches across all frames by global index, so a non-unique target inside an iframe can pick the wrong frame. Prefer unique candidates; that's why uniqueness is tried first.

### D.5 Turning events into steps (pure logic, testable)

**New file `extension/recorder-core.js`** — a classic script attaching `OtterRecorder` to `this` like `config.js` (so `background.js` can `importScripts` it and Node tests can `require` it). Exports:

- `toSteps(events, startUrl)` → `{ steps, vars }`:
  1. Start with `{ action: "navigate", url: startUrl }`.
  2. Consecutive `fill` events on the same target (same selector/text/tag/nth) → keep only the last.
  3. A `click` on a text field immediately followed by a `fill` of the same target → drop the click (`fill` focuses).
  4. A `click` on a `<select>` followed by its `select` → drop the click.
  5. `keydown` Enter → `{ action: "press_key", key: "Enter" }` after the preceding fill; Escape / Tab likewise.
  6. `submit` events are dropped when the preceding step is the click / Enter that caused them (they're the same action); otherwise ignored (forms submitted by script).
  7. `navigate` events → navigate steps (dedupe a navigate to the URL the tab is already on).
  8. Fills → variables as in D.2; sensitive fills → `{ action: "fill", target, sensitive: true }`.
  9. Strip `label` duplication; cap at 300 steps (drop the rest, add a warning).
- `slug(label, taken)` — the variable naming rule.
- `validateFlow(flow)` — shape checks used when saving (name 1–60 chars; steps array ≤ 300; vars an object of strings/null).

### D.6 Sensitive fields

`recorder.js` treats a field as sensitive when **any** holds: `input[type=password]`; `autocomplete` ∈ {`current-password`, `new-password`, `one-time-code`, `cc-number`, `cc-csc`, `cc-exp`, `cc-exp-month`, `cc-exp-year`}; `name`/`id`/`aria-label` matches `/pass|pwd|otp|one.?time|cvv|cvc|card.?num|security.?code|ssn/i`.

Replay of `{ action: "fill", sensitive: true }`:
- New extension action `field_filled` `{ index }` → `{ filled: value.length > 0 }` (never returns the value).
- If filled (Chrome's password manager autofilled it) → step OK, `result: "already filled"`.
- Else → the script **stops** at that step with `error: "This step needs a password or code the recording didn't keep. Ask the user to type it in the Otter window, then call run_flow again with from_step = <next step>."` Do **not** ask for the value through elicitation (the MCP spec forbids eliciting sensitive data) or through the model.

### D.7 Server: replay engine refactor + three tools

1. **Refactor** the body of the `run_script` tool into `const runSteps = async (steps, vars, opts: { fast, background, tab, fromStep? }) => result` inside `buildServer`. `run_script` calls it unchanged — **its existing tests must pass untouched**. Add the `sensitive` handling (D.6) and the optional `target.label` (ignored) to the `Step` / `StepTarget` schemas. `fromStep` is literal: steps before it are skipped, including the opening `navigate` (it's meant for resuming in the page where a replay stopped).
2. **`record_flow`** `(action: "start" | "status" | "stop" | "discard", name?)` — META `{ title: "Record a browser flow" }`.
   - `start`: target is the user's current tab (same lookup as `get_user_tab`, in the session's profile). Ask approval with `approved()` — message `Record what you do in "<tab title>" (<host>) as a reusable flow? Typed text is saved with it (never passwords).` — then extension action `rec_start { tabId }`. Errors: already recording, agent tab, non-http page.
   - `status` → `{ recording, host, steps }` (step count after `toSteps`).
   - `stop` → `name` required (or default `"<page title> <date>"`); extension `rec_stop { name }` saves and returns the flow; the tool returns `{ name, steps: <count>, vars: <names>, sensitive_steps: <count> }` plus the steps JSON **with variable defaults omitted** (typed values aren't echoed into the model's context unless it asks via `flows get`).
   - `discard` → drops it.
3. **`flows`** `(action: "list" | "get" | "save" | "delete", name?, flow?)` — META `{ title: "Saved browser flows" }`.
   - `list` → `[{ name, steps, startUrl: host only, vars: [names], createdAt }]`.
   - `get` → the full flow (including var defaults).
   - `save` → validates with the zod `Step` schema + `validateFlow` rules; overwrites only after approval if the name exists (`Replace the saved flow "<name>"?`).
   - `delete` → approval (`Delete the saved flow "<name>"?`), then extension `flows_delete`.
4. **`run_flow`** `(name, vars?, from_step?, fast?, background?, tab?)` — META `{ title: "Run a saved flow", destructive: true, world: true }`. Loads the flow (`flows_get`), merges `vars` over defaults, fails before running if any `{{placeholder}}` has no value (existing `run_script` behaviour), runs `runSteps` in the session's agent tab. Never the user's tab.
5. Extension actions (not tab-scoped, like `list_tabs`): `rec_start`, `rec_status`, `rec_stop`, `rec_discard`, `flows_list`, `flows_get`, `flows_save`, `flows_delete`, plus tab-scoped `field_filled`. Each flow-storage action goes to the session's profile (flows are per profile).
6. Server `instructions`: one sentence — "To repeat something the user does by hand, record it with record_flow (or the user can record in the Otter popup) and replay it with run_flow."

### D.8 Popup

A compact **Flows** section between "This browser" and "Behaviour", in the existing visual style (no new colours):
- Idle: `Record this tab` button (disabled with a tooltip on agent tabs / non-http pages).
- Recording (in any tab): `● Recording · 7 steps` + **Stop**; if the popup is opened on a different tab, also say which site is being recorded.
- After Stop: name field + **Save** / **Discard**.
- Saved flows: up to 5 rows `name · N steps · ✕` (✕ asks `confirm()`), then "and N more". One muted line under the list: "Ask Claude to run a flow by name."
- Live refresh: reuse the popup's existing 600 ms poll.

### D.9 Tests

- **`test/recorder.mjs`** (Node; requires `extension/recorder-core.js` via `createRequire`): coalescing of repeated fills; click-before-fill dropped; select click dropped; Enter after fill; navigate dedupe; variable slugs incl. duplicates and empty labels; sensitive fills have no text and no var; 300-step cap with warning; `validateFlow` rejections.
- **`test/flows.mjs`** (fake extension holding flows in memory): `record_flow start` asks approval (deny → nothing sent); `stop` returns counts and **no var defaults**; `flows list/get/save/delete` incl. approvals and validation errors; `run_flow` merges vars, fails on missing vars before any command, stops at a sensitive step when `field_filled` says empty and continues when filled, `from_step` works; the audit log never contains a recorded value.
- `http.mjs` / `stdio.mjs`: tool count 41 → 44.
- `gate.mjs` duplicate-name guard already covers `page.js`; extend it to `recorder.js` if it's a single closure.

### D.10 Checkpoint — release 0.10.0

Version bump in the 5 places (`SERVER_VERSION`, `server/package.json`, `server/package-lock.json` ×2, `server/manifest.json`, `extension/manifest.json`); manifest `tools` list (+3); README section "Record & replay flows"; CHANGELOG 0.10.0 (incl. limitations: no scroll/hover/drag/upload/dialog capture; iframe `nth` caveat; typed values stored in the profile). `npm test`, `npm run pack`. Then **live**, ask the user to reload the extension + `/mcp` and verify:
1. Popup Record on a real form (e.g. `https://httpbin.org/forms/post`): fill name/email, pick a size, tick a topping, click Submit → Stop → Save. Inspect the steps (`flows get`).
2. A password field (any login page) is recorded as a sensitive step with no value anywhere (`flows get`, audit log).
3. `run_flow` replays it in the agent window with different `vars`; "Submit order" still triggers the approval prompt.
4. A recording survives a page navigation and an iframe (any page with an embedded form).
5. `record_flow start` from the AI shows the approval prompt.

---

## Phase E — Per-site rules (0.11.0)

### E.1 What the user gets

A list of site rules, each `{ pattern, mode }`:

| Mode | Agents may | Notes |
|---|---|---|
| `block` | nothing — not open, read, screenshot or act | e.g. online banking, password managers |
| `read` | read only (page text, elements, screenshots, console/network, measurements) | e.g. admin consoles you want summarised, not touched |
| `ask` | read freely; **every action** needs approval (one approval covers that site in that tab for 5 minutes) | **still asks with Full Auto on** — this is what makes Full Auto safe to leave on |
| *(no rule)* | as today | |

Set in the popup ("This site" for the active tab) and in Options (full list). **No tool can change rules** (same principle as Full Auto). Rules sync with the user's other settings (`chrome.storage.sync`, inside `OtterConfig` settings as `siteRules: []`).

### E.2 Matching (pure logic in `config.js`)

`OtterConfig.siteRuleFor(url, rules)` → the matching rule or `null`:
- Only `http:`/`https:` URLs can match (others → `null`).
- Pattern normalisation (also applied when saving): lowercase, strip scheme, path, port and a leading `*.`; must be a hostname (letters, digits, `-`, `.`) — reject anything else in the UI.
- `pattern` matches `host === pattern || host.endsWith("." + pattern)`.
- Several matches → the **longest (most specific) pattern wins**, so the user can carve out an exception: with `bank.com: block` and `news.bank.com: read`, `news.bank.com` is read-only and everything else on `bank.com` is blocked. Say so in the Options page under the list.
- `OtterConfig.normalizeSitePattern(input)` → normalised string or `null`.

### E.3 Enforcement (extension — authoritative, knows the tab's live URL)

In `handle()`, for every tab-scoped action, right after `resolveTab` and the ownership check (before the dialog checks):

```
const rule = OtterConfig.siteRuleFor(tab.url, S.siteRules);
```

- `block` → throw `Otter's site rules block AI agents on <host>. The user can change this in the Otter popup.` — for **every** action, reads included, and for the user's tab via `get_user_tab` reads too.
- `read` → if the action is not in `SITE_READ_OK` → throw `<host> is read-only for AI agents (Otter site rules).`
- `ask` → if the action is not in `SITE_READ_OK` and `p.siteApproved !== true` and `p.gated !== true` (the user just approved this exact action through the danger gate) → **return** `{ siteAsk: { host, pattern } }` without acting.

`SITE_READ_OK` = `read_page`, `read_elements`, `page_snapshot`, `find_text` (scroll forced off on read/ask sites), `wait_for`, `screenshot`, `read_console`, `read_network`, `get_network_body`, `hit_test`, `locate_element`, `resolve_element`, `enter_target`, `dialog_info`, `field_filled`, `perf_record`, `css_coverage`, `throttle`. Everything else that targets a tab (click, fill, type, press, select, hover, drag, scroll, navigate-from-this-page, reload, go_back/forward, handle_dialog, upload_file, evaluate_js, set_viewport, save_pdf, perf_audit) is an action.

Navigation targets:
- `navigate` / `open_tab` with a `url` whose rule is `block` → refuse **before** navigating.
- After `navigate` / `reload` / back / forward finishes, if the tab landed on a `block` site (redirect) → `chrome.tabs.update(tab.id, { url: "about:blank" })` and throw the block message.
- Links a page follows by itself are caught by the command-time check on the next action (document: a blocked site can still *load* in an agent tab through a redirect or a click, but the agent can't read or act there).

### E.4 Server: the `ask` round-trip

- In `act()` (`buildServer`), if the extension returns an object with `siteAsk`:
  1. Key `${profileOfTab(tab)}:${tabId}:${host}`; if approved within the last 5 minutes (per-session `Map`), resend once with `siteApproved: true`.
  2. Else prompt with a **new** `approvedAlways(message)` — like `approved()` but it **ignores Full Auto and `BROWSER_AGENT_GATE=off`**, and denies (never falls back to allow) when the client can't show prompts. Message: `<host> is set to "always ask" in Otter. Allow the AI to act on it in this tab for the next 5 minutes?`
  3. Approved → cache, resend with `siteApproved: true`. Denied → throw `Action denied by user: <host> is set to always ask.`
- `run_script` / `run_flow` go through `act`, so one approval covers a whole replay on that site (5-minute window).
- Audit every site decision (`audit("site", undefined, "<host>: allowed/denied/blocked")`).

### E.5 UI

- **Popup:** a row under the header status: `<host>` + a 4-way segmented control `Normal · Ask · Read · Block` for the active tab's site (hidden on non-http pages). Choosing a mode writes/removes the rule for that exact host (pattern = the tab's hostname without `www.`). One short hint line only when a rule applies: `Ask: every action needs your OK, even in Full Auto` / `Read: agents can look, not touch` / `Block: agents can't open or read this site`.
- **Options page:** new section "Site rules": list of rows `pattern | mode select | ✕` + an add row (input + mode + Add) using `normalizeSitePattern`; invalid input shows an inline error. Saved through the existing `persist()` flow.
- Popup `!`/`REC` badge logic unchanged.

### E.6 Tests

- `gate.mjs` (Node, `config.js`): `siteRuleFor` — exact host, subdomain, `www.`, longest-pattern-wins, non-http URLs, ports/paths in patterns normalised, invalid patterns rejected; `normalize()` keeps `siteRules` from stored settings and defaults to `[]`.
- **`test/rules.mjs`** (fake extension returning `{ siteAsk }` until `siteApproved`/`gated` arrives): approve → resent with `siteApproved` and succeeds; second action within 5 min → no new prompt; different tab → prompt again; deny → `Action denied by user`; **Full Auto on → still prompts**; `BROWSER_AGENT_GATE=false` → still prompts; client without elicitation → denied; a `gated: true` click isn't asked again; `run_script` with 5 steps on an ask-site → one prompt.
- The block/read enforcement lives in the extension → live checks below.

### E.7 Checkpoint — release 0.11.0

Version bump (5 places), CHANGELOG 0.11.0, README (Security section: site rules; how they interact with Full Auto), `npm test`, `npm run pack`. Live, after reload + `/mcp`:
1. Popup: set `example.com` to **Block** → `open_tab https://example.com` refused before loading; `read_page` on a user tab at example.com refused.
2. **Read** → `page_snapshot` works, `click_element` refused.
3. **Ask** with Full Auto ON → first click prompts; second click within 5 min doesn't; Decline blocks.
4. Options page: add `httpbin.org` as Ask, remove it again; invalid pattern shows the inline error.
5. A redirect into a blocked site (any `http://` → `https://` redirect on a blocked host) ends on `about:blank` with the block message.

---

## Out of scope

Running flows from the popup without the AI; editing steps in the popup; recording scroll/hover/drag/uploads/dialogs; sharing flows between profiles or users; path-level site rules (`example.com/admin`); rules for the user's own (non-agent) actions; session timeline; doctor tool.
