import { describe, expect, test } from "vitest";

import type { Logger } from "../../src/logging.js";
import { createScmCommands, type ScmCommandDeps } from "../../src/scm/commands.js";
import type {
  ChangedFile,
  DiffScope,
  GitApiLike,
  GitRepositoryLike,
} from "../../src/scm/git-types.js";

const silentLog: Logger = {
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
  debug: () => undefined,
} as unknown as Logger;

interface FakeRepoOpts {
  rootPath?: string;
  files?: readonly ChangedFile[];
  diffs?: Record<string, string>;
  untracked?: readonly string[];
  log?: readonly string[];
  inputBoxValue?: string;
}

function fakeRepo(opts: FakeRepoOpts = {}): GitRepositoryLike {
  const files = opts.files ?? [{ path: "src/a.ts", status: "modified" }];
  const diffs = opts.diffs ?? { "src/a.ts": "@@ -1 +1 @@\n+const a = 1;\n" };
  return {
    rootPath: opts.rootPath ?? "/home/dev/proj",
    changedFiles: async (_scope: DiffScope) => files,
    fileDiff: async (_scope: DiffScope, path: string) => diffs[path] ?? "",
    untrackedPaths: async () => opts.untracked ?? [],
    log: async () => opts.log ?? ["feat: earlier change"],
    inputBox: { value: opts.inputBoxValue ?? "" },
  };
}

interface Harness {
  deps: ScmCommandDeps;
  errors: string[];
  warns: string[];
  infos: string[];
  modalAnswers: string[];
  invoked: string[];
  opened: Array<{ title: string; content: string }>;
}

function harness(
  over: Partial<ScmCommandDeps> = {},
  repos: GitRepositoryLike[] = [fakeRepo()],
): Harness {
  const errors: string[] = [];
  const warns: string[] = [];
  const infos: string[] = [];
  const invoked: string[] = [];
  const opened: Array<{ title: string; content: string }> = [];
  const modalAnswers: string[] = [];
  const api: GitApiLike = { repositories: () => repos };
  const deps: ScmCommandDeps = {
    git: async () => api,
    client: () => ({
      agentInvoke: async (input: string) => {
        invoked.push(input);
        return { reply: "feat: add a" };
      },
    }),
    window: {
      showErrorMessage: async (msg: string) => {
        errors.push(msg);
        return undefined;
      },
      showWarningMessage: async (msg: string) => {
        warns.push(msg);
        return modalAnswers.shift();
      },
      showInformationMessage: async (msg: string) => {
        infos.push(msg);
        return undefined;
      },
      showQuickPick: async (items: readonly { label: string }[]) => items[0],
      withProgress: async <R>(_o: unknown, task: () => Promise<R>) => task(),
      activeTextEditor: undefined,
    } as unknown as ScmCommandDeps["window"],
    agent: () => "",
    skipSecretFiles: () => true,
    selectionOffsets: () => undefined,
    openReadonly: async (title: string, content: string) => {
      opened.push({ title, content });
    },
    openUntitled: async () => undefined,
    openDiff: async () => undefined,
    log: silentLog,
    ...over,
  };
  return { deps, errors, warns, infos, modalAnswers, invoked, opened };
}

describe("generateCommitMessage", () => {
  test("writes the sanitized draft into an empty input box", async () => {
    const repo = fakeRepo();
    const h = harness({}, [repo]);
    await createScmCommands(h.deps).generateCommitMessage();
    expect(repo.inputBox.value).toBe("feat: add a");
    expect(h.errors).toEqual([]);
  });

  test("sends the diff and the filtered style examples", async () => {
    const repo = fakeRepo({ log: ["Merge branch 'main'", "feat: earlier"] });
    const h = harness({}, [repo]);
    await createScmCommands(h.deps).generateCommitMessage();
    const prompt = h.invoked[0] ?? "";
    expect(prompt).toContain("+const a = 1;");
    expect(prompt).toContain("feat: earlier");
    expect(prompt).not.toContain("Merge branch");
  });

  test("never sends the absolute repo root", async () => {
    const repo = fakeRepo({ rootPath: "/home/alice/secret-client/proj" });
    const h = harness({}, [repo]);
    await createScmCommands(h.deps).generateCommitMessage();
    expect(h.invoked[0]).not.toContain("/home/alice");
  });

  test("errors when the git extension is unavailable", async () => {
    const h = harness({ git: async () => undefined });
    await createScmCommands(h.deps).generateCommitMessage();
    expect(h.errors[0]).toContain("Git extension");
    expect(h.invoked).toEqual([]);
  });

  test("errors when there is no repository", async () => {
    const h = harness({}, []);
    await createScmCommands(h.deps).generateCommitMessage();
    expect(h.errors[0]).toContain("no Git repository");
  });

  test("prompts to pick when there are several repositories", async () => {
    const a = fakeRepo({ rootPath: "/w/a" });
    const b = fakeRepo({ rootPath: "/w/b" });
    const h = harness({}, [a, b]);
    await createScmCommands(h.deps).generateCommitMessage();
    // The harness quick pick returns the first item.
    expect(a.inputBox.value).toBe("feat: add a");
    expect(b.inputBox.value).toBe("");
  });

  test("errors when disconnected, before reading any diff", async () => {
    let read = false;
    const repo = fakeRepo();
    const watched: GitRepositoryLike = {
      ...repo,
      changedFiles: async () => {
        read = true;
        return [];
      },
    };
    const h = harness({ client: () => undefined }, [watched]);
    await createScmCommands(h.deps).generateCommitMessage();
    expect(h.errors[0]).toContain("not connected");
    expect(read).toBe(false);
  });

  test("errors when nothing is staged", async () => {
    const h = harness({}, [fakeRepo({ files: [] })]);
    await createScmCommands(h.deps).generateCommitMessage();
    expect(h.errors[0]).toContain("nothing staged");
    expect(h.invoked).toEqual([]);
  });

  test("errors when every staged file was skipped as secret-bearing", async () => {
    const h = harness({}, [
      fakeRepo({ files: [{ path: ".env", status: "modified" }], diffs: { ".env": "@@\n+K=1\n" } }),
    ]);
    await createScmCommands(h.deps).generateCommitMessage();
    expect(h.errors[0]).toContain("secret");
    expect(h.invoked).toEqual([]);
  });

  test("asks before overwriting a non-empty input box, and honours Replace", async () => {
    const repo = fakeRepo({ inputBoxValue: "wip" });
    const h = harness({}, [repo]);
    h.modalAnswers.push("Replace");
    await createScmCommands(h.deps).generateCommitMessage();
    expect(repo.inputBox.value).toBe("feat: add a");
  });

  test("honours Append", async () => {
    const repo = fakeRepo({ inputBoxValue: "wip" });
    const h = harness({}, [repo]);
    h.modalAnswers.push("Append");
    await createScmCommands(h.deps).generateCommitMessage();
    expect(repo.inputBox.value).toBe("wip\n\nfeat: add a");
  });

  test("leaves the input box untouched when the modal is cancelled", async () => {
    const repo = fakeRepo({ inputBoxValue: "wip" });
    const h = harness({}, [repo]);
    // No answer queued → showWarningMessage resolves undefined (dismissed).
    await createScmCommands(h.deps).generateCommitMessage();
    expect(repo.inputBox.value).toBe("wip");
  });

  test("falls back to a read-only tab when the repository closed mid-invoke", async () => {
    const repo = fakeRepo();
    const repos = [repo];
    const h = harness(
      {
        client: () => ({
          agentInvoke: async () => {
            // The folder closes while the (uncancellable) call is in flight.
            repos.length = 0;
            return { reply: "feat: add a" };
          },
        }),
      },
      repos,
    );
    await createScmCommands(h.deps).generateCommitMessage();
    expect(repo.inputBox.value).toBe("");
    expect(h.opened[0]?.content).toContain("feat: add a");
    expect(h.warns.some((w) => w.includes("closed"))).toBe(true);
  });

  test("reports an agent failure without throwing", async () => {
    const h = harness({
      client: () => ({
        agentInvoke: async () => {
          throw new Error("boom");
        },
      }),
    });
    await expect(createScmCommands(h.deps).generateCommitMessage()).resolves.toBeUndefined();
    expect(h.errors[0]).toContain("boom");
  });

  test("reports an empty reply", async () => {
    const h = harness({ client: () => ({ agentInvoke: async () => ({ reply: "   " }) }) });
    await createScmCommands(h.deps).generateCommitMessage();
    expect(h.infos.some((i) => i.includes("no reply"))).toBe(true);
  });

  test("warns when files were omitted for size", async () => {
    const big = "@@ -1 +1 @@\n+".concat("x".repeat(60_000), "\n");
    const h = harness({}, [
      fakeRepo({
        files: [
          { path: "src/a.ts", status: "modified" },
          { path: "src/big.ts", status: "modified" },
        ],
        diffs: { "src/a.ts": "@@ -1 +1 @@\n+a\n", "src/big.ts": big },
      }),
    ]);
    await createScmCommands(h.deps).generateCommitMessage();
    expect(h.warns.some((w) => w.includes("omitted"))).toBe(true);
  });
});
