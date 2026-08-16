import { describe, expect, test } from "vitest";
import type { SignalDeps } from "../../src/context/signals.js";
import { gitSection, problemsSection, SIGNAL_CATALOG } from "../../src/context/signals.js";
import { buildSnapshot } from "../../src/context/snapshot.js";

const editor = {
  path: "src/a.ts",
  scheme: "file",
  languageId: "typescript",
  line: 0,
  selection: "",
  isDirty: false,
};

const noDeps: SignalDeps = {
  client: () => undefined,
  now: () => 0,
  searchLimit: () => 20,
};

describe("problemsSection", () => {
  test("lists errors and warnings, lowest line first, one-based for the reader", async () => {
    const snap = buildSnapshot({
      generation: 1,
      editor,
      diagnostics: [
        { message: "second", severity: 1, line: 9 },
        { message: "first", severity: 0, line: 2 },
      ],
    });
    const section = await problemsSection(snap, noDeps);
    expect(section.rows.map((r) => r.label)).toEqual(["Line 3: first", "Line 10: second"]);
  });

  test("drops Information and Hint, exactly as the lightbulb actions do", async () => {
    const snap = buildSnapshot({
      generation: 2,
      editor,
      diagnostics: [
        { message: "fyi", severity: 2, line: 1 },
        { message: "hint", severity: 3, line: 2 },
      ],
    });
    expect((await problemsSection(snap, noDeps)).rows).toEqual([]);
    expect((await problemsSection(snap, noDeps)).empty).toBe("No errors or warnings in this file.");
  });

  test("says so when there is no file at all", async () => {
    expect((await problemsSection(buildSnapshot({ generation: 3 }), noDeps)).empty).toBe(
      "No file open.",
    );
  });
});

describe("gitSection", () => {
  test("shows the branch and the changed-file count", async () => {
    const snap = buildSnapshot({
      generation: 4,
      editor,
      git: { branch: "feat/x", changedPaths: ["src/a.ts", "src/b.ts"] },
    });
    expect((await gitSection(snap, noDeps)).rows.map((r) => r.label)).toEqual([
      "feat/x",
      "2 changed files",
    ]);
  });

  test("uses the singular for one changed file", async () => {
    const snap = buildSnapshot({
      generation: 5,
      editor,
      git: { branch: "main", changedPaths: ["src/a.ts"] },
    });
    expect((await gitSection(snap, noDeps)).rows[1]?.label).toBe("1 changed file");
  });

  test("omits the count row entirely when no one looked at the changed files", async () => {
    const snap = buildSnapshot({
      generation: 41,
      editor,
      git: { branch: "main", changedPaths: undefined },
    });
    const rows = (await gitSection(snap, noDeps)).rows;
    expect(rows.map((r) => r.label)).toEqual(["main"]);
    expect(rows.some((r) => r.label.includes("changed"))).toBe(false);
  });

  test("reports a detached HEAD rather than pretending there is a branch", async () => {
    const snap = buildSnapshot({
      generation: 6,
      editor,
      git: { branch: undefined, changedPaths: [] },
    });
    expect((await gitSection(snap, noDeps)).rows[0]?.label).toBe("Detached HEAD");
  });

  test("says so when there is no repository", async () => {
    expect((await gitSection(buildSnapshot({ generation: 7, editor }), noDeps)).empty).toBe(
      "No git repository here.",
    );
  });
});

describe("SIGNAL_CATALOG", () => {
  test("covers four signals: two local, two Gateway-backed", () => {
    expect(SIGNAL_CATALOG.map((s) => s.id)).toEqual(["problems", "git", "blame", "related"]);
    expect(
      SIGNAL_CATALOG.filter((s) => s.id === "problems" || s.id === "git").every(
        (s) => s.needsGateway === false,
      ),
    ).toBe(true);
    expect(
      SIGNAL_CATALOG.filter((s) => s.id === "blame" || s.id === "related").every(
        (s) => s.needsGateway === true,
      ),
    ).toBe(true);
  });

  test("each entry collects the section its id names", async () => {
    const snap = buildSnapshot({ generation: 8, editor });
    for (const spec of SIGNAL_CATALOG) {
      const section = await spec.collect(snap, noDeps);
      expect(section.id).toBe(spec.id);
    }
  });

  test("local signals declare no cache key; blame caches by line; related caches by query", () => {
    const snap = buildSnapshot({ generation: 9, editor });
    const problsms = SIGNAL_CATALOG.find((s) => s.id === "problems");
    const git = SIGNAL_CATALOG.find((s) => s.id === "git");
    const blame = SIGNAL_CATALOG.find((s) => s.id === "blame");
    const related = SIGNAL_CATALOG.find((s) => s.id === "related");
    expect(problsms?.cacheKey(snap)).toBeUndefined();
    expect(git?.cacheKey(snap)).toBeUndefined();
    expect(blame?.cacheKey(snap)).toBe("src/a.ts:0");
    expect(related?.cacheKey(snap)).toBe("src/a.ts:");
  });

  test("related's cache key includes the path, so two files sharing a selection do not collide", () => {
    const related = SIGNAL_CATALOG.find((s) => s.id === "related");
    const a = buildSnapshot({
      generation: 10,
      editor: { ...editor, selection: "parseWidget" },
    });
    const b = buildSnapshot({
      generation: 11,
      editor: { ...editor, path: "src/b.ts", selection: "parseWidget" },
    });
    expect(related?.cacheKey(a)).not.toBe(related?.cacheKey(b));
  });
});
