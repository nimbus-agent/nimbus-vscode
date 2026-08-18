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
  test("is empty and suppressed when every connector is healthy", async () => {
    const section = await connectorsSection(snapshot, deps({ count: 0, names: [] }));
    expect(section.rows).toEqual([]);
    expect(section.suppressWhenEmpty).toBe(true);
  });

  test("names the degraded connectors when there are any", async () => {
    const section = await connectorsSection(
      snapshot,
      deps({ count: 2, names: ["github", "slack"] }),
    );
    expect(section.title).toBe("Sources");
    expect(section.rows.map((r) => r.label)).toEqual(["github", "slack"]);
    expect(section.rows[0]?.iconId).toBe("warning");
    expect(section.rows[0]?.detail).toBe("sync failing");
  });

  test("makes no Gateway call at all", async () => {
    await expect(
      connectorsSection(snapshot, deps({ count: 1, names: ["github"] })),
    ).resolves.toBeDefined();
  });
});
