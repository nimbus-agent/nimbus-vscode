import { describe, expect, test } from "vitest";

import {
  buildReviewDocument,
  buildReviewPrompt,
  type ReviewCoverage,
} from "../../src/scm/review.js";

const coverage = (over: Partial<ReviewCoverage> = {}): ReviewCoverage => ({
  repoLabel: "nimbus-vscode",
  reviewed: ["src/a.ts"],
  omittedTooLarge: [],
  skippedSecret: [],
  nonTextual: [],
  untracked: [],
  ...over,
});

describe("buildReviewPrompt", () => {
  test("includes the diff", () => {
    expect(buildReviewPrompt("File: a.ts\n```diff\n+a\n```")).toContain("+a");
  });
  test("asks for a fixed shape: summary then findings by file with severity", () => {
    const p = buildReviewPrompt("d");
    expect(p).toContain("summary");
    expect(p).toContain("grouped by file");
    expect(p).toContain("severity");
  });
});

describe("buildReviewDocument", () => {
  test("names the repo and the reviewed files", () => {
    const doc = buildReviewDocument(coverage(), "No issues found.");
    expect(doc).toContain("nimbus-vscode");
    expect(doc).toContain("src/a.ts");
    expect(doc).toContain("No issues found.");
  });
  test("names untracked files so they are never mistaken for reviewed", () => {
    const doc = buildReviewDocument(coverage({ untracked: ["src/new.ts"] }), "f");
    expect(doc).toContain("Not reviewed — untracked");
    expect(doc).toContain("src/new.ts");
  });
  test("names files skipped as secret-bearing", () => {
    const doc = buildReviewDocument(coverage({ skippedSecret: [".env"] }), "f");
    expect(doc).toContain("Not reviewed — possible secrets");
    expect(doc).toContain(".env");
  });
  test("names files omitted for size", () => {
    const doc = buildReviewDocument(coverage({ omittedTooLarge: ["big.ts"] }), "f");
    expect(doc).toContain("Not reviewed — too large");
    expect(doc).toContain("big.ts");
  });
  test("names binary and non-textual changes distinctly from too-large ones", () => {
    const doc = buildReviewDocument(coverage({ nonTextual: ["logo.png"] }), "f");
    expect(doc).toContain("Not reviewed — binary or non-textual changes");
    expect(doc).toContain("logo.png");
    expect(doc).not.toContain("too large");
  });
  test("omits each not-reviewed section entirely when it is empty", () => {
    const doc = buildReviewDocument(coverage(), "f");
    expect(doc).not.toContain("Not reviewed");
  });
  test("puts the findings after the header", () => {
    const doc = buildReviewDocument(coverage(), "FINDINGS-MARKER");
    expect(doc.indexOf("nimbus-vscode")).toBeLessThan(doc.indexOf("FINDINGS-MARKER"));
  });

  test("shows the _nothing_ placeholder when zero files were reviewed", () => {
    const doc = buildReviewDocument(coverage({ reviewed: [] }), "f");
    expect(doc).toContain("**Reviewed (0 files):** _nothing_");
  });

  test("pluralizes the count for 2+ reviewed files", () => {
    const doc = buildReviewDocument(coverage({ reviewed: ["src/a.ts", "src/b.ts"] }), "f");
    expect(doc).toContain("Reviewed (2 files):");
    expect(doc).toContain("`src/a.ts`");
    expect(doc).toContain("`src/b.ts`");
  });

  test("renders several populated not-reviewed sections at once, each with its own files", () => {
    const doc = buildReviewDocument(
      coverage({
        omittedTooLarge: ["big.ts"],
        skippedSecret: [".env"],
        nonTextual: ["logo.png"],
        untracked: ["src/new.ts"],
      }),
      "f",
    );
    expect(doc).toContain("Not reviewed — too large");
    expect(doc).toContain("big.ts");
    expect(doc).toContain("Not reviewed — possible secrets");
    expect(doc).toContain(".env");
    expect(doc).toContain("Not reviewed — binary or non-textual changes");
    expect(doc).toContain("logo.png");
    expect(doc).toContain("Not reviewed — untracked");
    expect(doc).toContain("src/new.ts");
    // Order matches buildReviewDocument's own section order.
    expect(doc.indexOf("too large")).toBeLessThan(doc.indexOf("possible secrets"));
    expect(doc.indexOf("possible secrets")).toBeLessThan(doc.indexOf("binary or non-textual"));
    expect(doc.indexOf("binary or non-textual")).toBeLessThan(doc.indexOf("untracked"));
  });
});
