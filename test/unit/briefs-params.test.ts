import { describe, expect, test } from "vitest";

import {
  fileParams,
  janitorParams,
  preflightParams,
  rootFor,
  toOneBased,
  toRelativeRef,
  whyParams,
} from "../../src/briefs/params.js";

describe("toRelativeRef", () => {
  const roots = ["/home/dev/proj"];

  test("strips a matching workspace root", () => {
    expect(toRelativeRef("/home/dev/proj/src/auth/session.ts", roots)).toBe("src/auth/session.ts");
  });

  test("normalises Windows separators so the Gateway sees one shape", () => {
    expect(toRelativeRef("C:\\work\\proj\\src\\a.ts", ["C:\\work\\proj"])).toBe("src/a.ts");
  });

  test("falls back to the basename when no root matches — never an absolute path", () => {
    expect(toRelativeRef("/etc/hosts", roots)).toBe("hosts");
    expect(toRelativeRef("C:\\Users\\dev\\notes.md", roots)).toBe("notes.md");
  });

  test("picks the longest matching root, so a nested folder wins", () => {
    expect(
      toRelativeRef("/home/dev/proj/pkg/src/a.ts", ["/home/dev/proj", "/home/dev/proj/pkg"]),
    ).toBe("src/a.ts");
  });

  test("never returns a leading separator", () => {
    expect(toRelativeRef("/home/dev/proj/a.ts", roots).startsWith("/")).toBe(false);
  });

  test("an empty root list still yields a basename", () => {
    expect(toRelativeRef("/home/dev/proj/src/a.ts", [])).toBe("a.ts");
  });

  test("matches a root whose drive-letter case differs, as Windows reports it", () => {
    expect(toRelativeRef("c:\\work\\proj\\src\\a.ts", ["C:\\work\\proj"])).toBe("src/a.ts");
    expect(toRelativeRef("C:\\Work\\Proj\\src\\a.ts", ["c:\\work\\proj"])).toBe("src/a.ts");
  });

  test("preserves the real casing of the part it returns", () => {
    expect(toRelativeRef("c:\\work\\proj\\src\\MyFile.ts", ["C:\\work\\proj"])).toBe(
      "src/MyFile.ts",
    );
  });
});

test("rootFor returns the containing root in its original casing", () => {
  expect(rootFor("c:/proj/src/a.ts", ["C:/Proj"])).toBe("C:/Proj");
});

test("rootFor prefers the innermost of nested roots", () => {
  expect(rootFor("/a/b/c/x.ts", ["/a", "/a/b"])).toBe("/a/b");
});

test("rootFor returns undefined when no root contains the file", () => {
  expect(rootFor("/elsewhere/x.ts", ["/a"])).toBeUndefined();
});

test("rootFor does not cross-match differently-cased POSIX roots (case-sensitive filesystem)", () => {
  // "/work/Proj" and "/work/proj" are different directories on a
  // case-sensitive filesystem — a file under one must never match the
  // other's workspace root (that would misdirect toRelativeRef/memoryFolder
  // to the wrong project's namespace).
  expect(rootFor("/work/proj/src/a.ts", ["/work/Proj"])).toBeUndefined();
  expect(rootFor("/work/Proj/src/a.ts", ["/work/proj"])).toBeUndefined();
  expect(rootFor("/work/proj/src/a.ts", ["/work/proj"])).toBe("/work/proj");
});

describe("params", () => {
  test("whyParams converts VS Code's 0-based line to 1-based", () => {
    expect(whyParams({ ref: "src/a.ts", line: 41 })).toEqual({ ref: "src/a.ts", line: 42 });
  });

  test("the first line of a file is line 1, never line 0", () => {
    expect(whyParams({ ref: "src/a.ts", line: 0 }).line).toBe(1);
  });

  test("toOneBased is the single conversion point", () => {
    expect(toOneBased(0)).toBe(1);
    expect(toOneBased(41)).toBe(42);
  });

  test("fileParams carries the file only", () => {
    expect(fileParams({ ref: "src/a.ts", line: 42 })).toEqual({ file: "src/a.ts" });
  });

  test("janitorParams omits idleDays entirely when it was not supplied", () => {
    expect(janitorParams({ resourceRef: "svc/legacy" })).toEqual({ resourceRef: "svc/legacy" });
    expect("idleDays" in janitorParams({ resourceRef: "svc/legacy" })).toBe(false);
  });

  test("janitorParams passes idleDays through when supplied", () => {
    expect(janitorParams({ resourceRef: "svc/legacy", idleDays: 30 })).toEqual({
      resourceRef: "svc/legacy",
      idleDays: 30,
    });
  });

  test("janitorParams leaves a non-file resource ref untouched", () => {
    expect(janitorParams({ resourceRef: "svc/legacy" }).resourceRef).toBe("svc/legacy");
  });

  test("preflightParams carries the ref and namespace verbatim", () => {
    expect(preflightParams({ ref: "release-1.4", namespace: "billing" })).toEqual({
      ref: "release-1.4",
      namespace: "billing",
    });
  });
});
