import { describe, expect, test } from "vitest";

import { buildSnapshot, SELECTION_MAX_CHARS } from "../../src/context/snapshot.js";

const editor = {
  path: "src/a.ts",
  scheme: "file",
  languageId: "typescript",
  line: 41,
  selection: "",
  isDirty: false,
};

describe("buildSnapshot", () => {
  test("carries the editor fields through for a file-scheme editor", () => {
    const snap = buildSnapshot({ generation: 1, editor });
    expect(snap.generation).toBe(1);
    expect(snap.path).toBe("src/a.ts");
    expect(snap.languageId).toBe("typescript");
    expect(snap.line).toBe(41);
    expect(snap.selection).toBeUndefined();
    expect(snap.isDirty).toBe(false);
    expect(snap.diagnostics).toEqual([]);
  });

  test("treats a non-file editor as no editor at all", () => {
    const snap = buildSnapshot({
      generation: 2,
      editor: { ...editor, scheme: "untitled", selection: "x", isDirty: true },
    });
    expect(snap.path).toBeUndefined();
    expect(snap.languageId).toBeUndefined();
    expect(snap.line).toBeUndefined();
    expect(snap.selection).toBeUndefined();
    expect(snap.isDirty).toBe(false);
  });

  test("clamps a long selection to the index-query limit, on a word boundary", () => {
    const snap = buildSnapshot({
      generation: 3,
      editor: { ...editor, selection: "alpha ".repeat(200) },
    });
    const selection = snap.selection ?? "";
    expect(selection.length).toBeLessThanOrEqual(SELECTION_MAX_CHARS);
    expect(selection.endsWith("alpha")).toBe(true);
  });

  test("treats a whitespace-only selection as no selection", () => {
    const snap = buildSnapshot({ generation: 4, editor: { ...editor, selection: "   \n\t" } });
    expect(snap.selection).toBeUndefined();
  });

  test("reports unsaved edits so the panel can mark them", () => {
    const snap = buildSnapshot({ generation: 5, editor: { ...editor, isDirty: true } });
    expect(snap.isDirty).toBe(true);
  });

  test("carries the repo-relative path through separately from the workspace-relative one", () => {
    const snap = buildSnapshot({
      generation: 7,
      editor: { ...editor, repoPath: "packages/service-a/src/a.ts" },
    });
    expect(snap.path).toBe("src/a.ts");
    expect(snap.repoPath).toBe("packages/service-a/src/a.ts");
  });

  test("leaves repoPath undefined when no repository contains the file", () => {
    const snap = buildSnapshot({ generation: 8, editor });
    expect(snap.repoPath).toBeUndefined();
  });

  test("keeps the git summary and diagnostics it is handed", () => {
    const snap = buildSnapshot({
      generation: 6,
      editor,
      git: { branch: "main", changedPaths: ["src/a.ts"] },
      diagnostics: [{ message: "boom", severity: 0, line: 3 }],
    });
    expect(snap.git).toEqual({ branch: "main", changedPaths: ["src/a.ts"] });
    expect(snap.diagnostics).toHaveLength(1);
  });
});
