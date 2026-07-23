import { describe, expect, test } from "vitest";

import { DEFAULT_QUICK_ASK_PRESETS, filePresetsFor, resolvePresets } from "../../src/quick-ask-presets.js";

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
      expect(presets.map((p) => p.label), file).toContain("Blast radius");
    }
  });

  test("k8s yaml is recognized by path or by content hints, generic yaml is not", () => {
    expect(filePresetsFor("/w/k8s/deploy.yaml", "yaml").length).toBeGreaterThan(0);
    expect(filePresetsFor("/w/values.yaml", "yaml", "kind: Deployment\napiVersion: apps/v1").length).toBeGreaterThan(0);
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
});
