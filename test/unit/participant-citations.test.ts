import { describe, expect, test } from "vitest";
import { buildCitations } from "../../src/chat-participant/citations.js";

// A searchRanked row shape as parseRankedItem consumes it (name + canonicalUrl).
function row(name: string, canonicalUrl?: string): Record<string, unknown> {
  return { name, service: "fs", score: 0.9, ...(canonicalUrl ? { canonicalUrl } : {}) };
}

describe("buildCitations", () => {
  test("maps rows with a url to {label, target}", () => {
    const out = buildCitations([row("a.ts", "file:///w/a.ts"), row("b.ts", "file:///w/b.ts")], { limit: 5 });
    expect(out).toEqual([
      { label: "a.ts", target: "file:///w/a.ts" },
      { label: "b.ts", target: "file:///w/b.ts" },
    ]);
  });

  test("drops rows without a click target", () => {
    expect(buildCitations([row("no-url")], { limit: 5 })).toEqual([]);
  });

  test("self-excludes the active file by basename", () => {
    const out = buildCitations([row("self.ts", "file:///w/self.ts"), row("other.ts", "file:///w/other.ts")], {
      excludeBasename: "self.ts",
      limit: 5,
    });
    expect(out.map((c) => c.label)).toEqual(["other.ts"]);
  });

  test("caps at the limit", () => {
    const rows = Array.from({ length: 10 }, (_, i) => row(`f${i}.ts`, `file:///w/f${i}.ts`));
    expect(buildCitations(rows, { limit: 3 })).toHaveLength(3);
  });

  test("skips malformed rows without throwing", () => {
    expect(buildCitations([null, 42, row("ok.ts", "file:///w/ok.ts")], { limit: 5 })).toHaveLength(1);
  });
});
