import { describe, expect, test } from "vitest";

import type { GitRepositoryLike } from "../../src/scm/git-types.js";
import {
  classifyRepositories,
  findRepoByRoot,
  repoContaining,
  repoLabel,
} from "../../src/scm/repo-select.js";

function fakeRepo(rootPath: string): GitRepositoryLike {
  return {
    rootPath,
    changedFiles: async () => [],
    changedPathsNow: () => [],
    fileDiff: async () => "",
    untrackedPaths: async () => [],
    log: async () => [],
    inputBox: { value: "" },
    branch: () => "main",
    onDidChange: () => ({ dispose: () => undefined }),
  };
}

describe("classifyRepositories", () => {
  test("reports none for an empty list", () => {
    expect(classifyRepositories([])).toEqual({ kind: "none" });
  });
  test("reports the single repo directly", () => {
    const repo = fakeRepo("/home/dev/proj");
    expect(classifyRepositories([repo])).toEqual({ kind: "one", repo });
  });
  test("reports many so the caller can prompt", () => {
    const a = fakeRepo("/home/dev/a");
    const b = fakeRepo("/home/dev/b");
    expect(classifyRepositories([a, b])).toEqual({ kind: "many", repos: [a, b] });
  });
});

describe("repoLabel", () => {
  test("is the basename, never the absolute path", () => {
    expect(repoLabel(fakeRepo("/home/dev/nimbus-vscode"))).toBe("nimbus-vscode");
    expect(repoLabel(fakeRepo("C:\\gitrep\\nimbus-vscode"))).toBe("nimbus-vscode");
  });
  test("ignores a trailing separator", () => {
    expect(repoLabel(fakeRepo("/home/dev/proj/"))).toBe("proj");
    expect(repoLabel(fakeRepo("C:\\gitrep\\proj\\"))).toBe("proj");
  });
  test("falls back to the raw root when there is no separator", () => {
    expect(repoLabel(fakeRepo("proj"))).toBe("proj");
  });
});

describe("findRepoByRoot", () => {
  test("finds a still-open repository", () => {
    const a = fakeRepo("/a");
    const b = fakeRepo("/b");
    expect(findRepoByRoot([a, b], "/b")).toBe(b);
  });
  test("returns undefined when the repository closed", () => {
    expect(findRepoByRoot([fakeRepo("/a")], "/b")).toBeUndefined();
  });
});

describe("repoContaining", () => {
  test("chooses the containing repo among several", () => {
    const a = fakeRepo("/home/dev/a");
    const b = fakeRepo("/home/dev/b");
    expect(repoContaining([a, b], "/home/dev/b/src/file.ts")).toBe(b);
  });

  test("the innermost repo wins when one root nests inside another", () => {
    const outer = fakeRepo("/home/dev/proj");
    const inner = fakeRepo("/home/dev/proj/vendor/lib");
    expect(repoContaining([outer, inner], "/home/dev/proj/vendor/lib/src/file.ts")).toBe(inner);
  });

  test("returns undefined when no root matches", () => {
    const a = fakeRepo("/home/dev/a");
    expect(repoContaining([a], "/home/dev/elsewhere/file.ts")).toBeUndefined();
  });

  test("returns the sole repository when fileName is undefined", () => {
    const a = fakeRepo("/home/dev/a");
    expect(repoContaining([a], undefined)).toBe(a);
  });

  test("returns undefined when fileName is undefined and several repos exist", () => {
    const a = fakeRepo("/home/dev/a");
    const b = fakeRepo("/home/dev/b");
    expect(repoContaining([a, b], undefined)).toBeUndefined();
  });
});
