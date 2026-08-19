import { describe, expect, test } from "vitest";

import { isWithinRoot, toAbsolute, toRepoRelative } from "../../src/chat/attachment-paths.js";

const ROOT = "C:/repo";
const BACKSLASH_ROOT = "C:\\repo";

describe("toAbsolute / toRepoRelative", () => {
  test.each(["a.ts", "src/a.ts", "nested/dir/file.ts"])(
    "round-trips a normal repo-relative path (%s)",
    (p) => {
      expect(toRepoRelative(ROOT, toAbsolute(ROOT, p))).toBe(p);
    },
  );

  test.each(["a.ts", "src/a.ts", "nested/dir/file.ts"])(
    "round-trips with a backslash-style root too (%s)",
    (p) => {
      expect(toRepoRelative(BACKSLASH_ROOT, toAbsolute(BACKSLASH_ROOT, p))).toBe(p);
    },
  );

  test("passes a path through unchanged with no workspace root", () => {
    expect(toAbsolute(undefined, "a.ts")).toBe("a.ts");
    expect(toRepoRelative(undefined, "a.ts")).toBe("a.ts");
  });

  test("normalizes backslashes when stripping the root", () => {
    expect(toRepoRelative("C:\\repo", "C:\\repo\\src\\a.ts")).toBe("src/a.ts");
  });

  // Regression coverage for a real bug: an earlier version of toRepoRelative
  // guarded with a bare `fsPath.startsWith(root)`, with no separator check.
  // "C:/repository/x.ts" starts with "C:/repo" as a STRING (a prefix
  // SIBLING, not a path inside it), so that guard sliced mid-segment and
  // returned the nonsense "sitory/x.ts" — the brief's own silent-failure
  // warning made real: it never throws, it just misses the cache and reports
  // a perfectly readable file as unreadable. Verified against the pre-fix
  // code (bare `startsWith`) that both of these fail before the fix, i.e.
  // they'd return "sitory/x.ts" / "sitory\\x.ts" respectively.
  test("does not slice mid-segment on a prefix-sibling directory (forward slash)", () => {
    const fsPath = "C:/repository/x.ts";
    expect(toRepoRelative(ROOT, fsPath)).toBe(fsPath);
  });

  test("does not slice mid-segment on a prefix-sibling directory (backslash)", () => {
    const fsPath = "C:\\repository\\x.ts";
    expect(toRepoRelative(BACKSLASH_ROOT, fsPath)).toBe(fsPath);
  });

  // Windows drive letters are case-insensitive on the real filesystem, but
  // neither node:path nor these string-based helpers normalize case — so a
  // case-different drive letter is treated as OUTSIDE the root. This is the
  // safe direction to be wrong in: a legitimately-inside file degrades to
  // "unreadable · not sent" (via isWithinRoot rejecting it downstream, or
  // toRepoRelative here leaving the path untouched), never the reverse
  // (nothing that is actually outside is ever accepted as inside).
  test("a drive-letter case mismatch is left untouched rather than matched", () => {
    const fsPath = "c:/repo/x.ts";
    expect(toRepoRelative(ROOT, fsPath)).toBe(fsPath);
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

  // Pinning the same case-sensitivity fact from the drive-letter's mirror
  // angle: isWithinRoot is what actually decides whether cacheFile ever
  // calls openTextDocument, and it degrades a case-different drive letter to
  // "not within" (refused, "unreadable · not sent") rather than treating it
  // as an escape past a validated boundary. Fails safe, not case-insensitively
  // equal to a real Windows filesystem.
  test("a drive-letter case mismatch degrades to not-within, never to a false accept", () => {
    expect(isWithinRoot(ROOT, "c:/repo/x.ts")).toBe(false);
  });
});
