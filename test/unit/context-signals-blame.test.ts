import { describe, expect, test } from "vitest";

import {
  blameSection,
  type ContextClientLike,
  type SignalDeps,
} from "../../src/context/signals.js";
import { buildSnapshot } from "../../src/context/snapshot.js";

const editor = {
  path: "src/a.ts",
  scheme: "file",
  languageId: "typescript",
  line: 41,
  selection: "",
  isDirty: false,
};

const PEEK = {
  subject: null,
  author: "Ada",
  authorEmail: "ada@example.test",
  commitSha: "abcdef1234567890",
  committedAt: 0,
  commitSubject: "fix: the thing",
  pr: { number: 42, title: "t", url: "https://example.test/pr/42" },
  ticket: null,
  hasMore: false,
};

function deps(client: ContextClientLike | undefined): SignalDeps {
  return { client: () => client, now: () => 60_000, searchLimit: () => 20 };
}

const stub = (peek: unknown): ContextClientLike => ({
  agentsWhyPeek: async () => peek as Awaited<ReturnType<ContextClientLike["agentsWhyPeek"]>>,
  searchRanked: async () => [],
});

describe("blameSection", () => {
  test("renders author, subject and PR for the cursor line", async () => {
    const section = await blameSection(buildSnapshot({ generation: 1, editor }), deps(stub(PEEK)));
    const labels = section.rows.map((r) => r.label);
    expect(labels.some((l) => l.includes("Ada"))).toBe(true);
    expect(labels).toContain("fix: the thing");
    expect(labels).toContain("PR #42");
  });

  test("never renders the author email", async () => {
    const section = await blameSection(buildSnapshot({ generation: 2, editor }), deps(stub(PEEK)));
    expect(JSON.stringify(section)).not.toContain("ada@example.test");
  });

  test("asks the Gateway about the cursor line one-based, by repo-relative ref", async () => {
    const seen: Array<{ ref: string; line?: number }> = [];
    const client: ContextClientLike = {
      agentsWhyPeek: async (p) => {
        seen.push(p);
        return PEEK as Awaited<ReturnType<ContextClientLike["agentsWhyPeek"]>>;
      },
      searchRanked: async () => [],
    };
    await blameSection(buildSnapshot({ generation: 3, editor }), deps(client));
    // 42, not 41: the editor's cursor line is zero-based and the Gateway
    // parameter is one-based (whyParams/toOneBased). Asserting 41 here would
    // pin the panel to the line ABOVE the cursor.
    expect(seen).toEqual([{ ref: "src/a.ts", line: 42 }]);
  });

  test("says so when the repo is not indexed yet, rather than showing an empty box", async () => {
    const empty = { ...PEEK, author: null, commitSha: null, commitSubject: null, pr: null };
    const section = await blameSection(buildSnapshot({ generation: 4, editor }), deps(stub(empty)));
    expect(section.rows).toEqual([]);
    expect(section.empty).toBe(
      "No history for this line yet — has `nimbus init` indexed this repo?",
    );
  });

  test("sits out while disconnected instead of failing", async () => {
    const section = await blameSection(buildSnapshot({ generation: 5, editor }), deps(undefined));
    expect(section.empty).toBe("Needs the Nimbus Gateway.");
  });

  test("says so when there is no file", async () => {
    const section = await blameSection(buildSnapshot({ generation: 6 }), deps(stub(PEEK)));
    expect(section.empty).toBe("No file open.");
  });

  test("reports a failed lookup as an error row rather than throwing", async () => {
    const client: ContextClientLike = {
      agentsWhyPeek: async () => {
        throw new Error("socket closed");
      },
      searchRanked: async () => [],
    };
    const section = await blameSection(buildSnapshot({ generation: 7, editor }), deps(client));
    expect(section.rows[0]?.label).toContain("socket closed");
  });

  test("marks a failed lookup transient, so the controller does not cache it", async () => {
    const client: ContextClientLike = {
      agentsWhyPeek: async () => {
        throw new Error("socket closed");
      },
      searchRanked: async () => [],
    };
    const section = await blameSection(buildSnapshot({ generation: 8, editor }), deps(client));
    expect(section.transient).toBe(true);
  });
});
