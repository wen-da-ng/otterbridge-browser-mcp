# Implementation plan: actions that say what changed, in a form code can read (0.13.0)

Written against `v0.12.1` (commit `3c12f6c`). Re-locate code by the quoted identifiers if line numbers have moved.

| Release | Phase | What ships |
|---|---|---|
| 0.13.0 | G | Action tools return a typed "what changed" report; script guidance matches what Claude Code actually hands a script; (if needed) a firmer don't-retry hint |

**Order:** G.0 first (the user, any time; it only decides whether G.3 happens). G.1 and G.2 are independent; G.4 alongside; G.5 last.

## Why

The 0.12 F.0 probe (22 Nov 2026, see `docs/PLAN-0.12.md`) settled how Claude Code's Code Mode passes MCP results to a script: an `isError` result **throws**, and a successful result arrives as **its `structuredContent` serialized to a JSON string** (the text block only when there is none). Two consequences:

1. **Actions can't be branched on.** `click_element`, `click`, `select_option`, `hover`, `press_key` and the navigation tools return prose only — "Clicked … → Navigated to … / → Opened a new tab (tab 123 …) / → The action opened a JavaScript confirm dialog …". A script that needs to know *did that navigate, open a tab, open a dialog, start a download* has to regex English. The reading tools got typed results in 0.12; the acting tools did not.
2. **The guidance is slightly off.** The server instructions say "Reading tools also return typed results (structuredContent)", which invites `result.structuredContent` — undefined in Claude Code, where the script gets a string. (The README sketch was already corrected on 22 Nov 2026.)

Everything here is plain MCP: clients without Code Mode keep the exact same text, so nothing changes for them (the text block stays byte-for-byte). No new tools; tool count stays **44**.

---

## 0. Ground rules (same as 0.12)

1. **Never `git commit`, `git tag` or push.** The user does that; give them the commands at the checkpoint.
2. **Don't start long-running servers.** `npm test` is fine. Never kill processes on ports 8000 / 8765–8774 / 18765–18774; ask instead.
3. **Windows 11 + PowerShell.** Edit with the Edit tool or a script file, then `tsc --noEmit`.
4. **No extension behaviour change.** The report is parsed on the server from the prose the extension already writes, so every extension version works. The only extension edit allowed is a *comment* (G.1 step 1); it needs no reload.
5. **The server is one file** (`server/src/index.ts`).
6. **Nothing typed reaches the audit log** (`redact()`).
7. **The approval gate stays authoritative.** Nothing in this release changes what is gated or how.
8. Each checkpoint needs a **live check in the user's Chrome**; Code Mode checks need Claude Code started with Code Mode on. Report exactly what was and wasn't verified.
9. If something proves impossible as written, stop at that step, keep everything else working, and tell the user.

---

## G.0 Retry check (user, ~5 minutes, a fresh session with Code Mode **off**)

Carried over from 0.12. In a new Claude Code session, ask Claude to click a destructive-looking button on a test page (e.g. **Submit order** on `https://httpbin.org/forms/post`, with Full Auto off) and **decline** the prompt.

- Claude stops and asks → G.3 is skipped.
- Claude retries, or tries another route (`click(x, y)`, `press_key Enter`, `evaluate_js`) → do G.3.

Write the outcome into this file under G.0.

## G.1 Typed "what changed" reports for actions

**Design: parse on the server, don't change the extension.** The extension's `afterReport` and `dialogNote` (`extension/background.js`) already write a fixed set of `→ …` lines. Parsing them in the server keeps the extension untouched, works with older extensions, and follows the precedent of `SITE_BLOCK_RE` ("Must match … in server/src/index.ts"). Rejected alternative: have `afterReport` return an object — cleaner, but it needs an extension release, a reload, and a fallback for older extensions anyway.

1. **Pin the contract.** Above `afterReport` and `dialogNote` in `background.js`, add a comment: *"The → lines are parsed by parseChanges in server/src/index.ts — change both together."* Same note above `parseChanges`.
2. **`parseChanges(s: string)`** next to `json` (module level). Splits the text into lines; the first non-`→` line(s) are the action's own message. Recognises, one regex each:

   | Line written by the extension | Field |
   |---|---|
   | `→ Navigated to <url> ("<title>")` (title optional) | `navigated: true, url, title?` |
   | `→ A new page loaded at the same URL (form submitted or page reloaded)[: "<title>"].` | `navigated: true, same_url: true, title?` |
   | `→ The page title is now "<title>".` | `title` |
   | `→ Opened a new tab (tab <id>[: <url>]) — use_tab …` / `→ Opened a popup window (…)` | `new_tabs: [{ tab, url?, popup }]` |
   | `→ The action opened a JavaScript <type> dialog: "<message>". …` | `dialog: { type, message }` |
   | `→ A download started: <name>` | `downloads: [name]` |
   | `→ The page updated.` / `→ No visible change on the page.` | `page_changed: true / false` |
   | `→ The tab was closed.` | `tab_closed: true` |
   | any other `→ …` line | kept verbatim in `other: string[]` (nothing is lost) |

   The navigation tools' own first line (`Navigated to <url>` from `navigate` / `go_back` / `go_forward` / `reload`) fills `navigated` / `url` the same way. Check the exact strings in `perform()` for those cases before writing the regexes.
3. **`report(s: string)`** helper: `{ content: [{ type: "text", text: s }], structuredContent: { message: s, changed: parseChanges(s) } }`. The text is `s` unchanged. `message` carries the full text so a script that returns the result to the model loses nothing.
4. **Loose `OUT.action` schema** (`.passthrough()` like the 0.12 ones): `message: string`, `changed: object` with every field optional.
5. **Wire it** into `click_element`, `click`, `select_option`, `hover`, `press_key`, `navigate`, `go_back`, `go_forward`, `reload`: replace `text(…)` with `report(…)` on every success path and add `outputSchema: OUT.action`. **Audit every return path:** once a tool declares an `outputSchema`, the SDK rejects a successful result with no `structuredContent`. Paths that return `text(...)` for a soft failure (e.g. "No interactive element with index …") must become `fail(...)` or go through `report`. `withFailures` and the `SOFT_FAIL_RE` → `isError` conversion must still run first, so an error never carries a report.
6. Leave `fill_element`, `type_text`, `scroll`, `drag` as they are: the extension writes no after-report for them (`REPORT` set in `background.js`).

## G.2 Script guidance that matches Claude Code

1. **Server instructions:** replace the "In a script that calls these tools …" paragraph with a shorter one (fewer tokens for every session, Code Mode or not), e.g.: *"In a script (e.g. Claude Code's Code Mode): explore interactively first, then script the repetitive part; find elements with 'target', pass 'tab' on every call, stop at the first error, return only what you need. Results reach a script as JSON text — parse it; actions return { message, changed } (navigated, new_tabs, dialog, downloads)."* Keep the approval paragraph after it as is.
2. **README → *Scripts & Code Mode*:** add a bullet for action reports and extend the sketch with one branch, e.g. stop when `changed.dialog` is set.
3. **CHANGELOG** 0.13.0 entry.

## G.3 Firmer don't-retry hint (only if G.0 showed a retry)

Change `DENIED_HINT` so the instruction comes *first* and names the workarounds: *"STOP: the user declined this. Ask them how to continue. Don't retry it, and don't reach the same result another way (click by coordinates, a key press, evaluate_js)."* Keep `DENIED_RE` matching (the result must still start with `Action denied by user`, so put the hint right after the first sentence, or update `DENIED_RE` and the tests together). Re-run G.0 to confirm.

## G.4 Tests (`server/test/script.mjs`)

- **Parser table:** every line form in G.1 step 2, fed through the fake extension, gives the expected `changed`. Combined lines too (navigated + new tab + download). An unknown `→` line lands in `other`.
- **Text unchanged:** for each wired tool, the text block equals what 0.12.1 returned for the same fake response (byte-for-byte).
- **Typed:** each wired tool declares `outputSchema` in `tools/list`, and `structuredContent.message` equals the text.
- **Errors stay errors:** a denial, an aborted click and a stale index return `isError` with no `structuredContent`.
- **Dialog during the action** (the extension resolves with `dialogNote` in place of the action result): `changed.dialog` is set.
- Instructions: the new paragraph is present and the old one gone; `npm test` green.

## G.5 Checkpoint — release 0.13.0

1. Bump `server/package.json` (+ `package-lock.json`), `server/manifest.json`, `extension/manifest.json` (kept in step as in 0.12.0), CHANGELOG; `npm run pack` for the `.mcpb`.
2. **Live checks in the user's Chrome** (normal session):
   1. Click a link → text as before; `changed.navigated` + `url`.
   2. A button that opens a new tab → `changed.new_tabs[0].tab` is the tab id.
   3. A button that calls `confirm()` → `changed.dialog.type === "confirm"`; answer it with `handle_dialog`.
   4. A click that changes nothing → `changed.page_changed === false`.
   5. `navigate` → `changed.url`.
3. **Code Mode session:** a script clicks through a few pages and stops when `changed.navigated` is false or `changed.dialog` is set; confirm the script receives `{ message, changed }` as JSON text.
4. Give the user the commit/tag commands.

---

## Out of scope (candidates for later)

- **Report objects built by the extension** instead of parsed prose — if the `→` lines ever need to change often, or a field needs data the prose doesn't carry.
- **After-reports for `fill_element` / `type_text`** (e.g. "the form auto-submitted"): needs an extension change (`REPORT` set).
- **OtterBridge's own code tool** (`execute(code)` with a `browser.*` API): unchanged from the 0.12 plan — revisit only if Code Mode leaves experimental.
- `_meta["anthropic/maxResultSizeChars"]` for `read_page` / `get_network_body` large results.
