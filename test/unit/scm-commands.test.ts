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
  // Recording message methods plus a bare (no active editor) default. Fixtures
  // that only need to stub activeTextEditor (e.g. editorDeps) pass a partial
  // `window` here, which is merged on top of this rather than replacing it —
  // otherwise showErrorMessage/showWarningMessage/showInformationMessage stop
  // recording into the errors/warns/infos arrays below.
  const defaultWindow = {
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
  } as unknown as ScmCommandDeps["window"];
  const { window: windowOverride, ...restOver } = over;
  const window: ScmCommandDeps["window"] = {
    ...defaultWindow,
    ...windowOverride,
  } as ScmCommandDeps["window"];
  const deps: ScmCommandDeps = {
    git: async () => api,
    client: () => ({
      agentInvoke: async (input: string) => {
        invoked.push(input);
        return { reply: "feat: add a" };
      },
    }),
    window,
    agent: () => "",
    skipSecretFiles: () => true,
    egressProofTrailer: () => false,
    selectionOffsets: () => undefined,
    openReadonly: async (title: string, content: string) => {
      opened.push({ title, content });
    },
    openUntitled: async () => undefined,
    openDiff: async () => undefined,
    log: silentLog,
    ...restOver,
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

  test("appends the signed egress trailer when the setting is on", async () => {
    const repo = fakeRepo();
    const h = harness(
      {
        egressProofTrailer: () => true,
        client: () => ({
          agentInvoke: async () => ({ reply: "feat: add a" }),
          egressProveWindow: async () => ({
            receipt: { digest: "d1", sigB64: "s1", pubkeyB64: "p1" },
          }),
        }),
      },
      [repo],
    );
    await createScmCommands(h.deps).generateCommitMessage();
    expect(repo.inputBox.value).toBe("feat: add a\n\nNimbus-Egress-Proof: d1 sig=s1 pubkey=p1");
  });

  test("no trailer by default, even when the client could prove", async () => {
    const repo = fakeRepo();
    const h = harness(
      {
        client: () => ({
          agentInvoke: async () => ({ reply: "feat: add a" }),
          egressProveWindow: async () => ({
            receipt: { digest: "d1", sigB64: "s1", pubkeyB64: "p1" },
          }),
        }),
      },
      [repo],
    );
    await createScmCommands(h.deps).generateCommitMessage();
    expect(repo.inputBox.value).toBe("feat: add a");
  });

  test("a failing prove (or missing receipt) never blocks the message", async () => {
    const repo = fakeRepo();
    const h = harness(
      {
        egressProofTrailer: () => true,
        client: () => ({
          agentInvoke: async () => ({ reply: "feat: add a" }),
          egressProveWindow: async () => {
            throw new Error("no signing key");
          },
        }),
      },
      [repo],
    );
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

  test("aborts silently when the multi-repo quick pick is cancelled", async () => {
    const a = fakeRepo({ rootPath: "/w/a" });
    const b = fakeRepo({ rootPath: "/w/b" });
    const h = harness(
      { window: { showQuickPick: async () => undefined } as unknown as ScmCommandDeps["window"] },
      [a, b],
    );
    await createScmCommands(h.deps).generateCommitMessage();
    expect(a.inputBox.value).toBe("");
    expect(b.inputBox.value).toBe("");
    expect(h.errors).toEqual([]);
    expect(h.invoked).toEqual([]);
  });

  test("falls back to the Conventional Commits style when repo.log() rejects (no commits yet)", async () => {
    const repo = fakeRepo();
    const watched: GitRepositoryLike = {
      ...repo,
      log: async () => {
        throw new Error("fatal: your current branch does not have any commits yet");
      },
    };
    const h = harness({}, [watched]);
    await createScmCommands(h.deps).generateCommitMessage();
    expect(h.errors).toEqual([]);
    expect(h.invoked[0]).toContain("Conventional Commits");
    expect(repo.inputBox.value).toBe("feat: add a");
  });

  test("counts every considered file in the omission denominator, not just reviewed + too-large", async () => {
    const big = "@@ -1 +1 @@\n+".concat("x".repeat(60_000), "\n");
    const binary =
      "diff --git a/logo.png b/logo.png\nBinary files a/logo.png and b/logo.png differ\n";
    const h = harness({}, [
      fakeRepo({
        files: [
          { path: "src/a.ts", status: "modified" },
          { path: "src/big.ts", status: "modified" },
          { path: ".env", status: "modified" },
          { path: "logo.png", status: "modified" },
        ],
        diffs: {
          "src/a.ts": "@@ -1 +1 @@\n+a\n",
          "src/big.ts": big,
          ".env": "@@ -1 +1 @@\n+K=1\n",
          "logo.png": binary,
        },
      }),
    ]);
    await createScmCommands(h.deps).generateCommitMessage();
    // 1 reviewed (a.ts) + 1 too-large (big.ts) + 1 secret (.env) + 1
    // non-textual (logo.png) = 4 considered — not just reviewed + too-large.
    expect(h.warns.some((w) => w.includes("1 of 4 files omitted"))).toBe(true);
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

  test("reports a git-extension failure without throwing", async () => {
    const h = harness({
      git: async () => {
        throw new Error("git extension boom");
      },
    });
    await expect(createScmCommands(h.deps).generateCommitMessage()).resolves.toBeUndefined();
    expect(h.errors[0]).toContain("git extension boom");
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

describe("reviewChanges", () => {
  test("opens findings in a read-only tab", async () => {
    const h = harness({ client: () => ({ agentInvoke: async () => ({ reply: "Looks fine." }) }) });
    await createScmCommands(h.deps).reviewChanges();
    expect(h.opened[0]?.title).toBe("Nimbus review.md");
    expect(h.opened[0]?.content).toContain("Looks fine.");
  });

  test("reviews staged and unstaged changes together", async () => {
    const scopes: string[] = [];
    const repo = fakeRepo();
    const watched: GitRepositoryLike = {
      ...repo,
      changedFiles: async (scope) => {
        scopes.push(scope);
        return [{ path: "src/a.ts", status: "modified" }];
      },
    };
    const h = harness({}, [watched]);
    await createScmCommands(h.deps).reviewChanges();
    expect(scopes).toEqual(["all"]);
  });

  test("names untracked files in the header so they are not mistaken for reviewed", async () => {
    const h = harness({}, [fakeRepo({ untracked: ["src/brand-new.ts"] })]);
    await createScmCommands(h.deps).reviewChanges();
    expect(h.opened[0]?.content).toContain("Not reviewed — untracked");
    expect(h.opened[0]?.content).toContain("src/brand-new.ts");
  });

  test("names binary changes as non-textual, not as too-large", async () => {
    const binary =
      "diff --git a/logo.png b/logo.png\nBinary files a/logo.png and b/logo.png differ\n";
    const h = harness({}, [
      fakeRepo({
        files: [
          { path: "src/a.ts", status: "modified" },
          { path: "logo.png", status: "modified" },
        ],
        diffs: { "src/a.ts": "@@ -1 +1 @@\n+a\n", "logo.png": binary },
      }),
    ]);
    await createScmCommands(h.deps).reviewChanges();
    expect(h.opened[0]?.content).toContain("Not reviewed — binary or non-textual changes");
    expect(h.opened[0]?.content).toContain("logo.png");
    expect(h.invoked[0]).not.toContain("logo.png");
  });

  test("names secret-skipped files in the header", async () => {
    const h = harness({}, [
      fakeRepo({
        files: [
          { path: "src/a.ts", status: "modified" },
          { path: ".env", status: "modified" },
        ],
        diffs: { "src/a.ts": "@@ -1 +1 @@\n+a\n", ".env": "@@ -1 +1 @@\n+K=1\n" },
      }),
    ]);
    await createScmCommands(h.deps).reviewChanges();
    expect(h.opened[0]?.content).toContain("Not reviewed — possible secrets");
    expect(h.opened[0]?.content).toContain(".env");
  });

  test("never sends untracked file names to the agent", async () => {
    const h = harness({}, [fakeRepo({ untracked: ["src/brand-new.ts"] })]);
    await createScmCommands(h.deps).reviewChanges();
    expect(h.invoked[0]).not.toContain("brand-new");
  });

  test("shows the repo basename, never the absolute root", async () => {
    const h = harness({}, [fakeRepo({ rootPath: "/home/alice/secret-client/proj" })]);
    await createScmCommands(h.deps).reviewChanges();
    expect(h.opened[0]?.content).toContain("proj");
    expect(h.opened[0]?.content).not.toContain("/home/alice");
  });

  test("reports when there is nothing to review", async () => {
    const h = harness({}, [fakeRepo({ files: [] })]);
    await createScmCommands(h.deps).reviewChanges();
    expect(h.infos.some((i) => i.includes("no local changes"))).toBe(true);
    expect(h.opened).toEqual([]);
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
    await createScmCommands(h.deps).reviewChanges();
    expect(h.errors[0]).toContain("not connected");
    expect(read).toBe(false);
  });

  test("reports an agent failure without throwing", async () => {
    const h = harness({
      client: () => ({
        agentInvoke: async () => {
          throw new Error("boom");
        },
      }),
    });
    await expect(createScmCommands(h.deps).reviewChanges()).resolves.toBeUndefined();
    expect(h.errors[0]).toContain("boom");
  });

  test("reports a git-extension failure without throwing", async () => {
    const h = harness({
      git: async () => {
        throw new Error("git extension boom");
      },
    });
    await expect(createScmCommands(h.deps).reviewChanges()).resolves.toBeUndefined();
    expect(h.errors[0]).toContain("git extension boom");
  });

  test("reports a client-resolution failure without throwing", async () => {
    const h = harness({
      client: () => {
        throw new Error("client boom");
      },
    });
    await expect(createScmCommands(h.deps).reviewChanges()).resolves.toBeUndefined();
    expect(h.errors[0]).toContain("client boom");
  });

  test("names the secret reason when every changed file was secret-skipped", async () => {
    const h = harness({}, [
      fakeRepo({ files: [{ path: ".env", status: "modified" }], diffs: { ".env": "@@\n+K=1\n" } }),
    ]);
    await createScmCommands(h.deps).reviewChanges();
    expect(h.errors[0]).toContain("secret");
    expect(h.opened).toEqual([]);
  });

  test("names the non-textual reason when every changed file is binary", async () => {
    const binary =
      "diff --git a/logo.png b/logo.png\nBinary files a/logo.png and b/logo.png differ\n";
    const h = harness({}, [
      fakeRepo({
        files: [{ path: "logo.png", status: "modified" }],
        diffs: { "logo.png": binary },
      }),
    ]);
    await createScmCommands(h.deps).reviewChanges();
    expect(h.errors[0]).toContain("binary");
    expect(h.opened).toEqual([]);
  });
});

interface FakeEditorOpts {
  text?: string;
  fileName?: string;
  languageId?: string;
  selectionText?: string;
}

// Only stubs activeTextEditor/selection — the message methods
// (showErrorMessage/showWarningMessage/showInformationMessage/withProgress)
// are left for harness()'s defaultWindow to supply, merged on top of this, so
// they keep recording into h.errors/h.warns/h.infos.
function editorDeps(opts: FakeEditorOpts = {}): Partial<ScmCommandDeps> {
  const text = opts.text ?? "const a = 1;\nconst b = 2;\n";
  const selectionText = opts.selectionText;
  return {
    window: {
      activeTextEditor: {
        document: {
          getText: (range?: unknown) => (range === undefined ? text : (selectionText ?? "")),
          fileName: opts.fileName ?? "/home/dev/proj/src/a.ts",
          languageId: opts.languageId ?? "typescript",
        },
        selection: { isEmpty: selectionText === undefined },
      },
    } as unknown as ScmCommandDeps["window"],
  };
}

describe("generateTests", () => {
  test("opens an untitled buffer named for the source file", async () => {
    const untitled: Array<{ fileName: string; content: string }> = [];
    const h = harness({
      ...editorDeps(),
      client: () => ({ agentInvoke: async () => ({ reply: "```ts\ntest('a', () => {});\n```" }) }),
      openUntitled: async (o) => {
        untitled.push(o);
      },
    });
    await createScmCommands(h.deps).generateTests();
    expect(untitled[0]?.fileName).toBe("a.test.ts");
    expect(untitled[0]?.content).toBe("test('a', () => {});");
  });

  test("redacts the absolute source path out of the prompt", async () => {
    const h = harness({
      ...editorDeps({ fileName: "/home/alice/secret-client/src/a.ts" }),
      client: () => ({
        agentInvoke: async (input: string) => {
          h.invoked.push(input);
          return { reply: "code" };
        },
      }),
    });
    await createScmCommands(h.deps).generateTests();
    expect(h.invoked[0]).toContain("File: a.ts");
    expect(h.invoked[0]).not.toContain("/home/alice");
  });

  test("errors with no active editor", async () => {
    const h = harness();
    await createScmCommands(h.deps).generateTests();
    expect(h.errors[0]).toContain("open a file");
  });

  test("errors when disconnected", async () => {
    const h = harness({ ...editorDeps(), client: () => undefined });
    await createScmCommands(h.deps).generateTests();
    expect(h.errors[0]).toContain("not connected");
  });

  test("clamps whole-file context over the limit and marks the prompt truncated", async () => {
    const big = "x".repeat(60_000);
    const h = harness({
      ...editorDeps({ text: big }),
      client: () => ({
        agentInvoke: async (input: string) => {
          h.invoked.push(input);
          return { reply: "code" };
        },
      }),
    });
    await createScmCommands(h.deps).generateTests();
    expect(h.invoked[0]).toContain("(truncated)");
    expect(h.warns.some((w) => w.includes("truncated"))).toBe(true);
  });
});

describe("generateDocstrings", () => {
  test("diffs the original against the annotated whole file", async () => {
    const diffs: Array<{ title: string; left: string; right: string; fileName: string }> = [];
    const h = harness({
      ...editorDeps({ text: "def f(): pass\n", languageId: "python", fileName: "/p/a.py" }),
      client: () => ({
        agentInvoke: async () => ({ reply: '```python\ndef f():\n    """Doc."""\n    pass\n```' }),
      }),
      openDiff: async (o) => {
        diffs.push(o);
      },
    });
    await createScmCommands(h.deps).generateDocstrings();
    expect(diffs[0]?.left).toBe("def f(): pass\n");
    expect(diffs[0]?.right).toContain('"""Doc."""');
    // The basename carries the extension, which is how the opener gets
    // highlighting — and it must never carry the directory.
    expect(diffs[0]?.fileName).toBe("a.py");
    expect(diffs[0]?.title).toContain("a.py");
    expect(diffs[0]?.title).not.toContain("/p/");
  });

  test("diffs whole-file instead of splicing when the reply echoes the whole file", async () => {
    const full =
      "import { thing } from './somewhere-else';\nconst selected = 1;\nexport default selected;\n";
    const diffs: Array<{ left: string; right: string }> = [];
    const start = full.indexOf("const selected");
    const h = harness({
      ...editorDeps({ text: full, selectionText: "const selected = 1;" }),
      selectionOffsets: () => ({ start, end: start + "const selected = 1;".length }),
      client: () => ({
        // The agent ignored the instruction and returned the entire file.
        agentInvoke: async () => ({ reply: `\`\`\`ts\n// doc\n${full}\`\`\`` }),
      }),
      openDiff: async (o) => {
        diffs.push({ left: o.left, right: o.right });
      },
    });
    await createScmCommands(h.deps).generateDocstrings();
    // Spliced, this would have duplicated the import and the export line.
    expect(diffs[0]?.right.match(/somewhere-else/g)).toHaveLength(1);
    expect(diffs[0]?.right).toContain("// doc");
  });

  test("splices a selection rewrite back into the full document", async () => {
    const diffs: Array<{ left: string; right: string }> = [];
    const h = harness({
      ...editorDeps({ text: "AAA\nBBB\nCCC\n", selectionText: "BBB" }),
      selectionOffsets: () => ({ start: 4, end: 7 }),
      client: () => ({ agentInvoke: async () => ({ reply: "```ts\n// doc\nBBB\n```" }) }),
      openDiff: async (o) => {
        diffs.push({ left: o.left, right: o.right });
      },
    });
    await createScmCommands(h.deps).generateDocstrings();
    expect(diffs[0]?.left).toBe("AAA\nBBB\nCCC\n");
    expect(diffs[0]?.right).toBe("AAA\n// doc\nBBB\nCCC\n");
  });

  test("captures selection offsets before the agent call, not after", async () => {
    // agentInvoke is uncancellable and can run for seconds; if the user moves
    // the cursor/selection meanwhile, a *post*-invoke read of selectionOffsets
    // would return a stale/bogus range for a document that, at t0, held a
    // real selection. The fixture below returns the real offsets only until
    // agentInvoke resolves, then switches to a different (wrong) range —
    // pinning that the splice uses the t0 value, not a t1 re-read.
    const diffs: Array<{ left: string; right: string }> = [];
    let invokeFinished = false;
    const h = harness({
      ...editorDeps({ text: "AAA\nBBB\nCCC\n", selectionText: "BBB" }),
      selectionOffsets: () => (invokeFinished ? { start: 0, end: 3 } : { start: 4, end: 7 }),
      client: () => ({
        agentInvoke: async () => {
          invokeFinished = true;
          return { reply: "```ts\n// doc\nBBB\n```" };
        },
      }),
      openDiff: async (o) => {
        diffs.push({ left: o.left, right: o.right });
      },
    });
    await createScmCommands(h.deps).generateDocstrings();
    expect(diffs[0]?.left).toBe("AAA\nBBB\nCCC\n");
    expect(diffs[0]?.right).toBe("AAA\n// doc\nBBB\nCCC\n");
  });

  test("falls back to a read-only tab when selection offsets are unavailable", async () => {
    const h = harness({
      ...editorDeps({ text: "AAA\n", selectionText: "AAA" }),
      selectionOffsets: () => undefined,
      client: () => ({ agentInvoke: async () => ({ reply: "```ts\n// doc\nAAA\n```" }) }),
    });
    await createScmCommands(h.deps).generateDocstrings();
    expect(h.opened[0]?.title).toBe("Nimbus docstrings.md");
  });

  test("errors with no active editor", async () => {
    const h = harness();
    await createScmCommands(h.deps).generateDocstrings();
    expect(h.errors[0]).toContain("open a file");
  });
});
