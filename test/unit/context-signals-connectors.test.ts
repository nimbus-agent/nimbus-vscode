import { describe, expect, test } from "vitest";

import { connectorsSection } from "../../src/context/signals.js";
import type { ContextSnapshot } from "../../src/context/snapshot.js";

const snapshot = { path: "src/a.ts", diagnostics: [] } as unknown as ContextSnapshot;

function deps(summary: { count: number; names: string[] }) {
  return {
    connectorHealth: () => summary,
    // If the collector ever reaches the Gateway, this throws and the test fails.
    client: () => {
      throw new Error("the Sources row must make no Gateway call");
    },
    now: () => 0,
    searchLimit: () => 5,
  } as never;
}

describe("the Sources section", () => {
  test("is empty and suppressed when every connector is healthy", () => {
    const section = connectorsSection(snapshot, deps({ count: 0, names: [] }));
    expect(section.rows).toEqual([]);
    expect(section.suppressWhenEmpty).toBe(true);
  });

  test("names the degraded connectors when there are any", () => {
    const section = connectorsSection(snapshot, deps({ count: 2, names: ["github", "slack"] }));
    expect(section.title).toBe("Sources");
    expect(section.rows.map((r) => r.label)).toEqual(["github", "slack"]);
    expect(section.rows[0]?.iconId).toBe("warning");
    expect(section.rows[0]?.detail).toBe("sync failing");
  });

  // The collector is synchronous, so a client() call would throw straight out
  // of this call and fail the test.
  test("makes no Gateway call at all", () => {
    expect(connectorsSection(snapshot, deps({ count: 1, names: ["github"] }))).toBeDefined();
  });
});
