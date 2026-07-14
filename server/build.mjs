// Bundles the server into a single self-contained dist/index.js.
//
// Why bundle: the .mcpb then ships ONE reviewed file instead of a ~90-package
// node_modules tree (1700+ files). esbuild tree-shakes to only the code paths
// actually reached, and there is no loose third-party code in the artifact for
// a future supply-chain compromise to ride in on.
import * as esbuild from "esbuild";

await esbuild.build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  outfile: "dist/index.js",
  // `ws` optionally speeds itself up with these native addons via a guarded
  // require; they're not installed and not needed. Keep them external so esbuild
  // doesn't fail to resolve them — ws falls back to its pure-JS path at runtime.
  external: ["bufferutil", "utf-8-validate"],
  // ESM output that pulls in CJS deps needs a `require` shim (some deps call
  // require() dynamically). This is esbuild's documented pattern for it.
  banner: {
    js: "import { createRequire as __ob_cr } from 'module'; const require = __ob_cr(import.meta.url);",
  },
  logLevel: "info",
});
