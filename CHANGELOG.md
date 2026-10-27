# Changelog

## 0.5.0 — 2026-10-28

### Added

- **Iframes and shadow DOM.** Every tool that reads or acts on a page now sees
  inside iframes (cross-origin included — payment forms, embedded editors,
  nested framesets) and shadow DOM (web components). A new in-page library
  (`extension/page.js`) works out each frame's position on screen, so indices
  and coordinates stay consistent across frames.
- **`page_snapshot`**: a compact outline of the page — headings, sections,
  dialogs, short text and every interactive element with its index, role,
  state and link target. Far cheaper than a screenshot.
- **JavaScript dialogs**: `handle_dialog(accept, text?)` answers alert /
  confirm / prompt / "Leave site?". Chrome doesn't report dialogs to an
  extension's debugger, so a frozen page is detected instead: an action that
  opens a dialog returns within ~2 s saying so (it used to hang 30 s), and
  later calls on that tab fail fast until it's answered. OK on a confirm that
  reads destructive — or one whose text can't be read — needs approval.
- **Actions report what changed**: navigation (including a form posted to
  the same URL), new tabs and popups, dialogs, downloads, or "no visible
  change" — so the model rarely needs a second call just to check.
- **`upload_file`** (always asks approval — it sends local files to a site),
  **`wait_for_download`**, **`save_pdf`**, **`set_viewport`** (e.g. phone
  emulation).
- **Input**: `press_key` takes combinations (`Control+A`, `Shift+Tab`,
  `Control+Shift+P`, F1–F12); `click` / `click_element` take `double: true`;
  `scroll` can target an element or point (inner panels); `screenshot` can
  capture one element; `wait_for` can wait for a network response (`url`).
- **`read_elements`** reports state (disabled, checked, expanded, href,
  offscreen), lists ARIA menu items and options, and takes `scope`, `query`
  and `max` (default 300) so big pages don't flood the context.
- **Fast mode** switch in the extension popup: no cursor glide or typing
  delays (still real, trusted input).
- `run_script` steps: `dialog` (accept / dismiss), `double` clicks, and
  `wait_for` on a network `url`.

### Changed

- **Multi-client discovery**: the first server owns `8765` as a registry;
  other servers register their own port (`8766–8774`) with it and the
  extension connects to the ports it's told about — instead of probing all
  ten ports every 3 s, which filled the extension's error page with refused
  connections. A surviving server takes `8765` over when the registry exits.
- **One window per client session, across reconnects**: a stdio server's
  agent identity comes from its parent process, so `/mcp` reconnects (and
  extension reloads, now that the registry persists) continue in the same
  window and tab instead of opening a new window each time.
- **Clicks never land on an overlay**: an index click first confirms its
  target is the topmost element at that point; if a cookie banner or modal
  covers it, the click is aborted with the covering element named.
- **Subagents**: actions on one tab now run one at a time (parallel calls
  can't interleave keystrokes or mouse moves), tabs aren't brought to the
  front while another action runs in the same window, and the instructions
  tell parallel agents sharing a session to each use their own tab.
- Popups opened by an agent's page belong to that agent (they used to count
  as the user's tabs, so they were read-only).
- The element list is cached per page, so a click no longer re-scans the
  page four or five times.
- Full Auto is now shown as a small orange fast-forward mark (▶▶) on the
  toolbar icon (the "AUTO" text badge was clipped); hovering the icon says
  "Full Auto is ON".

### Fixed

- Buttons inside web components (e.g. Shoelace) were reported as "covered"
  by their own component.
- A tab briefly "loading" because of iframes or ads was reported as a page
  navigation.
- Clicks failed outright on tabs where the cursor content script wasn't
  running (tabs opened before an extension reload, `data:` URLs); the
  cursor is now cosmetic and the input still happens.

### Security

- The audit log no longer records typed text (`fill_element`, `type_text`,
  prompt answers) or `evaluate_js` code — only their length.
- Password fields never report their value (`read_elements`,
  `page_snapshot`, approval prompts).

## 0.4.0 — 2026-10-27

### Added

- **Multiple clients at once.** Each server binds the first free bridge port in
  `8765–8774` (base movable via `OTTERBRIDGE_WS_PORT`), and the extension keeps
  a socket to every one — Claude Code, Claude Desktop and background sessions
  no longer knock each other out. A freshly started server waits briefly for
  the extension instead of failing its first call; in-flight commands fail
  immediately if the extension disconnects.
- **One Chrome window per session.** Every session works in its own window
  (opened unfocused on its first tool call) holding its own labelled, colored
  tab group — agents never act in the tabs the user is using.
- **`get_user_tab`**: the user's current tab, usable read-only with
  `read_page` / `read_elements` / `find_text` / `wait_for` / `screenshot`
  (captured without attaching the debugger). Acting on it is refused.
- **Full Auto** switch in the extension popup (and Options → Advanced): skips
  approval prompts for every connected client, live. AUTO badge on the toolbar
  icon while on. No tool can change it.

### Security

- Clears all open Dependabot alerts: `@modelcontextprotocol/sdk` 1.29.0 →
  1.32.2 (memory-exhaustion, session-binding and redirect advisories), plus
  its transitive `hono`, `@hono/node-server`, `fast-uri`, `ip-address`, `qs`
  and `proxy-addr` via a lockfile refresh. `npm audit`: 0 vulnerabilities.
- `zod` 3 → 4.6.7 (GHSA-mrhx-c7xc-m3w5, memory exhaustion on oversized
  collections; no zod 3 fix exists).
- Legacy Python server: `mcp` 1.28.1 → 1.30.0 (unbounded StreamableHTTP
  session accumulation).

### Fixed

- **Tabs reliably land in their group.** Grouping is verified and retried
  (Chrome's transient "tabs cannot be edited right now" refusal), a group
  Chrome dropped is recreated, tabs a page opens in an agent window are
  adopted, and the agent registry survives MV3 service-worker suspension.
  Previously a tool call without `open_tab` silently used the user's active
  tab, and grouping errors were swallowed.
- Agent ids are random per session, so a restarted server can't inherit a
  stale window from a previous run.
- `close_tab` only closes the session's own tabs.
- The fake cursor no longer reappears on the user's own tabs after navigation.

## 0.3.0 — 2026-08-10

Final release of this codebase in this repository.

### Added — script replay engine

- **`run_script` tool**: replay a whole recorded browser flow in ONE MCP call —
  no model round-trip between steps. Steps: `navigate`, `click`, `fill`,
  `select`, `type_text`, `press_key`, `scroll`, `wait_for`, `drag`.
  - Durable element targets (CSS selector and/or visible text with tiered
    exact → prefix → substring matching, optional tag filter and nth pick) —
    never session-specific indices, so a script recorded today replays
    tomorrow.
  - `{{placeholder}}` variables substituted from a `vars` map at call time —
    one recorded flow serves ever-changing inputs. Unresolved placeholders
    fail fast before anything runs.
  - Implicit waits on element resolution (Selenium semantics): targets are
    polled up to `timeout_ms` (default 8 s) instead of failing on a
    single-frame race.
  - Fail-stop semantics with per-step results and timings: the script stops at
    the first failed non-optional step and reports exactly where and why, so
    the model can take over interactively, finish the task, and update the
    saved script. `optional: true` steps continue on failure; `pause_ms`
    adds settling time after a step.
  - The destructive-action gate applies to every scripted click exactly as in
    interactive mode.
  - Coordinate `click` (x/y) and `drag` steps as a last resort for elements
    with no durable descriptor (icon-only buttons, slide-to-confirm sliders).
- **`resolve_element` extension action**: resolves a durable descriptor to a
  live element in the current interactive-elements ordering; feeds the
  existing click / fill / select paths.
- **`fast` mode** (default in replay): skips the cursor glide animation and
  per-character typing delays while still dispatching real, trusted CDP
  input events. Fast `drag` interpolates a short linear path so slider/drag
  handlers still see intermediate mousemoves.
- **`background` mode**: replays never activate the target tab — the user can
  keep working in other tabs, windows, or apps (verified: window minimized,
  user active in another Chrome profile). Works because input is injected
  in-process via CDP, not through OS focus.
- `examples/shan-farm-order.replay.json`: a recorded, verified real-world
  ordering flow demonstrating the format (vars, optional steps, selector
  waits, deliberate stop before the destructive final action).

### Fixed

- **`press_key` now sends real key codes** (`windowsVirtualKeyCode` +
  `code`) for named keys (Enter, Tab, Escape, arrows, Home/End, PageUp/Down,
  Backspace, Delete, Space). Frameworks that check `event.keyCode` — Google
  apps among them — previously ignored the dispatch entirely.
- **`fill_element` is now transactional**: focus + type, then VERIFY the text
  actually arrived (focus still on the element, or its value changed). Apps
  that asynchronously steal focus (Google Sheets) could previously divert
  keystrokes into whatever held focus — silently corrupting data. Diverted
  input is now cancelled with Escape and retried up to 3 times; if focus
  never sticks, the step fails loudly with nothing typed.

### Reliability patterns validated in testing (for script authors)

- Anchor each unit of work (row, ticket, form) independently rather than
  chaining long sequences off one starting point — a disturbance then costs
  one unit, not the whole run.
- In background mode, pace keyboard-relay flows with `pause_ms` (~80–120 ms);
  element-targeted fills re-anchor per step and barely need it.
- Detect pages by CSS selector when the landmark text is a placeholder —
  placeholders never appear in `document.body.innerText`.
- Start scripts with `navigate` + `wait_for` (create the starting state, don't
  assume it) and end with a `wait_for` on the success signal.
