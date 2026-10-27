# Changelog

## Unreleased

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
