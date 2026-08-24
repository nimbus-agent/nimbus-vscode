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
const properties = pkg?.contributes?.configuration?.properties;
// Fail closed: a missing/renamed configuration path must be an error, not a
// silent pass with zero settings to check.
if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
  console.error(
    "check-settings-docs: FAILED — package.json has no contributes.configuration.properties",
  );
  process.exit(1);
}
const settings = Object.keys(properties).filter((k) => k.startsWith("nimbus."));

const settingsDoc = readFileSync("docs/settings.md", "utf8");
const readme = readFileSync("README.md", "utf8");

const failures = [];
for (const key of settings) {
  // Require the setting in its documented *location*, not merely anywhere in the
  // file: a `### `nimbus.x`` section heading in settings.md, and a table row
  // (`| `nimbus.x` | … |`) in the README. `includes()` would false-pass on a
  // stray prose or example mention.
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!new RegExp(`^###\\s+.*\`${escaped}\``, "m").test(settingsDoc)) {
    failures.push(`docs/settings.md is missing a section for: ${key}`);
  }
  if (!new RegExp(`^\\|.*\`${escaped}\`.*\\|`, "m").test(readme)) {
    failures.push(`README.md settings table is missing a row for: ${key}`);
  }
}

// The other direction: a setting RENAMED or REMOVED from package.json leaves its
// documentation standing, and the loop above stays green because it only ever
// asks "is every current setting documented?". Documented-but-nonexistent is the
// worse half of settings drift — a reader who copies it into settings.json gets
// a value VS Code silently ignores, with nothing anywhere to say why.
const known = new Set(settings);
const documented = [
  ...[...settingsDoc.matchAll(/^###\s+.*`(nimbus\.[\w.]+)`/gm)].map((m) => ({
    key: m[1],
    where: "docs/settings.md has a section for",
  })),
  ...[...readme.matchAll(/^\|\s*`(nimbus\.[\w.]+)`\s*\|/gm)].map((m) => ({
    key: m[1],
    where: "README.md's settings table has a row for",
  })),
];
for (const { key, where } of documented) {
  if (!known.has(key)) {
    failures.push(`${where} a setting package.json does not contribute: ${key}`);
  }
}

if (failures.length > 0) {
  console.error("check-settings-docs: FAILED — settings and docs disagree:\n");
  for (const f of failures) console.error(`  - ${f}`);
  console.error(
    "\nDocument each nimbus.* setting in docs/settings.md (a `### `nimbus.x`` section)\nand add it to the README settings table — and when a setting is renamed or\nremoved, delete both.",
  );
  process.exit(1);
}

console.log(
  `check-settings-docs: OK — all ${settings.length} nimbus.* settings documented, and nothing documented that isn't contributed.`,
);
