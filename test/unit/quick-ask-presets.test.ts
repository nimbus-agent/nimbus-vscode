import { describe, expect, test } from "vitest";

import {
  DEFAULT_QUICK_ASK_PRESETS,
  resolvePresets,
} from "../../src/quick-ask-presets.js";

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
