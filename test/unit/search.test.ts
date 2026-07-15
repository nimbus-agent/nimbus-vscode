import { describe, expect, test } from "vitest";

import {
  buildPicks,
  normalizeInline,
  parseRankedItem,
  rankedResultToPick,
  statusPick,
} from "../../src/search.js";

function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "Q3 report.pdf",
    service: "gdrive",
    itemType: "file",
    indexedType: "gdrive_file",
    score: 0.912345,
    url: "https://drive/x",
    canonicalUrl: "https://canonical/x",
    semanticSnippet: "line one\nline two",
    ...over,
  };
}

describe("normalizeInline", () => {
  test("collapses whitespace/newlines and trims", () => {
    expect(normalizeInline("  a\n\tb   c  ")).toBe("a b c");
  });
  test("truncates to max with an ellipsis, trimming trailing space", () => {
    expect(normalizeInline("abcdef ghij", 5)).toBe("abcde…");
    expect(normalizeInline("abc de", 4)).toBe("abc…");
  });
  test("no truncation when short or max omitted", () => {
    expect(normalizeInline("abc", 10)).toBe("abc");
    expect(normalizeInline("a b c")).toBe("a b c");
  });
});

describe("parseRankedItem", () => {
  test("coerces a full row, preferring canonicalUrl and normalizing the snippet", () => {
    const r = parseRankedItem(row());
    expect(r).toEqual({
      name: "Q3 report.pdf",
      service: "gdrive",
      itemType: "file",
      score: 0.912345,
      url: "https://canonical/x",
      snippet: "line one line two",
    });
  });
  test("falls back to url when canonicalUrl is absent", () => {
    expect(parseRankedItem(row({ canonicalUrl: undefined }))?.url).toBe("https://drive/x");
  });
  test("falls back itemType to indexedType", () => {
    expect(parseRankedItem(row({ itemType: undefined }))?.itemType).toBe("gdrive_file");
  });
  test("omits url/itemType/snippet when none are present", () => {
    const r = parseRankedItem({ name: "x", service: "s", score: 1 });
    expect(r).toEqual({ name: "x", service: "s", score: 1 });
    expect("url" in (r as object)).toBe(false);
    expect("itemType" in (r as object)).toBe(false);
    expect("snippet" in (r as object)).toBe(false);
  });
  test("rejects rows without a name, and non-objects", () => {
    expect(parseRankedItem(row({ name: undefined }))).toBeUndefined();
    expect(parseRankedItem(row({ name: "" }))).toBeUndefined();
    expect(parseRankedItem("nope")).toBeUndefined();
    expect(parseRankedItem(null)).toBeUndefined();
  });
  test("defaults a missing/non-numeric score to 0 and missing service to ''", () => {
    const r = parseRankedItem({ name: "x", score: "nope" });
    expect(r).toMatchObject({ score: 0, service: "" });
  });
});

describe("rankedResultToPick", () => {
  test("builds label/description/detail with alwaysShow and a 2-dp score", () => {
    const pick = rankedResultToPick(parseRankedItem(row()) as never);
    expect(pick).toMatchObject({
      label: "Q3 report.pdf",
      description: "gdrive · file · score 0.91",
      detail: "line one line two",
      alwaysShow: true,
      url: "https://canonical/x",
      canOpen: true,
    });
  });
  test("omits the itemType segment when absent", () => {
    const pick = rankedResultToPick({ name: "n", service: "s", score: 0.5 });
    expect(pick.description).toBe("s · score 0.50");
  });
  test("no url → canOpen false and a placeholder detail", () => {
    const pick = rankedResultToPick({ name: "n", service: "s", score: 0.5 });
    expect(pick.canOpen).toBe(false);
    expect(pick.detail).toBe("No source URL available");
    expect("url" in pick).toBe(false);
  });
  test("detail falls back to url when there is no snippet", () => {
    const pick = rankedResultToPick({ name: "n", service: "s", score: 1, url: "u" });
    expect(pick.detail).toBe("u");
  });
});

describe("buildPicks", () => {
  test("maps rows, drops malformed, preserves order", () => {
    const picks = buildPicks([row({ name: "A" }), "garbage", row({ name: "B" })]);
    expect(picks.map((p) => p.label)).toEqual(["A", "B"]);
  });
});

describe("statusPick", () => {
  test("is a non-selectable always-shown row", () => {
    expect(statusPick("No matching index records")).toEqual({
      label: "No matching index records",
      description: "",
      detail: "",
      alwaysShow: true,
      canOpen: false,
      isStatus: true,
    });
  });
});
