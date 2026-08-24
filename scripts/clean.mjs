#!/usr/bin/env node
// Remove build artifacts produced by `bun run build` (esbuild.mjs) and
// `bun run test:ui` (scripts/run-ui-tests.mjs):
//   - dist/            the bundled extension host entry (dist/extension.js + map)
//   - media/webview.*  the chat Webview IIFE + copied stylesheet
//   - media/context.*  the ambient context panel's Webview IIFE + stylesheet
//   - out/             compiled UI specs + the generated ExTester user-settings file
//   - test-resources/  ExTester's downloaded VS Code + chromedriver + user-data-dir
//
// esbuild.mjs produces THREE bundles, not two: every `outfile`/`copyFileSync`
// target there needs a line below, or `bun run clean` leaves a stale artifact
// that the next `check-vsix-contents` still counts. media/ is entirely
// generated (nothing under it is tracked), but the targets stay file-by-file so
// this script can never remove something a build did not create.
//
// Source (src/, test/) is never touched. Safe to run when the targets are
// already absent — rmSync with force:true is a no-op in that case.
import { rmSync } from "node:fs";

const targets = [
  "dist",
  "media/webview.js",
  "media/webview.css",
  "media/webview.js.map",
  "media/context.js",
  "media/context.css",
  "media/context.js.map",
  "out",
  "test-resources",
];

for (const target of targets) {
  rmSync(target, { recursive: true, force: true });
}

console.log(`clean: removed ${targets.join(", ")}`);
