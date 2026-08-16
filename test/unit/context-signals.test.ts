import { describe, expect, test } from "vitest";

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

describe("problemsSection", () => {
  test("lists errors and warnings, lowest line first, one-based for the reader", () => {
    const snap = buildSnapshot({
      generation: 1,
      editor,
      diagnostics: [
        { message: "second", severity: 1, line: 9 },
        { message: "first", severity: 0, line: 2 },
      ],
    });
    const section = problemsSection(snap);
    expect(section.rows.map((r) => r.label)).toEqual(["Line 3: first", "Line 10: second"]);
  });

  test("drops Information and Hint, exactly as the lightbulb actions do", () => {
    const snap = buildSnapshot({
      generation: 2,
      editor,
      diagnostics: [
        { message: "fyi", severity: 2, line: 1 },
        { message: "hint", severity: 3, line: 2 },
      ],
    });
    expect(problemsSection(snap).rows).toEqual([]);
    expect(problemsSection(snap).empty).toBe("No errors or warnings in this file.");
  });

  test("says so when there is no file at all", () => {
    expect(problemsSection(buildSnapshot({ generation: 3 })).empty).toBe("No file open.");
  });
});

describe("gitSection", () => {
  test("shows the branch and the changed-file count", () => {
    const snap = buildSnapshot({
      generation: 4,
      editor,
      git: { branch: "feat/x", changedPaths: ["src/a.ts", "src/b.ts"] },
    });
    expect(gitSection(snap).rows.map((r) => r.label)).toEqual(["feat/x", "2 changed files"]);
  });

  test("uses the singular for one changed file", () => {
    const snap = buildSnapshot({
      generation: 5,
      editor,
      git: { branch: "main", changedPaths: ["src/a.ts"] },
    });
    expect(gitSection(snap).rows[1]?.label).toBe("1 changed file");
  });

  test("reports a detached HEAD rather than pretending there is a branch", () => {
    const snap = buildSnapshot({
      generation: 6,
      editor,
      git: { branch: undefined, changedPaths: [] },
    });
    expect(gitSection(snap).rows[0]?.label).toBe("Detached HEAD");
  });

  test("says so when there is no repository", () => {
    expect(gitSection(buildSnapshot({ generation: 7, editor })).empty).toBe(
      "No git repository here.",
    );
  });
});

describe("SIGNAL_CATALOG", () => {
  test("covers both local signals and claims no Gateway", () => {
    expect(SIGNAL_CATALOG.map((s) => s.id)).toEqual(["problems", "git"]);
    expect(SIGNAL_CATALOG.every((s) => s.needsGateway === false)).toBe(true);
  });

  test("each entry collects the section its id names", () => {
    const snap = buildSnapshot({ generation: 8, editor });
    for (const spec of SIGNAL_CATALOG) expect(spec.collect(snap).id).toBe(spec.id);
  });
});
