import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

import {
  DEFAULT_QUICK_ASK_PRESETS,
  filePresetsFor,
  resolvePresets,
} from "../../src/quick-ask-presets.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("resolvePresets", () => {
  test("empty array yields the built-in defaults", () => {
    expect(resolvePresets([])).toEqual(DEFAULT_QUICK_ASK_PRESETS);
  });

  test("a valid list is returned in order, carrying an optional description", () => {
    const raw = [
      { label: "Test", prompt: "Write tests." },
      { label: "Types", prompt: "Improve the types.", description: "type pass" },
    ];
    expect(resolvePresets(raw)).toEqual([
      { label: "Test", prompt: "Write tests." },
      { label: "Types", prompt: "Improve the types.", description: "type pass" },
    ]);
  });

  test("non-array inputs yield the defaults", () => {
    expect(resolvePresets(undefined)).toEqual(DEFAULT_QUICK_ASK_PRESETS);
    expect(resolvePresets("nope")).toEqual(DEFAULT_QUICK_ASK_PRESETS);
    expect(resolvePresets({ label: "x", prompt: "y" })).toEqual(DEFAULT_QUICK_ASK_PRESETS);
  });

  test("invalid entries are dropped; valid ones kept in order", () => {
    const raw = [
      { label: "Good", prompt: "ok" },
      { label: "", prompt: "no label" },
      { label: "No prompt" },
      null,
      42,
      { label: "Also good", prompt: "yes" },
    ];
    expect(resolvePresets(raw)).toEqual([
      { label: "Good", prompt: "ok" },
      { label: "Also good", prompt: "yes" },
    ]);
  });

  test("a list with no valid entries falls back to defaults", () => {
    expect(resolvePresets([{ label: "" }, { prompt: "" }, null])).toEqual(
      DEFAULT_QUICK_ASK_PRESETS,
    );
  });

  test("a non-string description is omitted", () => {
    expect(resolvePresets([{ label: "L", prompt: "P", description: 42 }])).toEqual([
      { label: "L", prompt: "P" },
    ]);
  });
});

describe("filePresetsFor", () => {
  test("terraform, dockerfile, and workflow files get the ops presets", () => {
    for (const [file, lang] of [
      ["/w/main.tf", "terraform"],
      ["/w/prod.tfvars", "plaintext"],
      ["/w/Dockerfile", "dockerfile"],
      ["/w/Dockerfile.dev", "plaintext"],
      ["/w/.github/workflows/ci.yml", "yaml"],
    ] as const) {
      const presets = filePresetsFor(file, lang);
      expect(
        presets.map((p) => p.label),
        file,
      ).toContain("Blast radius");
    }
  });

  test("k8s yaml is recognized by path or by content hints, generic yaml is not", () => {
    expect(filePresetsFor("/w/k8s/deploy.yaml", "yaml").length).toBeGreaterThan(0);
    expect(
      filePresetsFor("/w/values.yaml", "yaml", "kind: Deployment\napiVersion: apps/v1").length,
    ).toBeGreaterThan(0);
    expect(filePresetsFor("/w/data.yaml", "yaml", "colors:\n - red")).toEqual([]);
  });

  test("windows-style paths are normalized", () => {
    const winPath = String.raw`C:\w\.github\workflows\ci.yaml`;
    expect(filePresetsFor(winPath, "yaml").length).toBeGreaterThan(0);
  });

  test("ordinary source files get no ops presets", () => {
    expect(filePresetsFor("/w/app.ts", "typescript")).toEqual([]);
  });
});

describe("DEFAULT_QUICK_ASK_PRESETS", () => {
  test("carries the retired /test command as a Write tests preset", () => {
    expect(DEFAULT_QUICK_ASK_PRESETS.map((p) => p.label)).toContain("Write tests");
  });

  // Adding "Write tests" left five documentation sites saying four. One of them is
  // shipped USER-FACING copy — package.json's settings description, rendered in the
  // VS Code settings UI — and one was actively harmful: docs/settings.md offers a
  // jsonc block to "add one preset while keeping the defaults", and `resolvePresets`
  // has replace-with-fallback semantics, so copying a four-entry block permanently
  // drops the fifth default. Nothing failed, because nothing read the two sides
  // against each other.
  //
  // Substring matching, not an exact list: each site phrases the enumeration its own
  // way ("Explain, Fix, Review", "Explain / Fix / Review", "**Explain**, **Fix**"),
  // and pinning the phrasing would fail on a rewording that is not a drift.
  test.each([
    ["package.json", "Empty uses the built-in defaults ("],
    ["README.md", "live as **Quick Ask presets**"],
    ["docs/settings.md", "Empty shows the built-in defaults ("],
    ["docs/architecture.md", "Resolves the configurable quick-ask preset actions ("],
  ])("%s enumerates every built-in preset label", (file, anchor) => {
    const src = readFileSync(join(REPO_ROOT, file), "utf8");
    // Fail loudly if the sentence moved, rather than passing because the labels
    // happen to appear elsewhere in a long file.
    expect(src, `anchor text not found in ${file}`).toContain(anchor);
    const missing = DEFAULT_QUICK_ASK_PRESETS.map((p) => p.label).filter(
      (label) => !src.includes(label),
    );
    expect(missing).toEqual([]);
  });

  test("docs/settings.md's copy-this-block example carries every default", () => {
    // The block is offered as a starting point that preserves the defaults, so a
    // missing entry silently removes a preset for anyone who follows it.
    const src = readFileSync(join(REPO_ROOT, "docs/settings.md"), "utf8");
    const block = /```jsonc\s*\n\s*"nimbus\.quickAsk\.presets":([\s\S]*?)```/.exec(src);
    expect(block, "the nimbus.quickAsk.presets jsonc block moved or was removed").not.toBeNull();
    const body = block?.[1] ?? "";
    const missing = DEFAULT_QUICK_ASK_PRESETS.filter((p) => !body.includes(`"${p.label}"`));
    expect(missing.map((p) => p.label)).toEqual([]);
  });
});
