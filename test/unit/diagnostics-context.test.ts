import { describe, expect, test } from "vitest";

import {
  buildDiagnosticContext,
  type DiagnosticLike,
  lineStartOffsets,
} from "../../src/diagnostics/context.js";

const lines = (n: number): string => Array.from({ length: n }, (_, i) => `line ${i}`).join("\n");

const at = (line: number): DiagnosticLike => ({
  message: "boom",
  severity: 0,
  source: "ts",
  code: 2345,
  range: { start: { line, character: 2 }, end: { line, character: 6 } },
});

const build = (fullText: string, diagnostic: DiagnosticLike) =>
  buildDiagnosticContext({
    fullText,
    fileName: "/home/dev/repo/src/a.ts",
    languageId: "typescript",
    diagnostic,
  });

describe("lineStartOffsets", () => {
  test("gives the offset each line starts at, CRLF included", () => {
    expect(lineStartOffsets("ab\ncd")).toEqual([0, 3]);
    expect(lineStartOffsets("ab\r\ncd")).toEqual([0, 4]);
  });
});

describe("buildDiagnosticContext", () => {
  test("takes 20 lines either side of the diagnostic", () => {
    const ctx = build(lines(200), at(100));
    expect(ctx.snippet.split("\n")).toHaveLength(41);
    expect(ctx.snippet.startsWith("line 80")).toBe(true);
    expect(ctx.snippet.endsWith("line 120")).toBe(true);
  });

  test("clamps at the start of the file without padding", () => {
    const ctx = build(lines(200), at(3));
    expect(ctx.snippet.startsWith("line 0")).toBe(true);
    expect(ctx.snippet.split("\n")).toHaveLength(24);
  });

  test("clamps at the end of the file without padding", () => {
    const ctx = build(lines(30), at(28));
    expect(ctx.snippet.endsWith("line 29")).toBe(true);
  });

  test("redacts the path to a basename — never the directory", () => {
    expect(build(lines(5), at(1)).fileName).toBe("a.ts");
  });

  test("reports 1-based display lines, because editors count from 1", () => {
    const ctx = build(lines(30), at(9));
    expect(ctx.startLine).toBe(10);
    expect(ctx.endLine).toBe(10);
  });

  test("expands the splice offsets to whole lines, ignoring the characters", () => {
    // at(2) is characters 2-6 of line 2, but the splice must cover the WHOLE
    // line, because buildFixPrompt asks the model to replace whole lines.
    // "line 0\n" + "line 1\n" is 14 chars, so line 2 starts at 14 — not 16, the
    // character-exact start — and ends at 20, the offset of its own "\n".
    const ctx = build(lines(30), at(2));
    expect(ctx.offsets).toEqual({ start: 14, end: 20 });
  });

  test("ends the splice at the document end on the last line, which has no newline", () => {
    // lines(3) is "line 0\nline 1\nline 2" — 20 chars, no trailing newline.
    const ctx = build(lines(3), at(2));
    expect(ctx.offsets).toEqual({ start: 14, end: 20 });
  });

  test("covers every line a multi-line diagnostic spans", () => {
    const ctx = build(lines(30), {
      ...at(1),
      range: { start: { line: 1, character: 4 }, end: { line: 3, character: 1 } },
    });
    // Line 1 starts at 7; line 3 ends at its "\n", offset 27.
    expect(ctx.offsets).toEqual({ start: 7, end: 27 });
  });

  test("labels severity, mapping VS Code's numbering", () => {
    expect(build(lines(5), { ...at(1), severity: 0 }).severityLabel).toBe("error");
    expect(build(lines(5), { ...at(1), severity: 1 }).severityLabel).toBe("warning");
  });

  test("normalizes a missing source and code to empty strings", () => {
    const diagnostic: DiagnosticLike = {
      message: "boom",
      severity: 0,
      range: { start: { line: 1, character: 2 }, end: { line: 1, character: 6 } },
    };
    const ctx = build(lines(5), diagnostic);
    expect(ctx.source).toBe("");
    expect(ctx.code).toBe("");
  });

  test("truncates a minified file where twenty lines is the whole bundle", () => {
    const ctx = build("x".repeat(60_000), {
      ...at(0),
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } },
    });
    expect(ctx.truncated).toBe(true);
    expect(ctx.snippet.length).toBe(50_000);
  });

  test("does not flag truncation for an ordinary file", () => {
    expect(build(lines(200), at(100)).truncated).toBe(false);
  });
});
