#!/usr/bin/env node
// Remove build artifacts produced by `bun run build` (esbuild.mjs) and
// `bun run test:ui` (scripts/run-ui-tests.mjs):
//   - dist/            the bundled extension host entry (dist/extension.js + map)
//   - media/webview.*  the bundled Webview IIFE + copied stylesheet
//   - out/             compiled UI specs + the generated ExTester user-settings file
//   - test-resources/  ExTester's downloaded VS Code + chromedriver + user-data-dir
//
// Source (src/, test/) is never touched. Safe to run when the targets are
// already absent — rmSync with force:true is a no-op in that case.
import { rmSync } from "node:fs";

const targets = [
  "dist",
  "media/webview.js",
  "media/webview.css",
  "media/webview.js.map",
  "out",
  "test-resources",
];

for (const target of targets) {
  rmSync(target, { recursive: true, force: true });
}

console.log(`clean: removed ${targets.join(", ")}`);
