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

const itemInFile = (name: string, service: string, file: string): Item =>
  ({
    name,
    service,
    indexPrimaryKey: `${service}:${name}:${file}`,
    score: 1,
    rawMeta: { file },
  }) as unknown as Item;

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
    // And transient, so a socket that dropped mid-collection is not cached as
    // this file's answer.
    expect(section.transient).toBe(true);
  });

  // The mirror of blameSection's identical branch: with no editor there is
  // neither a selection nor a path to query, so the collector must say so
  // rather than searching for "undefined" or asking with no name at all.
  test("says so when there is no file", async () => {
    const section = await relatedSection(buildSnapshot({ generation: 10 }), deps(stub([])));
    expect(section.rows).toEqual([]);
    expect(section.empty).toBe("No file open.");
  });

  test("says so when the index has nothing", async () => {
    const section = await relatedSection(buildSnapshot({ generation: 7, editor }), deps(stub([])));
    expect(section.empty).toBe("Nothing else in the local index looks related.");
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

  test("excludes items whose rawMeta.file is the open file", async () => {
    const section = await relatedSection(
      buildSnapshot({ generation: 10, editor }),
      deps(
        stub([
          itemInFile("aThing (function)", "filesystem", "src/a.ts"),
          itemInFile("bThing (function)", "filesystem", "src/b.ts"),
        ]),
      ),
    );
    expect(section.rows.map((r) => r.label)).toEqual(["bThing (function)"]);
  });

  test("collapses duplicate rows for the same symbol in the same file", async () => {
    const section = await relatedSection(
      buildSnapshot({ generation: 11, editor }),
      deps(
        stub([
          itemInFile("bThing (function)", "filesystem", "src/b.ts"),
          itemInFile("bThing (function)", "filesystem", "src/b.ts"),
          itemInFile("bThing (function)", "filesystem", "src/c.ts"),
        ]),
      ),
    );
    expect(section.rows.map((r) => r.label)).toEqual(["bThing (function)", "bThing (function)"]);
    expect(section.rows.map((r) => r.detail)).toEqual(["filesystem", "filesystem"]);
  });

  test("excludes the open file via its repo-relative path when it differs from the workspace-relative one", async () => {
    // The live index stores rawMeta.file repo-root-relative, so a file
    // indexed while it sat in a git worktree carries that prefix, while
    // snapshot.path stays workspace-root-relative. snapshot.repoPath is the
    // projection that lines up with what the index stored.
    const section = await relatedSection(
      buildSnapshot({
        generation: 14,
        editor: { ...editor, repoPath: ".claude/worktrees/wt/src/a.ts" },
      }),
      deps(
        stub([
          itemInFile("aThing (function)", "filesystem", ".claude/worktrees/wt/src/a.ts"),
          itemInFile("bThing (function)", "filesystem", "src/b.ts"),
        ]),
      ),
    );
    expect(section.rows.map((r) => r.label)).toEqual(["bThing (function)"]);
  });

  // Regression test for a suffix-match design this collector used to have:
  // matching "file.endsWith('/'+path)" also matches two genuinely different
  // files that merely share a directory-boundary-aligned tail.
  test("keeps a different file whose path merely ends with the open file's path", async () => {
    const section = await relatedSection(
      buildSnapshot({
        generation: 17,
        editor: { ...editor, path: "src/a.ts", repoPath: "src/a.ts" },
      }),
      deps(stub([itemInFile("index (function)", "filesystem", "packages/service-b/src/a.ts")])),
    );
    expect(section.rows.map((r) => r.label)).toEqual(["index (function)"]);
  });

  test("does not collapse same-named items from different services", async () => {
    const section = await relatedSection(
      buildSnapshot({ generation: 15, editor }),
      deps(stub([item("deploy failed", "jira"), item("deploy failed", "slack")])),
    );
    expect(section.rows.map((r) => r.detail)).toEqual(["jira", "slack"]);
  });

  test("collapses same-named items from one service that carry no file", async () => {
    // Five github_actions rows for one commit's re-runs differ only by run id.
    const section = await relatedSection(
      buildSnapshot({ generation: 16, editor }),
      deps(
        stub([
          item("nightly — success", "github_actions"),
          item("nightly — success", "github_actions"),
        ]),
      ),
    );
    expect(section.rows).toHaveLength(1);
  });

  test("keeps an item whose rawMeta carries no usable file", async () => {
    const section = await relatedSection(
      buildSnapshot({ generation: 12, editor }),
      deps(stub([item("an-incident", "pagerduty")])),
    );
    expect(section.rows.map((r) => r.label)).toEqual(["an-incident"]);
  });

  test("says the file has no neighbours when every hit is from the file itself", async () => {
    const section = await relatedSection(
      buildSnapshot({ generation: 13, editor }),
      deps(stub([itemInFile("aThing (function)", "filesystem", "src/a.ts")])),
    );
    expect(section.rows).toEqual([]);
    expect(section.empty).toBe("Nothing else in the local index looks related.");
  });
});
