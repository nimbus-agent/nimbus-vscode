import { describe, expect, test } from "vitest";

import { isWithinRoot, toAbsolute, toRepoRelative } from "../../src/chat/attachment-paths.js";

const ROOT = "C:/repo";

describe("toAbsolute / toRepoRelative", () => {
  test.each(["a.ts", "src/a.ts", "nested/dir/file.ts"])(
    "round-trips a normal repo-relative path (%s)",
    (p) => {
      expect(toRepoRelative(ROOT, toAbsolute(ROOT, p))).toBe(p);
    },
  );

  test("passes a path through unchanged with no workspace root", () => {
    expect(toAbsolute(undefined, "a.ts")).toBe("a.ts");
    expect(toRepoRelative(undefined, "a.ts")).toBe("a.ts");
  });

  test("normalizes backslashes when stripping the root", () => {
    expect(toRepoRelative("C:\\repo", "C:\\repo\\src\\a.ts")).toBe("src/a.ts");
  });
});

describe("isWithinRoot", () => {
  test("accepts a path that resolves inside the root", () => {
    expect(isWithinRoot(ROOT, toAbsolute(ROOT, "src/a.ts"))).toBe(true);
  });

  test("accepts the root itself", () => {
    expect(isWithinRoot(ROOT, ROOT)).toBe(true);
  });

  test("rejects a path that escapes the root via ..", () => {
    const escaping = toAbsolute(ROOT, "../../etc/passwd");
    expect(isWithinRoot(ROOT, escaping)).toBe(false);
  });

  test("rejects a sibling directory that merely shares the root as a string prefix", () => {
    // "C:/repository" starts with "C:/repo" as a STRING, but is not inside it.
    expect(isWithinRoot(ROOT, "C:/repository/secret.txt")).toBe(false);
  });

  test("treats everything as within when no workspace root is open", () => {
    expect(isWithinRoot(undefined, "/anything/at/all")).toBe(true);
  });
});
