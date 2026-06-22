#!/usr/bin/env node
// Guard the load-bearing bundling invariant (see CLAUDE.md → "Architecture"):
//
//   The published .vsix has NO runtime npm dependency. esbuild inlines every
//   dependency — including @nimbus-dev/client — into dist/extension.js, leaving
//   `vscode` (provided by the host) as the ONLY external require.
//
// If that ever regressed (e.g. a dep marked external, or a new native module),
// the extension would fail to load on a user's machine because node_modules is
// not shipped. This script makes the invariant self-verifying: run it after
// `bun run build`. CI runs it on every push/PR.
//
// Checks:
//   1. Both bundles exist (dist/extension.js, media/webview.js).
//   2. The extension bundle's only external require()s are node builtins +
//      "vscode" — in particular @nimbus-dev/client must be inlined, not required.
import { existsSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";

const EXTENSION_BUNDLE = "dist/extension.js";
const WEBVIEW_BUNDLE = "media/webview.js";

// Anything the VS Code host provides at runtime, plus node's own builtins.
const allowed = new Set(["vscode", ...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);

const failures = [];

// 1. Bundles must exist — a missing artifact means `bun run build` didn't run.
for (const artifact of [EXTENSION_BUNDLE, WEBVIEW_BUNDLE]) {
  if (!existsSync(artifact)) {
    failures.push(`missing build artifact: ${artifact} (did you run \`bun run build\`?)`);
  }
}

// 2. The extension bundle may only `require()` allowed externals.
if (existsSync(EXTENSION_BUNDLE)) {
  const source = readFileSync(EXTENSION_BUNDLE, "utf8");
  const required = new Set();
  // Match require("x") / require('x') with a string literal specifier.
  const re = /require\(\s*["']([^"']+)["']\s*\)/g;
  let match = re.exec(source);
  while (match !== null) {
    required.add(match[1]);
    match = re.exec(source);
  }

  for (const spec of [...required].sort()) {
    if (!allowed.has(spec)) {
      const hint = spec === "@nimbus-dev/client" ? " (must be inlined, not required at runtime)" : "";
      failures.push(`unexpected external require in ${EXTENSION_BUNDLE}: "${spec}"${hint}`);
    }
  }
}

if (failures.length > 0) {
  console.error("check-bundle: FAILED");
  for (const failure of failures) {
    console.error(`  - ${failure}`);
  }
  process.exit(1);
}

console.log(`check-bundle: OK — ${EXTENSION_BUNDLE} externalizes only node builtins + vscode`);
