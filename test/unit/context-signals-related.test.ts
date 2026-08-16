import { describe, expect, test } from "vitest";

import {
  type ContextClientLike,
  relatedSection,
  type SignalDeps,
} from "../../src/context/signals.js";
import { buildSnapshot } from "../../src/context/snapshot.js";

const editor = {
  path: "src/a.ts",
  scheme: "file",
  languageId: "typescript",
  line: 0,
  selection: "",
  isDirty: false,
};

type Item = Awaited<ReturnType<ContextClientLike["searchRanked"]>>[number];

const item = (name: string, service: string): Item =>
  ({ name, service, indexPrimaryKey: `${service}:${name}`, score: 1 }) as unknown as Item;

function deps(client: ContextClientLike | undefined, limit = 5): SignalDeps {
  return { client: () => client, now: () => 0, searchLimit: () => limit };
}

const stub = (
  items: readonly Item[],
  seen?: Array<Record<string, unknown>>,
): ContextClientLike => ({
  agentsWhyPeek: async () => ({}) as Awaited<ReturnType<ContextClientLike["agentsWhyPeek"]>>,
  searchRanked: async (params) => {
    if (seen !== undefined && params !== undefined) seen.push(params);
    return items;
  },
});

describe("relatedSection", () => {
  test("lists ranked neighbours with their service", async () => {
    const section = await relatedSection(
      buildSnapshot({ generation: 1, editor }),
      deps(stub([item("b.ts", "github")])),
    );
    expect(section.rows[0]?.label).toBe("b.ts");
    expect(section.rows[0]?.detail).toBe("github");
  });

  test("excludes the file itself — it is not its own neighbour", async () => {
    const section = await relatedSection(
      buildSnapshot({ generation: 2, editor }),
      deps(stub([item("src/a.ts", "github"), item("b.ts", "github")])),
    );
    expect(section.rows.map((r) => r.label)).toEqual(["b.ts"]);
  });

  test("queries the selection when there is one, the path otherwise", async () => {
    const seen: Array<Record<string, unknown>> = [];
    await relatedSection(buildSnapshot({ generation: 3, editor }), deps(stub([], seen)));
    await relatedSection(
      buildSnapshot({ generation: 4, editor: { ...editor, selection: "parseWidget" } }),
      deps(stub([], seen)),
    );
    expect(seen[0]?.["name"]).toBe("src/a.ts");
    expect(seen[1]?.["name"]).toBe("parseWidget");
  });

  test("passes the configured limit through", async () => {
    const seen: Array<Record<string, unknown>> = [];
    await relatedSection(buildSnapshot({ generation: 5, editor }), deps(stub([], seen), 3));
    expect(seen[0]?.["limit"]).toBe(3);
  });

  test("sits out while disconnected", async () => {
    const section = await relatedSection(buildSnapshot({ generation: 6, editor }), deps(undefined));
    expect(section.empty).toBe("Needs the Nimbus Gateway.");
  });

  test("says so when the index has nothing", async () => {
    const section = await relatedSection(buildSnapshot({ generation: 7, editor }), deps(stub([])));
    expect(section.empty).toBe("Nothing related in the local index.");
  });

  test("reports a failed search as an error row rather than throwing", async () => {
    const client: ContextClientLike = {
      agentsWhyPeek: async () => ({}) as Awaited<ReturnType<ContextClientLike["agentsWhyPeek"]>>,
      searchRanked: async () => {
        throw new Error("socket closed");
      },
    };
    const section = await relatedSection(buildSnapshot({ generation: 8, editor }), deps(client));
    expect(section.rows[0]?.label).toContain("socket closed");
  });

  test("marks a failed search transient, so the controller does not cache it", async () => {
    const client: ContextClientLike = {
      agentsWhyPeek: async () => ({}) as Awaited<ReturnType<ContextClientLike["agentsWhyPeek"]>>,
      searchRanked: async () => {
        throw new Error("socket closed");
      },
    };
    const section = await relatedSection(buildSnapshot({ generation: 9, editor }), deps(client));
    expect(section.transient).toBe(true);
  });
});
