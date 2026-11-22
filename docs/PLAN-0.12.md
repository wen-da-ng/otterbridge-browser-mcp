# Implementation plan: script-ready tools for Code Mode (0.12.0)

Written against `v0.11.0` (commit `0b8a1e7`). Re-locate code by the quoted identifiers if line numbers have moved.

| Release | Phase | What ships |
|---|---|---|
| 0.12.0 | F | Tools a script can rely on: refusals are errors, typed results, elements targeted by text/selector (fewer steps), Code Mode guidance |

**Order:** F.1 and F.3 first (they don't depend on the F.0 probe), then F.2, F.4, F.5 alongside, F.6 last. The F.0 probe can run any time before F.4's wording is final. Whether typed results double the tokens can only be measured once F.2 exists (F.6 check 7).

## Why

Claude Code's Code Mode (experimental since v2.1.323, `CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1`) lets Claude write one JavaScript script that calls many tools, MCP tools included, and returns only what it needs. Browser automation is chatty (look → act → wait → look). Code Mode collapses the predictable stretches into one script, but only when each tool result can be trusted by code without a model reading it in between. Today three things break that:

1. **Gate refusals look like success.** `"Action denied by user: …"`, `"Click aborted: …"`, `"No interactive element with index …"` and argument mistakes (`"Provide 'value' or 'label'…"`) come back as normal text results. A script carries on after the user said no. (Site-rule denials already throw, so they are already errors; this release makes the gate consistent with them.)
2. **Results are text, in mixed formats.** Some tools return a JSON string, others prose; none declare `outputSchema` or return `structuredContent`. `withProfileNotes` can append a second text block, which breaks a naive parse.
3. **Acting on an element takes two steps.** `read_elements` → pick an index → `click_element`. In a script, the lookup by text is code the model has to write and get right every time; `run_script` already has a better way (`target: { selector, text, tag, nth }` + implicit wait) that the interactive tools lack.

Everything here is plain MCP, so Claude Desktop, Cowork and VS Code (no Code Mode) benefit too. No new tools; tool count stays **44**.

---

## 0. Ground rules (same as 0.10/0.11)

1. **Never `git commit`, `git tag` or push.** The user does that; give them the commands at each checkpoint.
2. **Don't start long-running servers.** `npm test` is fine. Never kill processes on ports 8000 / 8765–8774 / 18765–18774; ask instead.
3. **Windows 11 + PowerShell.** Edit with the Edit tool or a script file, then `tsc --noEmit`.
4. **Extension = plain classic scripts, no build.** This release should need **no extension change**; if one turns out to be necessary, stop and say so.
5. **The server is one file** (`server/src/index.ts`).
6. **Nothing typed reaches the audit log** (`redact()`).
7. **The approval gate stays authoritative.** Element targeting by text/selector must go through `gatedClick` / `enterGate` exactly like index clicks. No new path acts without it.
8. Each checkpoint needs a **live check in the user's Chrome**; Code Mode checks need the user to start Claude Code with Code Mode on. Report exactly what was and wasn't verified.
9. If something proves impossible as written, stop at that step, keep everything else working, and tell the user.

---

## F.0 Probe (before writing code; user runs it, ~5 minutes)

Claude Code's docs don't say how a tool result appears inside script code. Find out first, against 0.11 as it is:

1. User starts Claude Code with Code Mode on (`$env:CLAUDE_CODE_EXPERIMENTAL_CODE_MODE = "1"; claude`) and checks `/status` says it's on (installed plugins that check tool calls can block it).
2. Ask Claude to run a script that calls `list_tabs` and returns the raw result object, then one that clicks a button labelled "Delete" on a test page and the user **declines** the prompt.
3. Record: the shape of the result object (`content`? `structuredContent`? `isError`?), whether an `isError` result **throws** inside the script or is returned, and whether a `screenshot` image reaches Claude.

Write the findings into this file under F.0 before continuing. If `isError` neither throws nor is visible to code, F.1 still ships (it's correct MCP and helps every client), but F.4's guidance changes from "errors throw" to "check `isError`".

---

## F.1 Failures are errors

1. Add next to `const text = …` (module level):
   ```ts
   const fail = (s: string) => ({ content: [{ type: "text" as const, text: s }], isError: true });
   ```
2. **Single choke point** in the `tool()` wrapper (after `withPairing`, before `withProfileNotes` appends notes): if the result has no `isError` and its first content block is text matching
   ```ts
   const SOFT_FAIL_RE = /^(Action denied by user|Click aborted|Click refused|No interactive element|No JavaScript dialog|Cannot go (back|forward)|Provide |'[^']*' isn't (an absolute path|a file)|File not found|'path' must be|No connected browser profile matches|'[^']*' matches several profiles|Already recording|A finished recording|Record in one of your own tabs|No Otter extension is waiting)/;
   ```
   set `isError: true`. This catches server strings and the extension's own soft failures (`"Cannot go back: …"`) without touching every call site.
3. **Denials say "don't retry".** Models tend to retry errors; a declined approval must not be retried or worked around. When a result (returned *or* thrown, e.g. site-rule denials) starts with `Action denied by user`, append once:
   ` The user declined this: stop and ask them how to continue. Don't retry it or look for another way to do it.`
4. `run_script` and `run_flow`: when the replay result has `ok: false`, return it with `isError: true` (same JSON). When the failed step was a **denial**, replace the usual `hint` ("take over with the interactive tools … finish the task", which would be a work-around) with: `The user declined step N. Stop and ask them how to continue; don't finish the task another way.`
5. **Bug fix (found while planning):** `runSteps` checks gate results with `/^(Action denied|Click aborted)/` and misses `"Click refused by the browser extension: …"`, so a click the extension refused counts as a successful step and the replay continues. Add `Click refused` to both checks.
6. Server `instructions` keep "If the user denies one, stop and ask them"; add that in a script a denial is an error and the script should stop.

## F.2 Typed results (`outputSchema` + `structuredContent`)

For tools that already build an object, also return it as `structuredContent` and declare a **loose** `outputSchema` (`z.looseObject({...})` with the key fields typed and the rest allowed), so a shape change in the extension can't make the SDK reject a result. Keep the existing text block byte-for-byte (existing callers and tests parse it).

| Tool | `structuredContent` |
|---|---|
| `read_page` | the object as returned (`url`, `title`, `text`, `offset`, `total_chars`, …) |
| `read_elements` | the object as returned (entries with `index`, `text`, `tag`, `x`, `y`, state) |
| `find_text` | the object as returned |
| `wait_for` | `{ found, elapsed_ms, … }` |
| `read_console`, `read_network`, `get_network_body` | the object as returned |
| `list_tabs`, `get_user_tab`, `open_tab` | arrays wrapped: `{ tabs: [...] }` (structuredContent must be an object) |
| `list_profiles` | as returned |
| `run_script`, `run_flow` | the replay result (also on failure, with `isError`) |

*As built:* `perf_audit` / `perf_record` / `css_coverage` and `flows` were left out. Their results mix prose ("Recording…", "Saved the flow…") with large reports, a schema would add little typing for script code, and every prose path would have to change to satisfy the SDK. Candidates for later if scripts need them.

Rules:
- The SDK rejects a successful result without `structuredContent` once a tool declares `outputSchema`. Tools with prose-only success paths (`perf_record start`, `css_coverage start`, `flows save/delete`) must either return a small object there too (`{ status: "recording" }`) or not declare a schema. Prefer the small object.
- Error results (`isError`) don't need `structuredContent`.
- **Profile notes:** `withProfileNotes` keeps appending its text block, and also sets `structuredContent.notes = [...]` when `structuredContent` exists.
- Leave `page_snapshot`, `navigate` and the action tools as prose: their text *is* the result. The action tools' "what changed" report stays prose this release (see Out of scope).

## F.3 Target elements by text or selector (fewer steps)

1. Lift `resolveTarget` out of `runSteps` to `buildServer` scope (unchanged behaviour: poll `resolve_element` every 200 ms until found or timeout).
2. Add an optional `target` (the existing `StepTarget` schema) and `timeout_ms` (100–30000, default 5000) to **`click_element`, `fill_element`, `select_option`, `hover`** and **`screenshot`** (element capture). Make `index` optional; exactly one of `index` / `target` is required (else `fail("Provide 'index' (from read_elements) or 'target' (selector and/or text).")`).
3. With `target`: resolve → `el.index`, then the **same** code path as the index call (`gatedClick(tab, { index: el.index }, el.text, …)`, `enterGate(tab, el.index)` for fills with line breaks, etc.). Not found after the timeout → `fail("No element matches target {...} after waiting Nms.")`.
4. Say what was matched: prepend `Matched [i] "<text>"` to the result, plus `(N matches, used nth=k)` when several matched (`resolve_element` already returns `matches`; note it clamps an out-of-range `nth` to the last match).
5. Descriptions: one sentence each — "Or pass `target` (CSS selector and/or visible text) instead of an index; waits for the element to appear." Keep `read_elements` / `page_snapshot` recommended for exploring.

This helps every client: one call instead of `read_elements` + `click_element`, and no stale-index failures after the page re-renders.

## F.4 Guidance for scripts

1. Server `instructions` (keep it short), add:
   > In a script (Claude Code's Code Mode): explore a page interactively first, then script the repetitive part. Target elements by `target` (text/selector) rather than indices, pass `tab` on every call, treat errors (including the user declining an approval) as a reason to stop, and return only what you need, not whole pages.
2. README: a "Code Mode" section covering what works, the explore-then-script pattern, a short example script, and that approvals still prompt per click. Mention that Claude in Chrome is unavailable in Code Mode **only after F.6 confirms OtterBridge works there**.
3. Note on parallel calls: the extension already queues commands per tab (`withTabLock` in `background.js`), so `Promise.all` on one tab can't interleave actions; switching the session's default tab with `use_tab` mid-script still can. This is why the guidance says to pass `tab`.

## F.5 Tests

- **New `test/script.mjs`** (fake extension, like `rules.mjs`):
  - gate decline on `click_element` → `isError`, text unchanged, no click sent
  - `Click aborted` (fake returns `{ covered }`) → `isError`
  - stale index → `isError`; missing args (`select_option` without value/label, `hover` without index or x/y) → `isError`
  - extension string `"Cannot go back: …"` → `isError`
  - `run_script` failing step → `isError` and JSON still has `failed_step`
  - every tool in the F.2 table declares `outputSchema` in `tools/list`, and its `structuredContent` deep-equals its parsed text JSON (arrays: `{ tabs: parsed }`)
  - profile notes appear in both the extra text block and `structuredContent.notes`
  - `click_element` with `target: { text: "Delete" }` resolves, **prompts**, decline → `isError`, nothing pressed; approve → click carries `gated`
  - `target` not found within `timeout_ms` → `isError` after about that long
  - neither `index` nor `target` → `isError`
  - `fill_element` with `target` and a line break → goes through `enterGate`
- Existing suites: update assertions that check denial results only by text (`http.mjs` 198–228) to also expect `isError`. Nothing else should change; `stdio.mjs` still expects 44 tools.
- `npm test` green.

## F.6 Checkpoint — release 0.12.0

Version bump (5 places: `SERVER_VERSION`, `server/package.json`, `server/package-lock.json` ×2, `server/manifest.json`, `extension/manifest.json`; the extension itself is unchanged but versions move together), CHANGELOG 0.12.0, README "Code Mode" section, `npm test`, `npm run pack`. Live, after `/mcp`:

Without Code Mode (regression):
1. A normal interactive task (open a page, `page_snapshot`, `click_element` by index) works as before.
2. `click_element` with `target: { text: "…" }` on a real page clicks the right element; a "Delete"/"Submit" target still prompts.

With Code Mode on:
3. A script that pages through a list (e.g. a search results page, 3 pages) and returns a short summary runs in one script, with one tool row per call in the transcript.
4. A script that reaches a destructive button: declining the prompt stops the script (or the script sees `isError` and stops, depending on F.0's finding).
5. A script reads `structuredContent` from `read_elements` / `read_page` without `JSON.parse`.
6. `screenshot` from a script: note whether Claude sees the image.
7. **Double tokens check:** `read_page` on a long page, with and without Code Mode. Compare the context used (`/context`) against 0.11 for the same call. If the result is counted twice (text + structured), limit `structuredContent` to tools with small results and drop it from `read_page` / `get_network_body` / `read_network`.
8. **Retry check:** in a normal (non-script) session, decline a destructive click. Claude should stop and ask, not retry or try another way.

---

## Out of scope (candidates for later)

- **Structured "what changed" reports** for action tools (`{ navigated, url, title, new_tabs, dialog, download }`). Needs `afterReport` in `background.js` to return an object, plus handling older extensions; worth doing once F.0/F.6 show scripts need to branch on it.
- **OtterBridge's own code tool** (`execute(code)` with a `browser.*` API in a sandbox). Revisit only if Code Mode leaves experimental, or Desktop/Cowork users need loops and conditions `run_script` can't express. It would need an isolated runtime (isolated-vm / QuickJS-wasm) and a full security review, since the server holds the pairing secret.
- `_meta["anthropic/maxResultSizeChars"]` for `read_page` / `get_network_body` large results.
