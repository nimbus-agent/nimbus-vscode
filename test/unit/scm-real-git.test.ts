import { afterEach, describe, expect, test, vi } from "vitest";

import type { Logger } from "../../src/logging.js";
import { createRealGitApi } from "../../src/scm/real-git.js";
import { GIT_STATUS_UNTRACKED } from "../../src/scm/untracked.js";
import { extensions } from "./vscode-stub.js";

// real-git.ts is the one file that touches VS Code's built-in git extension.
// Its API is untyped on our side, so what is worth pinning here is the ADAPTER:
// resolving the API degrades to "git unavailable" instead of throwing, every
// path it hands on is repo-relative (never the absolute root), and each verb
// reads the git extension member it claims to.

function recordingLog(): Logger & { warnings: string[] } {
  const warnings: string[] = [];
  return {
    warnings,
    error: () => undefined,
    warn: (m: string) => warnings.push(m),
    info: () => undefined,
    debug: () => undefined,
  };
}

interface FakeChange {
  uri: { fsPath: string };
  status: number;
}

const ROOT = "/work/repo";
const change = (rel: string, status = 5): FakeChange => ({
  uri: { fsPath: `${ROOT}/${rel}` },
  status,
});

// The structural subset of the git extension's Repository that real-git.ts reads.
function fakeRepository(
  over: {
    head?: { name?: string };
    untrackedChanges?: FakeChange[];
    workingTreeChanges?: FakeChange[];
    indexChanges?: FakeChange[];
  } = {},
) {
  const calls: Array<[string, ...unknown[]]> = [];
  const changeListeners: Array<() => void> = [];
  const repo = {
    rootUri: { fsPath: ROOT },
    inputBox: { value: "" },
    state: {
      ...(over.head === undefined ? {} : { HEAD: over.head }),
      ...(over.untrackedChanges === undefined ? {} : { untrackedChanges: over.untrackedChanges }),
      ...(over.workingTreeChanges === undefined
        ? {}
        : { workingTreeChanges: over.workingTreeChanges }),
      ...(over.indexChanges === undefined ? {} : { indexChanges: over.indexChanges }),
      onDidChange: (listener: () => void) => {
        changeListeners.push(listener);
        return { dispose: () => undefined };
      },
    },
    diffIndexWithHEAD: async (path?: string): Promise<unknown> => {
      calls.push(["diffIndexWithHEAD", path]);
      return path === undefined ? [change("src/staged.ts", 0)] : `index diff of ${path}`;
    },
    diffWithHEAD: async (path?: string): Promise<unknown> => {
      calls.push(["diffWithHEAD", path]);
      return path === undefined ? [change("src/edited.ts", 5)] : `worktree diff of ${path}`;
    },
    log: async (opts: { maxEntries: number }) => {
      calls.push(["log", opts]);
      return [{ message: "feat: newest" }, { message: "fix: older" }];
    },
  };
  return { repo, calls, changeListeners };
}

function fakeApi(repositories: unknown[]) {
  const openListeners: Array<() => void> = [];
  return {
    api: {
      repositories,
      onDidOpenRepository: (listener: () => void) => {
        openListeners.push(listener);
        return { dispose: () => undefined };
      },
    },
    openListeners,
  };
}

// An extension whose exports carry getAPI(1) → `api`, recording how it was called.
function fakeExtension(api: unknown, opts: { active?: boolean } = {}) {
  const getApiCalls: Array<{ self: unknown; version: unknown }> = [];
  const exports = {
    getAPI(this: unknown, version: unknown): unknown {
      getApiCalls.push({ self: this, version });
      return api;
    },
  };
  const activate = vi.fn(async () => exports);
  return {
    ext: {
      isActive: opts.active ?? true,
      exports: opts.active === false ? undefined : exports,
      activate,
    },
    exports,
    activate,
    getApiCalls,
  };
}

function useExtension(ext: unknown): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(extensions, "getExtension").mockReturnValue(ext);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createRealGitApi — resolving the git extension", () => {
  test("no git extension installed resolves to no API, quietly", async () => {
    const getExtension = useExtension(undefined);
    const log = recordingLog();
    expect(await createRealGitApi(log)()).toBeUndefined();
    expect(getExtension).toHaveBeenCalledWith("vscode.git");
    expect(log.warnings).toEqual([]);
  });

  test("an active extension's exports are used as-is, asking for API version 1", async () => {
    const { api } = fakeApi([]);
    const f = fakeExtension(api);
    useExtension(f.ext);
    const resolved = await createRealGitApi(recordingLog())();
    expect(resolved?.repositories()).toEqual([]);
    expect(f.activate).not.toHaveBeenCalled();
    // `this` must be the exports object: getAPI is a method, not a free function.
    expect(f.getApiCalls).toEqual([{ self: f.exports, version: 1 }]);
  });

  test("an inactive extension is activated first, and the activated exports are used", async () => {
    const { api } = fakeApi([]);
    const f = fakeExtension(api, { active: false });
    useExtension(f.ext);
    const resolved = await createRealGitApi(recordingLog())();
    expect(f.activate).toHaveBeenCalledTimes(1);
    expect(resolved).toBeDefined();
    expect(f.getApiCalls).toHaveLength(1);
  });

  test.each([
    ["exports that are not an object", "not-an-object"],
    ["null exports", null],
    ["exports with no getAPI", {}],
    ["a getAPI that is not a function", { getAPI: "1" }],
  ])("%s degrade to no API", async (_label, exports) => {
    useExtension({ isActive: true, exports, activate: async () => exports });
    const log = recordingLog();
    expect(await createRealGitApi(log)()).toBeUndefined();
    expect(log.warnings).toEqual([]);
  });

  test.each([
    ["getAPI returning nothing", undefined],
    ["an API with no repository list", { repositories: "not-a-list" }],
  ])("%s degrades to no API", async (_label, api) => {
    useExtension(fakeExtension(api).ext);
    expect(await createRealGitApi(recordingLog())()).toBeUndefined();
  });

  test("a throwing extension host degrades to no API, and the log says why", async () => {
    vi.spyOn(extensions, "getExtension").mockImplementation(() => {
      throw new Error("extension host restarting");
    });
    const log = recordingLog();
    expect(await createRealGitApi(log)()).toBeUndefined();
    expect(log.warnings).toEqual(["scm: git extension unavailable: extension host restarting"]);
  });

  test("an activation that rejects is reported the same way", async () => {
    useExtension({
      isActive: false,
      exports: undefined,
      activate: async () => {
        throw new Error("git: not found");
      },
    });
    const log = recordingLog();
    expect(await createRealGitApi(log)()).toBeUndefined();
    expect(log.warnings).toEqual(["scm: git extension unavailable: git: not found"]);
  });

  test("onDidOpenRepository forwards to the git extension's own event", async () => {
    const { api, openListeners } = fakeApi([]);
    useExtension(fakeExtension(api).ext);
    const resolved = await createRealGitApi(recordingLog())();
    const listener = vi.fn();
    resolved?.onDidOpenRepository(listener);
    expect(openListeners).toHaveLength(1);
    openListeners[0]?.();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("createRealGitApi — the adapted repository", () => {
  async function adapted(repo: unknown) {
    const { api } = fakeApi([repo]);
    useExtension(fakeExtension(api).ext);
    const resolved = await createRealGitApi(recordingLog())();
    const first = resolved?.repositories()[0];
    if (first === undefined) throw new Error("no repository was adapted");
    return first;
  }

  test("exposes the root, the branch, and the very input box the SCM view shows", async () => {
    const { repo } = fakeRepository({ head: { name: "main" } });
    const r = await adapted(repo);
    expect(r.rootPath).toBe(ROOT);
    expect(r.branch()).toBe("main");
    // The same object, not a copy: writing it is what fills the SCM message box.
    r.inputBox.value = "feat: drafted";
    expect(repo.inputBox.value).toBe("feat: drafted");
  });

  test("a detached HEAD has no branch name", async () => {
    const { repo } = fakeRepository();
    expect((await adapted(repo)).branch()).toBeUndefined();
  });

  test("changedFiles reads the index for staged and the working tree for all, repo-relative", async () => {
    const { repo, calls } = fakeRepository();
    const r = await adapted(repo);
    expect(await r.changedFiles("staged")).toEqual([{ path: "src/staged.ts", status: "0" }]);
    expect(await r.changedFiles("all")).toEqual([{ path: "src/edited.ts", status: "5" }]);
    expect(calls).toEqual([
      ["diffIndexWithHEAD", undefined],
      ["diffWithHEAD", undefined],
    ]);
  });

  test("fileDiff asks for the matching side of the diff, per scope", async () => {
    const { repo, calls } = fakeRepository();
    const r = await adapted(repo);
    expect(await r.fileDiff("staged", "src/a.ts")).toBe("index diff of src/a.ts");
    expect(await r.fileDiff("all", "src/a.ts")).toBe("worktree diff of src/a.ts");
    expect(calls).toEqual([
      ["diffIndexWithHEAD", "src/a.ts"],
      ["diffWithHEAD", "src/a.ts"],
    ]);
  });

  test("changedPathsNow is the working tree plus the untracked group; stagedPathsNow is the index", async () => {
    const { repo } = fakeRepository({
      workingTreeChanges: [change("src/a.ts")],
      untrackedChanges: [change("notes.md", GIT_STATUS_UNTRACKED)],
      indexChanges: [change("src/c.ts")],
    });
    const r = await adapted(repo);
    expect(r.changedPathsNow()).toEqual(["src/a.ts", "notes.md"]);
    expect(r.stagedPathsNow()).toEqual(["src/c.ts"]);
  });

  test("absent change groups read as empty, not as a crash", async () => {
    const { repo } = fakeRepository();
    const r = await adapted(repo);
    expect(r.changedPathsNow()).toEqual([]);
    expect(r.stagedPathsNow()).toEqual([]);
    expect(await r.untrackedPaths()).toEqual([]);
  });

  test("untrackedPaths merges the dedicated group with untracked working-tree entries", async () => {
    // Under the default git.untrackedChanges: "mixed", untracked files sit in
    // the working-tree group next to real modifications.
    const { repo } = fakeRepository({
      untrackedChanges: [change("new-a.ts", GIT_STATUS_UNTRACKED)],
      workingTreeChanges: [
        change("src/modified.ts", 5),
        change("new-b.ts", GIT_STATUS_UNTRACKED),
        change("new-a.ts", GIT_STATUS_UNTRACKED),
      ],
    });
    expect(await (await adapted(repo)).untrackedPaths()).toEqual(["new-a.ts", "new-b.ts"]);
  });

  test("a file outside the repository root is reduced to its basename, never sent absolute", async () => {
    const { repo } = fakeRepository({
      workingTreeChanges: [{ uri: { fsPath: "/home/someone/secret/x.ts" }, status: 5 }],
    });
    const paths = (await adapted(repo)).changedPathsNow();
    expect(paths).toEqual(["x.ts"]);
    expect(paths.join()).not.toContain("/home/someone");
  });

  test("log asks for the requested count and returns just the messages, newest first", async () => {
    const { repo, calls } = fakeRepository();
    expect(await (await adapted(repo)).log(20)).toEqual(["feat: newest", "fix: older"]);
    expect(calls).toEqual([["log", { maxEntries: 20 }]]);
  });

  test("onDidChange forwards to the repository state's own event", async () => {
    const { repo, changeListeners } = fakeRepository();
    const listener = vi.fn();
    (await adapted(repo)).onDidChange(listener);
    expect(changeListeners).toHaveLength(1);
    changeListeners[0]?.();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
