#!/usr/bin/env node
// Guard against settings-doc drift: every `nimbus.*` configuration property the
// extension contributes (package.json → contributes.configuration.properties)
// must be documented in docs/settings.md AND listed in the README settings
// table. This is the invariant that quietly broke when `nimbus.search.limit`
// and `nimbus.agents` shipped without a docs update. CI runs it on every PR.
//
// It intentionally does NOT check command/view IDs (also under the nimbus.*
// namespace) — only user-facing configuration settings.
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const properties = pkg?.contributes?.configuration?.properties ?? {};
const settings = Object.keys(properties).filter((k) => k.startsWith("nimbus."));

const settingsDoc = readFileSync("docs/settings.md", "utf8");
const readme = readFileSync("README.md", "utf8");

const failures = [];
for (const key of settings) {
  // Both docs reference a setting as a backtick-wrapped `nimbus.x`.
  const token = `\`${key}\``;
  if (!settingsDoc.includes(token)) failures.push(`docs/settings.md is missing: ${key}`);
  if (!readme.includes(token)) failures.push(`README.md settings table is missing: ${key}`);
}

if (failures.length > 0) {
  console.error("check-settings-docs: FAILED — undocumented settings:\n");
  for (const f of failures) console.error(`  - ${f}`);
  console.error(
    "\nDocument each nimbus.* setting in docs/settings.md (a `### `nimbus.x`` section)\nand add it to the README settings table.",
  );
  process.exit(1);
}

console.log(`check-settings-docs: OK — all ${settings.length} nimbus.* settings documented.`);
