import { describe, expect, test } from "vitest";

import { relativeOrBasename } from "../../src/scm/paths.js";

describe("relativeOrBasename", () => {
  test("happy path: POSIX file under a POSIX root", () => {
    expect(relativeOrBasename("/home/dev/proj", "/home/dev/proj/src/a.ts")).toBe("src/a.ts");
  });

  test("happy path: Windows file under a Windows root", () => {
    expect(relativeOrBasename("C:\\repo", "C:\\repo\\src\\a.ts")).toBe("src/a.ts");
  });

  test("a trailing separator on the root does not break the match", () => {
    expect(relativeOrBasename("C:\\repo\\", "C:\\repo\\src\\a.ts")).toBe("src/a.ts");
    expect(relativeOrBasename("/home/dev/proj/", "/home/dev/proj/src/a.ts")).toBe("src/a.ts");
  });

  test("drive-letter case mismatch is still recognized as inside the root", () => {
    expect(relativeOrBasename("C:\\repo", "C:\\REPO\\src\\a.ts")).toBe("src/a.ts");
  });

  test("a sibling directory that merely shares a prefix falls back to the basename", () => {
    // C:\repo is a string-prefix of C:\repository\... but not a path-ancestor of it.
    expect(relativeOrBasename("C:\\repo", "C:\\repository\\x.ts")).toBe("x.ts");
  });

  test("a path entirely outside the root falls back to the basename, never the raw path", () => {
    expect(relativeOrBasename("/r", "/elsewhere/a.ts")).toBe("a.ts");
  });

  test("never returns the raw absolute path on any mismatch", () => {
    const result = relativeOrBasename("/r", "/elsewhere/a.ts");
    expect(result).not.toContain("/elsewhere");
    expect(result).not.toMatch(/^[A-Za-z]:/);
  });

  test("a path equal to the root does not leak the absolute value", () => {
    const result = relativeOrBasename("C:\\repo", "C:\\repo");
    expect(result).not.toBe("C:\\repo");
    expect(result.includes("\\")).toBe(false);
  });

  test("POSIX case sensitivity is preserved (not treated as Windows-style)", () => {
    // A POSIX root has no drive letter, so a case-differing POSIX path is a
    // genuine mismatch, not a match — falls back to the basename.
    expect(relativeOrBasename("/home/dev/Proj", "/home/dev/proj/src/a.ts")).toBe("a.ts");
  });
});
