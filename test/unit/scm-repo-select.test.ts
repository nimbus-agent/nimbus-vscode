import { describe, expect, test } from "vitest";

import type { GitRepositoryLike } from "../../src/scm/git-types.js";
import { classifyRepositories, findRepoByRoot, repoLabel } from "../../src/scm/repo-select.js";

function fakeRepo(rootPath: string): GitRepositoryLike {
  return {
    rootPath,
    changedFiles: async () => [],
    fileDiff: async () => "",
    untrackedPaths: async () => [],
    log: async () => [],
    inputBox: { value: "" },
    branch: () => "main",
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
