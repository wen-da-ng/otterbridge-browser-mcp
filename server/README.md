# OtterBridge — Node server (`server/`)

The Node/TypeScript port of the OtterBridge MCP server. One codebase, two
transports, byte-compatible with the same unchanged Otter Chrome extension:

- **stdio** (`--stdio`) — for Claude Desktop / the `.mcpb` bundle, which launches
  the server itself. **This is the zero-prerequisite path**: Node ships inside
  Claude Desktop, so a non-technical user just double-clicks the `.mcpb`.
- **streamable HTTP** (default, `http://localhost:8000/mcp`) — for Claude Code,
  MCP Inspector, or any HTTP MCP client you start the server for.

Both modes host a bridge the extension connects to, so several clients (Claude
Code, Claude Desktop, background sessions) can each run their own server at
once. The first server owns `ws://localhost:8765` and doubles as a registry;
the others bind their own port in `8766–8774` and register it there, and the
registry tells the extension which ports to connect to (so it never dials
empty ports). If the registry's server exits, another takes `8765` over.
`OTTERBRIDGE_WS_PORT` moves the base port (the tests use 18765 so a live
Chrome never attaches to them).

> **Claude Desktop CoWork is not supported yet.** CoWork runs its agent in a
> sandboxed VM that currently fails to connect to locally installed MCP
> extensions ([known issue](https://github.com/anthropics/claude-code/issues/27492)).
> Regular Claude Desktop chat sessions work as documented above.

## Tools

28 tools — see the [root README](../README.md#what-your-ai-can-do). Each MCP
session works in its own Chrome window + tab group, opened on its first tool
call; the user's own tabs are read-only (`get_user_tab`).

## Safety (identical to the Python server)

- **Destructive-action gate**: clicks whose target text matches
  `buy|purchase|pay|checkout|order|delete|remove|send|submit|confirm|transfer|withdraw|post|publish|unsubscribe`
  require human approval via MCP elicitation.
- **Audit log**: every dispatched action is appended to `agent_actions.log`.
- **Fail-safe**: if the client can't show an approval prompt, the gate denies by
  default.
- **Full Auto**: the extension popup's Full Auto switch skips approvals for all
  connected servers (read live on every gate; no tool can change it).
- All logging goes to **stderr** (stdout is the stdio protocol channel).

### Configuration (env)

| Env | Values | Default | Meaning |
|---|---|---|---|
| `BROWSER_AGENT_GATE` | `elicit` / `off` (also accepts `true`/`false`) | `elicit` | `off`/`false` disables the approval gate |
| `BROWSER_AGENT_GATE_FALLBACK` | `deny` / `allow` (also accepts `false`/`true`) | `deny` | what to do when the client can't elicit |

The `.mcpb` exposes these as two checkboxes in Claude Desktop's settings
(booleans substitute into the env as `"true"`/`"false"`, which the server
understands).

## Develop

```bash
npm ci --ignore-scripts   # reproducible install (lockfile-exact), no dependency
                          # install scripts run — the npm supply-chain vector
npm run typecheck         # tsc --noEmit
npm run build             # esbuild -> single bundled dist/index.js
npm test                  # end-to-end: fakes the extension, drives tools over MCP
npm start                 # HTTP mode  (http://localhost:8000/mcp)
npm run start:stdio       # stdio mode
```

Tests (`test/`) spawn the built server, stand in for the Chrome extension over
the WebSocket with canned responses, and drive the real MCP tools — covering
the tool list and annotations, image content, every approval-gate branch
(clicks, dialogs, uploads, Full Auto), audit-log redaction, session isolation
and concurrency, the stdio transport, the port registry and its takeover, the
env-string parsing the `.mcpb` relies on, and the origin/host security guards.

## Get the `.mcpb`

**Most users should not build anything** — download the prebuilt
`otterbridge-browser.mcpb` from the
[Releases page](https://github.com/wen-da-ng/otterbridge-browser-mcp/releases)
(built and attached automatically by CI on every version tag), or grab the
copy committed right here as `server/otterbridge-browser.mcpb`.

To build it from source instead:

```bash
npm ci --ignore-scripts
npm run pack     # build (esbuild) + copy LICENSE in + mcpb pack -> otterbridge-browser.mcpb
```

The server is bundled by `build.mjs` (esbuild) into one self-contained
`dist/index.js`, so the `.mcpb` ships a single reviewed file — no `node_modules`
tree — and `mcpb pack` needs no prune step.

Then double-click `otterbridge-browser.mcpb` in Claude Desktop (or Settings →
Extensions → Advanced → Install Extension). See `manifest.json` for the bundle
metadata and `user_config` settings UI.

## Supply-chain notes

- **Install with `npm ci --ignore-scripts`.** No *production* dependency declares
  an install/postinstall script; the only one in the tree is `esbuild`
  (dev-only, never shipped), which still builds fine with scripts ignored (its
  binary comes from its platform package). So `--ignore-scripts` is safe and
  closes the main npm-malware vector. The committed `package-lock.json` pins
  exact versions.
- **The shipped `.mcpb` is a single bundled file** — esbuild tree-shakes to only
  the reached code, so there is no loose third-party code in the artifact.
- `@modelcontextprotocol/sdk` and `ws` are version-pinned; run `npm audit`
  before each repack.
