#!/usr/bin/env node
// Remove build artifacts produced by `bun run build` (esbuild.mjs):
//   - dist/            the bundled extension host entry (dist/extension.js + map)
//   - media/webview.*  the bundled Webview IIFE + copied stylesheet
//
// Source (src/, test/) is never touched. Safe to run when the targets are
// already absent — rmSync with force:true is a no-op in that case.
import { rmSync } from "node:fs";

const targets = ["dist", "media/webview.js", "media/webview.css", "media/webview.js.map"];

for (const target of targets) {
  rmSync(target, { recursive: true, force: true });
}

console.log(`clean: removed ${targets.join(", ")}`);
