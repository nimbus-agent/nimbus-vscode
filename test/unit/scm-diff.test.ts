import { describe, expect, test } from "vitest";

import {
  hasHunks,
  isDeprioritizedPath,
  isSecretPath,
  orderFiles,
  renderDiffBlock,
  SCM_MAX_DIFF_CHARS,
  SCM_MAX_FILES,
  selectWithinBudget,
  truncateAtHunkBoundary,
} from "../../src/scm/diff.js";

const changed = (path: string) => ({ path, status: "modified" });

// A diff with `n` hunks, each roughly `size` chars.
function fakeDiff(path: string, hunks: number, size: number): string {
  const head = `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n`;
  const body = Array.from(
    { length: hunks },
    (_, i) => `@@ -${i + 1},1 +${i + 1},1 @@\n+${"x".repeat(size)}\n`,
  ).join("");
  return head + body;
}

describe("path classification", () => {
  test("flags secret-bearing paths", () => {
    for (const p of [
      ".env",
      ".env.local",
      "config/.env.production",
      "certs/a.pem",
      "a.key",
      "id_rsa",
      "id_rsa.pub",
      "c.p12",
      "d.pfx",
    ]) {
      expect(isSecretPath(p)).toBe(true);
    }
  });
  test("does not flag ordinary source files", () => {
    for (const p of ["src/env.ts", "src/keyboard.ts", "docs/environment.md", "src/a.pem.ts"]) {
      expect(isSecretPath(p)).toBe(false);
    }
  });

  // Regression coverage for a real bug: on Windows, a secret file living
  // OUTSIDE the workspace root (or attached with no workspace open at all)
  // reaches this check via `toRepoRelative`'s pass-through, unnormalized —
  // backslashes and all. Every pattern above anchors position on a forward
  // slash, so a bare `isSecretPath` missed the BACKSLASH form before the fix.
  // Verified against the pre-fix code (`SECRET_PATTERNS.some((re) =>
  // re.test(path))`, no normalization, no basename fallback): only the
  // backslash case returned false there — that is the one that let a secret
  // through. The forward-slash and repo-relative cases already passed, and
  // are kept as the regression fence around them.
  test("flags a secret file behind a backslash absolute path (Windows, outside the workspace)", () => {
    expect(isSecretPath("C:\\Users\\me\\keys\\.env")).toBe(true);
  });

  test("flags a secret file behind a forward-slash absolute path (outside the workspace)", () => {
    expect(isSecretPath("/Users/me/keys/.env")).toBe(true);
  });

  test("flags a secret file inside the workspace, repo-relative", () => {
    expect(isSecretPath("keys/.env")).toBe(true);
  });
  test("flags lockfiles and generated artifacts as deprioritized", () => {
    for (const p of [
      "package-lock.json",
      "bun.lockb",
      "yarn.lock",
      "pnpm-lock.yaml",
      "Cargo.lock",
      "poetry.lock",
      "dist/a.min.js",
      "test/__snapshots__/a.snap",
    ]) {
      expect(isDeprioritizedPath(p)).toBe(true);
    }
  });
});

describe("orderFiles", () => {
  test("skips secret files and reports them when skipSecrets is on", () => {
    const r = orderFiles([changed("src/a.ts"), changed(".env")], { skipSecrets: true });
    expect(r.ordered.map((f) => f.path)).toEqual(["src/a.ts"]);
    expect(r.omitted).toEqual([{ path: ".env", reason: "secret" }]);
  });
  test("keeps secret files when skipSecrets is off", () => {
    const r = orderFiles([changed("src/a.ts"), changed(".env")], { skipSecrets: false });
    expect(r.ordered.map((f) => f.path)).toEqual(["src/a.ts", ".env"]);
    expect(r.omitted).toEqual([]);
  });
  test("puts deprioritized files last but keeps relative order within each group", () => {
    const r = orderFiles(
      [changed("bun.lockb"), changed("src/a.ts"), changed("yarn.lock"), changed("src/b.ts")],
      { skipSecrets: true },
    );
    expect(r.ordered.map((f) => f.path)).toEqual([
      "src/a.ts",
      "src/b.ts",
      "bun.lockb",
      "yarn.lock",
    ]);
  });
  test("caps the file count and reports the overflow", () => {
    const files = Array.from({ length: SCM_MAX_FILES + 3 }, (_, i) => changed(`src/f${i}.ts`));
    const r = orderFiles(files, { skipSecrets: true });
    expect(r.ordered).toHaveLength(SCM_MAX_FILES);
    expect(r.omitted).toHaveLength(3);
    expect(r.omitted.every((o) => o.reason === "file-cap")).toBe(true);
  });
});

describe("hasHunks", () => {
  test("is true for a normal text diff", () => {
    expect(hasHunks(fakeDiff("a.ts", 1, 10))).toBe(true);
  });
  test("is false for a binary diff and a pure rename", () => {
    expect(hasHunks("diff --git a/a.png b/a.png\nBinary files differ\n")).toBe(false);
    expect(hasHunks("diff --git a/a.ts b/b.ts\nrename from a.ts\nrename to b.ts\n")).toBe(false);
  });
});

describe("truncateAtHunkBoundary", () => {
  test("returns the whole diff when it already fits", () => {
    const d = fakeDiff("a.ts", 2, 10);
    const r = truncateAtHunkBoundary(d, 10_000);
    expect(r).toEqual({ text: d, keptHunks: 2, totalHunks: 2 });
  });
  test("keeps only whole hunks that fit, never a partial one", () => {
    const d = fakeDiff("a.ts", 3, 100);
    const r = truncateAtHunkBoundary(d, 300);
    if (r === undefined) throw new Error("expected a hunk-truncated result");
    expect(r.keptHunks).toBeLessThan(3);
    expect(r.totalHunks).toBe(3);
    // Every retained hunk is complete: the text ends on a newline and contains
    // exactly keptHunks hunk headers.
    expect(r.text.match(/^@@ /gm) ?? []).toHaveLength(r.keptHunks);
    expect(r.text.endsWith("\n")).toBe(true);
  });
  test("returns undefined when not even the first hunk fits", () => {
    expect(truncateAtHunkBoundary(fakeDiff("a.ts", 2, 5_000), 200)).toBeUndefined();
  });
  test("returns undefined for a diff with no hunks (binary file)", () => {
    const binary = "diff --git a/a.png b/a.png\nBinary files a/a.png and b/a.png differ\n";
    expect(truncateAtHunkBoundary(binary, 10)).toBeUndefined();
  });
  test("handles CRLF hunk headers", () => {
    const d = "diff --git a/a.ts b/a.ts\r\n@@ -1,1 +1,1 @@\r\n+a\r\n@@ -2,1 +2,1 @@\r\n+b\r\n";
    expect(truncateAtHunkBoundary(d, 10_000)?.totalHunks).toBe(2);
  });
});

describe("selectWithinBudget", () => {
  test("takes whole files while they fit", () => {
    const entries = [
      { path: "a.ts", diff: fakeDiff("a.ts", 1, 50) },
      { path: "b.ts", diff: fakeDiff("b.ts", 1, 50) },
    ];
    const r = selectWithinBudget(entries, 10_000);
    expect(r.files.map((f) => f.path)).toEqual(["a.ts", "b.ts"]);
    expect(r.omitted).toEqual([]);
  });
  test("drops whole files that do not fit and reports them", () => {
    const entries = [
      { path: "a.ts", diff: fakeDiff("a.ts", 1, 100) },
      { path: "big.ts", diff: fakeDiff("big.ts", 1, 5_000) },
      { path: "c.ts", diff: fakeDiff("c.ts", 1, 50) },
    ];
    const r = selectWithinBudget(entries, 600);
    expect(r.files.map((f) => f.path)).toEqual(["a.ts", "c.ts"]);
    expect(r.omitted).toEqual([{ path: "big.ts", reason: "too-large" }]);
  });
  test("truncates the first file at a hunk boundary when nothing else fits", () => {
    const r = selectWithinBudget([{ path: "big.ts", diff: fakeDiff("big.ts", 4, 200) }], 600);
    expect(r.files).toHaveLength(1);
    expect(r.files[0]?.truncated).toBeDefined();
    expect(r.files[0]?.truncated?.total).toBe(4);
    expect(r.files[0]?.truncated?.kept).toBeLessThan(4);
    expect(r.omitted).toEqual([]);
  });
  test("drops the first file entirely when even its first hunk is too big", () => {
    const r = selectWithinBudget([{ path: "big.ts", diff: fakeDiff("big.ts", 2, 5_000) }], 300);
    expect(r.files).toEqual([]);
    expect(r.omitted).toEqual([{ path: "big.ts", reason: "too-large" }]);
  });
  test("omits a small binary file as non-textual, not as too-large", () => {
    const binary = "diff --git a/a.png b/a.png\nBinary files a/a.png and b/a.png differ\n";
    const r = selectWithinBudget([{ path: "a.png", diff: binary }], 10_000);
    expect(r.files).toEqual([]);
    expect(r.omitted).toEqual([{ path: "a.png", reason: "non-textual" }]);
  });
  test("omits a pure rename as non-textual", () => {
    const rename =
      "diff --git a/a.ts b/b.ts\nsimilarity index 100%\nrename from a.ts\nrename to b.ts\n";
    const r = selectWithinBudget([{ path: "b.ts", diff: rename }], 10_000);
    expect(r.omitted).toEqual([{ path: "b.ts", reason: "non-textual" }]);
  });
  test("a non-textual file does not consume the first-file truncation fallback", () => {
    const binary = "diff --git a/a.png b/a.png\nBinary files a/a.png and b/a.png differ\n";
    const r = selectWithinBudget(
      [
        { path: "a.png", diff: binary },
        { path: "big.ts", diff: fakeDiff("big.ts", 4, 200) },
      ],
      600,
    );
    expect(r.files.map((f) => f.path)).toEqual(["big.ts"]);
    expect(r.files[0]?.truncated?.total).toBe(4);
  });
  test("never emits a partial hunk", () => {
    const r = selectWithinBudget([{ path: "big.ts", diff: fakeDiff("big.ts", 5, 200) }], 700);
    const text = r.files[0]?.diff ?? "";
    const openers = (text.match(/^@@ /gm) ?? []).length;
    expect(openers).toBe(r.files[0]?.truncated?.kept);
  });
});

describe("renderDiffBlock", () => {
  test("fences each file under a repo-relative header", () => {
    const out = renderDiffBlock([{ path: "src/a.ts", diff: "@@ -1 +1 @@\n+a\n" }]);
    expect(out).toContain("File: src/a.ts");
    expect(out).toContain("```diff");
    expect(out).toContain("+a");
  });
  test("marks a truncated file honestly", () => {
    const out = renderDiffBlock([
      { path: "src/a.ts", diff: "@@ -1 +1 @@\n+a\n", truncated: { kept: 1, total: 4 } },
    ]);
    expect(out).toContain("File: src/a.ts (truncated — 1 of 4 hunks)");
  });
});

describe("constants", () => {
  test("the diff budget matches the quick-ask context cap", () => {
    expect(SCM_MAX_DIFF_CHARS).toBe(50_000);
  });
  test("the file cap is 100", () => {
    expect(SCM_MAX_FILES).toBe(100);
  });
});
