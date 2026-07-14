# OtterBridge — Node server (`server/`)

The Node/TypeScript port of the OtterBridge MCP server. One codebase, two
transports, byte-compatible with the same unchanged Otter Chrome extension:

- **stdio** (`--stdio`) — for Claude Desktop / the `.mcpb` bundle, which launches
  the server itself. **This is the zero-prerequisite path**: Node ships inside
  Claude Desktop, so a non-technical user just double-clicks the `.mcpb`.
- **streamable HTTP** (default, `http://localhost:8000/mcp`) — for Claude Code,
  MCP Inspector, or any HTTP MCP client you start the server for.

Both modes host the `ws://localhost:8765` bridge the extension connects to.
Only one process may bind `:8765` at a time.

## The 9 tools

`navigate`, `read_page`, `read_elements`, **`click_element(index)`** (preferred —
drift-free, coordinate resolved in-page), `click(x,y)`, `type_text`,
`press_key`, `scroll`, `screenshot`.

## Safety (identical to the Python server)

- **Destructive-action gate**: clicks whose target text matches
  `buy|purchase|pay|checkout|order|delete|remove|send|submit|confirm|transfer|withdraw|post|publish|unsubscribe`
  require human approval via MCP elicitation.
- **Audit log**: every dispatched action is appended to `agent_actions.log`.
- **Fail-safe**: if the client can't show an approval prompt, the gate denies by
  default.
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
the WebSocket with canned responses, and drive the real MCP tools — covering all
9 tools, image content, both gate branches, session isolation, the stdio
transport, the single-instance `:8765` guard, the env-string parsing the
`.mcpb` relies on, and the origin/host security guards.

## Package the `.mcpb`

The server is bundled by `build.mjs` (esbuild) into one self-contained
`dist/index.js`, so the `.mcpb` ships a single reviewed file — no `node_modules`
tree — and `mcpb pack` needs no prune step:

```bash
npm run build
npx @anthropic-ai/mcpb pack . otterbridge.mcpb
```

Then double-click `otterbridge.mcpb` in Claude Desktop (or Settings →
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
