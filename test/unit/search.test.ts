import { describe, expect, test } from "vitest";

import {
  buildPicks,
  clampSearchLimit,
  normalizeInline,
  parseRankedItem,
  rankedResultToPick,
  sameName,
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
  test("omits snippet when it is whitespace-only after normalizing", () => {
    const r = parseRankedItem(row({ semanticSnippet: "   \n  " }));
    expect(r).toBeDefined();
    expect("snippet" in (r as object)).toBe(false);
  });
  test("counts non-empty string duplicates", () => {
    expect(parseRankedItem(row({ duplicates: ["a", "b", "c"] }))?.duplicateCount).toBe(3);
  });
  test("counts only valid string entries in a mixed array", () => {
    expect(parseRankedItem(row({ duplicates: ["a", "", 5, null, "b"] }))?.duplicateCount).toBe(2);
  });
  test("excludes the item's own url from the duplicate count", () => {
    // row() resolves url to canonicalUrl ("https://canonical/x"); only the
    // other entry should be counted even if the Gateway includes self.
    const r = parseRankedItem(row({ duplicates: ["https://canonical/x", "https://other/y"] }));
    expect(r?.duplicateCount).toBe(1);
  });
  test("omits duplicateCount when missing, empty, non-array, or all-invalid", () => {
    expect("duplicateCount" in (parseRankedItem(row()) as object)).toBe(false);
    expect("duplicateCount" in (parseRankedItem(row({ duplicates: [] })) as object)).toBe(false);
    expect("duplicateCount" in (parseRankedItem(row({ duplicates: "nope" })) as object)).toBe(
      false,
    );
    expect("duplicateCount" in (parseRankedItem(row({ duplicates: ["", 7] })) as object)).toBe(
      false,
    );
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
  test("a whitespace-only-snippet row's pick detail falls back to url", () => {
    const parsed = parseRankedItem(row({ semanticSnippet: "   \n  ", canonicalUrl: undefined }));
    const pick = rankedResultToPick(parsed as never);
    expect(pick.detail).toBe("https://drive/x");
  });
  test("appends a parenthesized duplicates badge (plural)", () => {
    const pick = rankedResultToPick({ name: "n", service: "s", score: 0.5, duplicateCount: 3 });
    expect(pick.description).toBe("s · score 0.50 · (+3 duplicates)");
  });
  test("uses the singular form at one duplicate", () => {
    const pick = rankedResultToPick({ name: "n", service: "s", score: 0.5, duplicateCount: 1 });
    expect(pick.description).toBe("s · score 0.50 · (+1 duplicate)");
  });
  test("omits the badge when duplicateCount is unset", () => {
    const pick = rankedResultToPick({ name: "n", service: "s", score: 0.5 });
    expect(pick.description).toBe("s · score 0.50");
  });
});

describe("buildPicks", () => {
  test("maps rows, drops malformed, preserves order", () => {
    const picks = buildPicks([row({ name: "A" }), "garbage", row({ name: "B" })]);
    expect(picks.map((p) => p.label)).toEqual(["A", "B"]);
  });
});

describe("buildPicks exclude predicate", () => {
  test("drops excluded rows and preserves order", () => {
    const rows = [row({ name: "keep A" }), row({ name: "drop me" }), row({ name: "keep B" })];
    const picks = buildPicks(rows, (r) => r.name === "drop me");
    expect(picks.map((p) => p.label)).toEqual(["keep A", "keep B"]);
  });

  test("no predicate keeps current behaviour", () => {
    const rows = [row({ name: "a" }), row({ name: "b" })];
    expect(buildPicks(rows)).toHaveLength(2);
  });
});

describe("sameName", () => {
  test("matches trimmed, case-insensitively", () => {
    const pred = sameName("  Auth Service ");
    const parsed = parseRankedItem(row({ name: "auth service" }));
    expect(parsed).toBeDefined();
    if (parsed === undefined) throw new Error("Expected row to parse");
    expect(pred(parsed)).toBe(true);
  });

  test("does not match a different name", () => {
    const pred = sameName("auth service");
    const parsed = parseRankedItem(row({ name: "billing" }));
    expect(parsed).toBeDefined();
    if (parsed === undefined) throw new Error("Expected row to parse");
    expect(pred(parsed)).toBe(false);
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

describe("clampSearchLimit", () => {
  test("passes valid in-range integers through", () => {
    expect(clampSearchLimit(50)).toBe(50);
    expect(clampSearchLimit(1)).toBe(1);
    expect(clampSearchLimit(500)).toBe(500);
  });
  test("clamps out-of-range values to 1..500", () => {
    expect(clampSearchLimit(0)).toBe(1);
    expect(clampSearchLimit(-10)).toBe(1);
    expect(clampSearchLimit(10000)).toBe(500);
  });
  test("floors fractional values", () => {
    expect(clampSearchLimit(49.9)).toBe(49);
    expect(clampSearchLimit(1.5)).toBe(1);
  });
  test("floors before clamping at the boundaries", () => {
    expect(clampSearchLimit(0.9)).toBe(1);
    expect(clampSearchLimit(500.1)).toBe(500);
    expect(clampSearchLimit(-0.5)).toBe(1);
  });
  test("falls back to 50 for non-finite / non-number input", () => {
    expect(clampSearchLimit(Number.NaN)).toBe(50);
    expect(clampSearchLimit(Number.POSITIVE_INFINITY)).toBe(50);
    expect(clampSearchLimit("200")).toBe(50);
    expect(clampSearchLimit(undefined)).toBe(50);
    expect(clampSearchLimit(null)).toBe(50);
  });
});
