import { describe, expect, test } from "vitest";

import {
  droppedRoots,
  findLeakedRoots,
  MIN_NEEDLE_LENGTH,
  pathVariants,
} from "../../src/egress/leak-check.js";

describe("pathVariants", () => {
  test("yields both separator forms of a Windows root", () => {
    expect(pathVariants("C:\\gitrep\\nimbus")).toEqual(["C:\\gitrep\\nimbus", "C:/gitrep/nimbus"]);
  });
  test("yields both separator forms of a POSIX root", () => {
    expect(pathVariants("/home/asafg/p")).toEqual(["/home/asafg/p", "\\home\\asafg\\p"]);
  });
  test("collapses to one variant when there is no separator", () => {
    expect(pathVariants("plainword")).toEqual(["plainword"]);
  });
});

describe("findLeakedRoots", () => {
  const WIN = "C:\\gitrep\\nimbus";
  const HOME = "/home/asafg";

  test("returns nothing for a clean payload", () => {
    expect(findLeakedRoots("just a diff of a.ts", [WIN, HOME])).toEqual([]);
  });
  test("finds a root that appears verbatim", () => {
    expect(findLeakedRoots(`see ${WIN}\\src\\a.ts`, [WIN])).toEqual([WIN]);
  });
  test("finds a Windows root written with forward slashes", () => {
    expect(findLeakedRoots("see C:/gitrep/nimbus/src/a.ts", [WIN])).toEqual([WIN]);
  });
  test("matches case-insensitively, since Windows paths are", () => {
    expect(findLeakedRoots("see c:\\GITREP\\Nimbus\\a.ts", [WIN])).toEqual([WIN]);
  });
  test("reports each matching root once, in the order given", () => {
    expect(findLeakedRoots(`${WIN} and ${HOME} and ${WIN}`, [WIN, HOME])).toEqual([WIN, HOME]);
  });
  test("ignores roots shorter than the minimum needle length", () => {
    // This is why the length threshold, not the call site, decides whether
    // os.tmpdir() is usable: "/tmp" is 4 characters and appears legitimately
    // in shebangs, fixtures and docs.
    expect(MIN_NEEDLE_LENGTH).toBe(5);
    expect(findLeakedRoots("#!/bin/sh\ncd /tmp && ./run", ["/tmp"])).toEqual([]);
  });
  test("ignores empty and whitespace-only roots", () => {
    expect(findLeakedRoots("anything at all", ["", "   "])).toEqual([]);
  });
  test("a 5-character root is long enough to be a needle", () => {
    // "/root" is homedir() for the root user on Linux. Worth checking
    // explicitly: it sits exactly on the threshold.
    expect("/root".length).toBe(MIN_NEEDLE_LENGTH);
    expect(findLeakedRoots("wrote /root/svc.log", ["/root"])).toEqual(["/root"]);
  });
});

describe("droppedRoots", () => {
  test("names the roots that are too short to search for", () => {
    expect(droppedRoots(["/tmp", "/", "C:\\gitrep\\nimbus"])).toEqual(["/tmp", "/"]);
  });

  test("is empty when every root is usable", () => {
    expect(droppedRoots(["/home/asafg", "C:\\gitrep\\nimbus"])).toEqual([]);
  });
});
