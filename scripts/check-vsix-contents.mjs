#!/usr/bin/env node
// Guard what the published .vsix actually ships.
//
// `vsce` packages everything in the repo that .vscodeignore does not exclude —
// a denylist. That default fails open: every new top-level directory (a CI
// config, a coverage report, an agent's scratch notes) silently joins the
// artifact that goes to the Marketplace and Open VSX. Shipping internal repo
// state is both a privacy leak and dead weight in a user's download.
//
// So this script inverts the check into an allowlist: the .vsix may contain
// ONLY the runtime artifact, its assets, and the marketplace-facing docs.
// Anything else is a failure that names the offending paths. Adding a genuinely
// shippable path is a deliberate one-line edit to ALLOWED below.
//
// Run after `bun run build` (dist/ and media/ must exist to be listed). CI runs
// it on every push/PR, next to check-bundle.
import { listFiles, PackageManager } from "@vscode/vsce";

// Exact files, and directory prefixes, that legitimately ship to users.
const ALLOWED_FILES = new Set([
  "package.json",
  "icon.png",
  "README.md",
  "CHANGELOG.md",
  "LICENSE",
  "SECURITY.md",
]);
const ALLOWED_DIRS = ["dist/", "media/", "resources/"];

const isAllowed = (file) =>
  ALLOWED_FILES.has(file) || ALLOWED_DIRS.some((dir) => file.startsWith(dir));

// PackageManager.None mirrors the `--no-dependencies` flag the package script
// uses — esbuild has already inlined every dep (see check-bundle.mjs). It is the
// only way to set it through this API: listFiles() derives `dependencies` from
// `packageManager`, so passing `dependencies: false` is silently overridden and
// vsce then shells out to `npm list`, which fails on a bun-installed tree.
const files = (await listFiles({ cwd: process.cwd(), packageManager: PackageManager.None })).map(
  (f) => f.split("\\").join("/"),
);

const unexpected = files.filter((f) => !isAllowed(f)).sort();

if (unexpected.length > 0) {
  console.error(
    `check-vsix-contents: FAILED — ${unexpected.length} unexpected file(s) in the .vsix`,
  );
  for (const file of unexpected.slice(0, 40)) {
    console.error(`  - ${file}`);
  }
  if (unexpected.length > 40) {
    console.error(`  … and ${unexpected.length - 40} more`);
  }
  console.error("\nAdd them to .vscodeignore, or to ALLOWED in scripts/check-vsix-contents.mjs.");
  process.exit(1);
}

// A .vsix without the bundle would "pass" an allowlist trivially — assert the
// payload is actually present so the guard cannot be satisfied by an empty set.
const missing = [
  "dist/extension.js",
  "media/webview.js",
  "media/context.js",
  "media/context.css",
  "package.json",
].filter((required) => !files.includes(required));
if (missing.length > 0) {
  console.error(`check-vsix-contents: FAILED — missing required file(s): ${missing.join(", ")}`);
  console.error("(did you run `bun run build`?)");
  process.exit(1);
}

console.log(`check-vsix-contents: OK — ${files.length} files, all within the allowlist`);
