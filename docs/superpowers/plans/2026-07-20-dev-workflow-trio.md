# Dev-workflow trio Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship three editor-native commands — Generate Commit Message, Review Changes, and Generate Tests/Docstrings — backed by the local Nimbus agent over `agentInvoke` and VS Code's built-in git extension.

**Architecture:** All decision logic lives in pure modules under `src/scm/` behind narrow structural interfaces (`GitApiLike`, `GitRepositoryLike`); the `vscode` git API is touched only in `src/scm/real-git.ts`, a coverage-excluded adapter. Command orchestration lives in `src/scm/commands.ts` with an injected deps object, so all four handlers are unit-testable with fakes and `extension.ts` only wires and registers. This mirrors `chat-participant/participant.ts` ↔ `real-participant.ts`.

**Tech Stack:** TypeScript (strict), Vitest, Biome, esbuild, `@nimbus-dev/client` (no bump), VS Code built-in git extension API (`getAPI(1)`).

**Spec:** [2026-07-20-dev-workflow-trio-design.md](../specs/2026-07-20-dev-workflow-trio-design.md)

## Global Constraints

- **TypeScript strict; no `any`.** Use `unknown` for external data. Biome enforces `noExplicitAny`, `noNonNullAssertion`, and `noConsole` in `src/`.
- **Never log via `console`.** Use the `Logger` from `src/logging.ts`.
- **The `vscode` API is only touched through `src/vscode-shim.ts` or a thin, coverage-excluded `real-*.ts` adapter.** Pure modules import neither.
- **No new npm dependency, and no `@nimbus-dev/client` bump.** The only Nimbus dependency stays `@nimbus-dev/client`; never import from the Nimbus gateway.
- **No `child_process`, no `git` CLI.** All git access goes through the built-in git extension API.
- **The extension never writes to disk or applies a `WorkspaceEdit`.** Output is an SCM input box, an untitled buffer, a read-only tab, or a diff view.
- **Never send `repo.rootPath`, or any absolute path, to the agent.** Repo-relative paths from git are fine; any path we add ourselves goes through `redactPath`.
- **Reuse, don't reimplement:** `clampContext`, `redactPath`, `extractReply`, `buildQuickAskPrompt`, `QUICK_ASK_MAX_CONTEXT_CHARS` from `src/quick-ask.ts`.
- **Imports use the `.js` extension** (`from "./diff.js"`), matching the codebase.
- Exact constants: `SCM_MAX_DIFF_CHARS = QUICK_ASK_MAX_CONTEXT_CHARS` (50 000), `SCM_MAX_FILES = 100`, `COMMIT_LOG_FETCH = 30`, `COMMIT_STYLE_EXAMPLES = 10`.
- Every task ends green on `bun run test && bun run typecheck && bun run lint`.

### Deviation from the spec (recorded deliberately)

The spec put selection offsets on `TextEditorLike` in the shim (`document.offsetAt`, `selection.start/end`). This plan instead puts a `selectionOffsets(): { start: number; end: number } | undefined` accessor on the SCM command deps, computed in `extension.ts` glue. Same capability, but it avoids widening a shim interface that a dozen existing test fakes already satisfy. Nothing else in the spec changes.

---

## File Structure

**Create:**

| File | Responsibility |
| --- | --- |
| `src/scm/git-types.ts` | Structural interfaces for the git seam. Types only, no logic. |
| `src/scm/repo-select.ts` | Classify the repository list (none/one/many); label a repo; re-find a repo by root. |
| `src/scm/diff.ts` | Classify changed files (secret/deprioritized/normal), order them, select within a char budget, hunk-boundary-truncate, render the prompt block. |
| `src/scm/commit-message.ts` | Filter log style examples, build the commit prompt, sanitize the reply, compose the input-box value. |
| `src/scm/review.ts` | Build the review prompt and the coverage-headed findings document. |
| `src/scm/generate.ts` | Derive test filenames, build tests/docstrings prompts, extract code from a reply, splice a selection back into a document. |
| `src/scm/commands.ts` | The four command handlers over an injected deps object. |
| `src/scm/real-git.ts` | `vscode.git` adapter (`getExtension` → `activate` → `getAPI(1)`). Coverage-excluded. |
| `test/unit/scm-repo-select.test.ts`, `scm-diff.test.ts`, `scm-commit-message.test.ts`, `scm-review.test.ts`, `scm-generate.test.ts`, `scm-commands.test.ts` | Unit tests per module. |

**Modify:**

| File | Change |
| --- | --- |
| `src/settings.ts` | Add `scmSkipSecretFiles()`. |
| `src/extension.ts` | Add `git` / `openUntitled` / `openDiff` / `selectionOffsets` to `ActivateDeps`; real implementations; register four commands. |
| `package.json` | Four commands, menu contributions, one configuration property. |
| `vitest.config.ts` | Coverage-exclude `src/scm/real-git.ts`. |
| `docs/settings.md`, `docs/architecture.md`, `docs/ROADMAP.md`, `README.md`, `CLAUDE.md` | Documentation. |

---

## Task 1: Git seam types and repository selection

**Files:**
- Create: `src/scm/git-types.ts`
- Create: `src/scm/repo-select.ts`
- Test: `test/unit/scm-repo-select.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `DiffScope`, `ChangedFile`, `GitRepositoryLike`, `GitApiLike` (types); `classifyRepositories(repos): RepoChoice`, `repoLabel(repo): string`, `findRepoByRoot(repos, rootPath): GitRepositoryLike | undefined`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/scm-repo-select.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- scm-repo-select`
Expected: FAIL — cannot resolve `../../src/scm/git-types.js`.

- [ ] **Step 3: Write the types**

Create `src/scm/git-types.ts`:

```ts
// Narrow structural seam over VS Code's built-in git extension API. The rest of
// the codebase programs against these four verbs, never against the git
// extension's own shape (which real-git.ts adapts). Types only — no logic, so
// this file needs no tests.

// "staged" = index vs HEAD (what a commit would contain).
// "all"    = working tree vs HEAD (staged + unstaged tracked changes).
export type DiffScope = "staged" | "all";

export interface ChangedFile {
  // Repo-relative, as git reports it — safe to send (no username, no layout).
  readonly path: string;
  readonly status: string;
}

export interface GitRepositoryLike {
  // Absolute. Never sent to the agent; only its basename is ever displayed.
  readonly rootPath: string;
  changedFiles(scope: DiffScope): Promise<readonly ChangedFile[]>;
  fileDiff(scope: DiffScope, path: string): Promise<string>;
  // Counted and named in the review header; contents are never sent.
  untrackedPaths(): Promise<readonly string[]>;
  // Most recent commit messages, newest first.
  log(maxEntries: number): Promise<readonly string[]>;
  readonly inputBox: { value: string };
}

export interface GitApiLike {
  repositories(): readonly GitRepositoryLike[];
}
```

- [ ] **Step 4: Write the selection logic**

Create `src/scm/repo-select.ts`:

```ts
import type { GitRepositoryLike } from "./git-types.js";

export type RepoChoice =
  | { kind: "none" }
  | { kind: "one"; repo: GitRepositoryLike }
  | { kind: "many"; repos: readonly GitRepositoryLike[] };

// Zero repos is an error the caller reports; one is used silently; many needs a
// quick pick. Keeping this a pure classification keeps the prompting in the
// command layer.
export function classifyRepositories(repos: readonly GitRepositoryLike[]): RepoChoice {
  const first = repos[0];
  if (first === undefined) return { kind: "none" };
  if (repos.length === 1) return { kind: "one", repo: first };
  return { kind: "many", repos };
}

// Basename of the repo root — the only part of an absolute path we ever show.
// Handles POSIX and Windows separators and a trailing separator.
export function repoLabel(repo: GitRepositoryLike): string {
  const segments = repo.rootPath.split(/[\\/]/).filter((s) => s.length > 0);
  return segments.at(-1) ?? repo.rootPath;
}

// Re-find a previously captured repository after an uncancellable agent call.
// Matching by rootPath (not object identity) survives the git extension handing
// out a fresh Repository object for the same folder.
export function findRepoByRoot(
  repos: readonly GitRepositoryLike[],
  rootPath: string,
): GitRepositoryLike | undefined {
  return repos.find((r) => r.rootPath === rootPath);
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun run test -- scm-repo-select`
Expected: PASS, 8 tests.

- [ ] **Step 6: Verify the gate**

Run: `bun run typecheck && bun run lint`
Expected: both exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/scm/git-types.ts src/scm/repo-select.ts test/unit/scm-repo-select.test.ts
git commit -m "feat(scm): add git seam types and repository selection"
```

---

## Task 2: Diff classification, budgeting, and hunk-boundary truncation

**Files:**
- Create: `src/scm/diff.ts`
- Modify: `src/settings.ts`
- Modify: `package.json` (`contributes.configuration.properties`)
- Modify: `docs/settings.md`
- Test: `test/unit/scm-diff.test.ts`

**Interfaces:**
- Consumes: `ChangedFile` from `src/scm/git-types.js`; `QUICK_ASK_MAX_CONTEXT_CHARS` from `src/quick-ask.js`.
- Produces: `SCM_MAX_DIFF_CHARS`, `SCM_MAX_FILES`, `OmitReason`, `OmittedFile`, `SelectedFile`, `DiffSelection`, `isSecretPath(path)`, `isDeprioritizedPath(path)`, `orderFiles(files, opts)`, `truncateAtHunkBoundary(diff, budget)`, `selectWithinBudget(entries, budget)`, `renderDiffBlock(files)`.

`nimbus.scm.skipSecretFiles` is added here because `orderFiles` is its only consumer. `bun run check-settings-docs` fails CI if `package.json` and `docs/settings.md` disagree, so all three move together.

- [ ] **Step 1: Write the failing test**

Create `test/unit/scm-diff.test.ts`:

```ts
import { describe, expect, test } from "vitest";

import {
  hasHunks,
  isDeprioritizedPath,
  isSecretPath,
  orderFiles,
  renderDiffBlock,
  SCM_MAX_DIFF_CHARS,
  SCM_MAX_FILES,
  selectWithinBudget,
  truncateAtHunkBoundary,
} from "../../src/scm/diff.js";

const changed = (path: string) => ({ path, status: "modified" });

// A diff with `n` hunks, each roughly `size` chars.
function fakeDiff(path: string, hunks: number, size: number): string {
  const head = `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n`;
  const body = Array.from(
    { length: hunks },
    (_, i) => `@@ -${i + 1},1 +${i + 1},1 @@\n+${"x".repeat(size)}\n`,
  ).join("");
  return head + body;
}

describe("path classification", () => {
  test("flags secret-bearing paths", () => {
    for (const p of [".env", ".env.local", "config/.env.production", "certs/a.pem", "a.key", "id_rsa", "id_rsa.pub", "c.p12", "d.pfx"]) {
      expect(isSecretPath(p)).toBe(true);
    }
  });
  test("does not flag ordinary source files", () => {
    for (const p of ["src/env.ts", "src/keyboard.ts", "docs/environment.md", "src/a.pem.ts"]) {
      expect(isSecretPath(p)).toBe(false);
    }
  });
  test("flags lockfiles and generated artifacts as deprioritized", () => {
    for (const p of ["package-lock.json", "bun.lockb", "yarn.lock", "pnpm-lock.yaml", "Cargo.lock", "poetry.lock", "dist/a.min.js", "test/__snapshots__/a.snap"]) {
      expect(isDeprioritizedPath(p)).toBe(true);
    }
  });
});

describe("orderFiles", () => {
  test("skips secret files and reports them when skipSecrets is on", () => {
    const r = orderFiles([changed("src/a.ts"), changed(".env")], { skipSecrets: true });
    expect(r.ordered.map((f) => f.path)).toEqual(["src/a.ts"]);
    expect(r.omitted).toEqual([{ path: ".env", reason: "secret" }]);
  });
  test("keeps secret files when skipSecrets is off", () => {
    const r = orderFiles([changed("src/a.ts"), changed(".env")], { skipSecrets: false });
    expect(r.ordered.map((f) => f.path)).toEqual(["src/a.ts", ".env"]);
    expect(r.omitted).toEqual([]);
  });
  test("puts deprioritized files last but keeps relative order within each group", () => {
    const r = orderFiles(
      [changed("bun.lockb"), changed("src/a.ts"), changed("yarn.lock"), changed("src/b.ts")],
      { skipSecrets: true },
    );
    expect(r.ordered.map((f) => f.path)).toEqual(["src/a.ts", "src/b.ts", "bun.lockb", "yarn.lock"]);
  });
  test("caps the file count and reports the overflow", () => {
    const files = Array.from({ length: SCM_MAX_FILES + 3 }, (_, i) => changed(`src/f${i}.ts`));
    const r = orderFiles(files, { skipSecrets: true });
    expect(r.ordered).toHaveLength(SCM_MAX_FILES);
    expect(r.omitted).toHaveLength(3);
    expect(r.omitted.every((o) => o.reason === "file-cap")).toBe(true);
  });
});

describe("hasHunks", () => {
  test("is true for a normal text diff", () => {
    expect(hasHunks(fakeDiff("a.ts", 1, 10))).toBe(true);
  });
  test("is false for a binary diff and a pure rename", () => {
    expect(hasHunks("diff --git a/a.png b/a.png\nBinary files differ\n")).toBe(false);
    expect(hasHunks("diff --git a/a.ts b/b.ts\nrename from a.ts\nrename to b.ts\n")).toBe(false);
  });
});

describe("truncateAtHunkBoundary", () => {
  test("returns the whole diff when it already fits", () => {
    const d = fakeDiff("a.ts", 2, 10);
    const r = truncateAtHunkBoundary(d, 10_000);
    expect(r).toEqual({ text: d, keptHunks: 2, totalHunks: 2 });
  });
  test("keeps only whole hunks that fit, never a partial one", () => {
    const d = fakeDiff("a.ts", 3, 100);
    const r = truncateAtHunkBoundary(d, 300);
    expect(r).toBeDefined();
    expect(r?.keptHunks).toBeLessThan(3);
    expect(r?.totalHunks).toBe(3);
    // Every retained hunk is complete: the text ends on a newline and contains
    // exactly keptHunks hunk headers.
    expect((r?.text.match(/^@@ /gm) ?? []).length).toBe(r?.keptHunks);
    expect(r?.text.endsWith("\n")).toBe(true);
  });
  test("returns undefined when not even the first hunk fits", () => {
    expect(truncateAtHunkBoundary(fakeDiff("a.ts", 2, 5_000), 200)).toBeUndefined();
  });
  test("returns undefined for a diff with no hunks (binary file)", () => {
    const binary = "diff --git a/a.png b/a.png\nBinary files a/a.png and b/a.png differ\n";
    expect(truncateAtHunkBoundary(binary, 10)).toBeUndefined();
  });
  test("handles CRLF hunk headers", () => {
    const d = "diff --git a/a.ts b/a.ts\r\n@@ -1,1 +1,1 @@\r\n+a\r\n@@ -2,1 +2,1 @@\r\n+b\r\n";
    expect(truncateAtHunkBoundary(d, 10_000)?.totalHunks).toBe(2);
  });
});

describe("selectWithinBudget", () => {
  test("takes whole files while they fit", () => {
    const entries = [
      { path: "a.ts", diff: fakeDiff("a.ts", 1, 50) },
      { path: "b.ts", diff: fakeDiff("b.ts", 1, 50) },
    ];
    const r = selectWithinBudget(entries, 10_000);
    expect(r.files.map((f) => f.path)).toEqual(["a.ts", "b.ts"]);
    expect(r.omitted).toEqual([]);
  });
  test("drops whole files that do not fit and reports them", () => {
    const entries = [
      { path: "a.ts", diff: fakeDiff("a.ts", 1, 100) },
      { path: "big.ts", diff: fakeDiff("big.ts", 1, 5_000) },
      { path: "c.ts", diff: fakeDiff("c.ts", 1, 50) },
    ];
    const r = selectWithinBudget(entries, 600);
    expect(r.files.map((f) => f.path)).toEqual(["a.ts", "c.ts"]);
    expect(r.omitted).toEqual([{ path: "big.ts", reason: "too-large" }]);
  });
  test("truncates the first file at a hunk boundary when nothing else fits", () => {
    const r = selectWithinBudget([{ path: "big.ts", diff: fakeDiff("big.ts", 4, 200) }], 600);
    expect(r.files).toHaveLength(1);
    expect(r.files[0]?.truncated).toBeDefined();
    expect(r.files[0]?.truncated?.total).toBe(4);
    expect(r.files[0]?.truncated?.kept).toBeLessThan(4);
    expect(r.omitted).toEqual([]);
  });
  test("drops the first file entirely when even its first hunk is too big", () => {
    const r = selectWithinBudget([{ path: "big.ts", diff: fakeDiff("big.ts", 2, 5_000) }], 300);
    expect(r.files).toEqual([]);
    expect(r.omitted).toEqual([{ path: "big.ts", reason: "too-large" }]);
  });
  test("omits a small binary file as non-textual, not as too-large", () => {
    const binary = "diff --git a/a.png b/a.png\nBinary files a/a.png and b/a.png differ\n";
    const r = selectWithinBudget([{ path: "a.png", diff: binary }], 10_000);
    expect(r.files).toEqual([]);
    expect(r.omitted).toEqual([{ path: "a.png", reason: "non-textual" }]);
  });
  test("omits a pure rename as non-textual", () => {
    const rename = "diff --git a/a.ts b/b.ts\nsimilarity index 100%\nrename from a.ts\nrename to b.ts\n";
    const r = selectWithinBudget([{ path: "b.ts", diff: rename }], 10_000);
    expect(r.omitted).toEqual([{ path: "b.ts", reason: "non-textual" }]);
  });
  test("a non-textual file does not consume the first-file truncation fallback", () => {
    const binary = "diff --git a/a.png b/a.png\nBinary files a/a.png and b/a.png differ\n";
    const r = selectWithinBudget(
      [
        { path: "a.png", diff: binary },
        { path: "big.ts", diff: fakeDiff("big.ts", 4, 200) },
      ],
      600,
    );
    expect(r.files.map((f) => f.path)).toEqual(["big.ts"]);
    expect(r.files[0]?.truncated?.total).toBe(4);
  });
  test("never emits a partial hunk", () => {
    const r = selectWithinBudget([{ path: "big.ts", diff: fakeDiff("big.ts", 5, 200) }], 700);
    const text = r.files[0]?.diff ?? "";
    const openers = (text.match(/^@@ /gm) ?? []).length;
    expect(openers).toBe(r.files[0]?.truncated?.kept);
  });
});

describe("renderDiffBlock", () => {
  test("fences each file under a repo-relative header", () => {
    const out = renderDiffBlock([{ path: "src/a.ts", diff: "@@ -1 +1 @@\n+a\n" }]);
    expect(out).toContain("File: src/a.ts");
    expect(out).toContain("```diff");
    expect(out).toContain("+a");
  });
  test("marks a truncated file honestly", () => {
    const out = renderDiffBlock([
      { path: "src/a.ts", diff: "@@ -1 +1 @@\n+a\n", truncated: { kept: 1, total: 4 } },
    ]);
    expect(out).toContain("File: src/a.ts (truncated — 1 of 4 hunks)");
  });
});

describe("constants", () => {
  test("the diff budget matches the quick-ask context cap", () => {
    expect(SCM_MAX_DIFF_CHARS).toBe(50_000);
  });
  test("the file cap is 100", () => {
    expect(SCM_MAX_FILES).toBe(100);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- scm-diff`
Expected: FAIL — cannot resolve `../../src/scm/diff.js`.

- [ ] **Step 3: Write the implementation**

Create `src/scm/diff.ts`:

```ts
import { QUICK_ASK_MAX_CONTEXT_CHARS } from "../quick-ask.js";
import type { ChangedFile } from "./git-types.js";

// One budget, shared with quick-ask: the justification for 50k is the same.
export const SCM_MAX_DIFF_CHARS = QUICK_ASK_MAX_CONTEXT_CHARS;

// Per-file diff fetching costs one call per file; this bounds a huge branch to
// a predictable number of round-trips. Overflow is reported, never silent.
export const SCM_MAX_FILES = 100;

export type OmitReason = "secret" | "too-large" | "file-cap" | "non-textual";

export interface OmittedFile {
  path: string;
  reason: OmitReason;
}

export interface SelectedFile {
  path: string;
  diff: string;
  // Present only for the single oversized-file fallback.
  truncated?: { kept: number; total: number };
}

export interface DiffSelection {
  files: SelectedFile[];
  omitted: OmittedFile[];
}

const SECRET_PATTERNS: readonly RegExp[] = [
  /(^|\/)\.env(\.|$)/,
  /\.pem$/,
  /\.key$/,
  /(^|\/)id_rsa(\.|$)/,
  /\.p12$/,
  /\.pfx$/,
];

const DEPRIORITIZED_PATTERNS: readonly RegExp[] = [
  /(^|\/)package-lock\.json$/,
  /(^|\/)bun\.lockb$/,
  /(^|\/)yarn\.lock$/,
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)Cargo\.lock$/,
  /(^|\/)poetry\.lock$/,
  /\.min\.[^/]+$/,
  /\.snap$/,
];

// A staged .env reaching a cloud LLM is the one unrecoverable mistake this
// feature makes available, so the match is on the whole repo-relative path.
export function isSecretPath(path: string): boolean {
  return SECRET_PATTERNS.some((re) => re.test(path));
}

// Not excluded — just sent last. A 4000-line lockfile diff would otherwise eat
// the whole budget and starve the code that actually matters.
export function isDeprioritizedPath(path: string): boolean {
  return DEPRIORITIZED_PATTERNS.some((re) => re.test(path));
}

// Secret-skip, then normal-before-deprioritized (stable within each group), then
// cap the count. Every dropped file is reported with its reason so the caller
// can tell the user rather than silently under-reviewing.
export function orderFiles(
  files: readonly ChangedFile[],
  opts: { skipSecrets: boolean },
): { ordered: ChangedFile[]; omitted: OmittedFile[] } {
  const omitted: OmittedFile[] = [];
  const normal: ChangedFile[] = [];
  const deprioritized: ChangedFile[] = [];
  for (const file of files) {
    if (opts.skipSecrets && isSecretPath(file.path)) {
      omitted.push({ path: file.path, reason: "secret" });
      continue;
    }
    if (isDeprioritizedPath(file.path)) deprioritized.push(file);
    else normal.push(file);
  }
  const ranked = [...normal, ...deprioritized];
  const ordered = ranked.slice(0, SCM_MAX_FILES);
  for (const file of ranked.slice(SCM_MAX_FILES)) {
    omitted.push({ path: file.path, reason: "file-cap" });
  }
  return { ordered, omitted };
}

// Split a file diff into its leading header and its `@@` hunks. A raw character
// slice would cut mid-hunk and hand the agent malformed diff syntax, which
// produces confident nonsense — so truncation only ever happens here.
function splitHunks(diff: string): { header: string; hunks: string[] } {
  const lines = diff.split(/(?<=\n)/);
  const header: string[] = [];
  const hunks: string[] = [];
  let current: string[] | undefined;
  for (const line of lines) {
    if (line.startsWith("@@ ")) {
      if (current !== undefined) hunks.push(current.join(""));
      current = [line];
    } else if (current === undefined) {
      header.push(line);
    } else {
      current.push(line);
    }
  }
  if (current !== undefined) hunks.push(current.join(""));
  return { header: header.join(""), hunks };
}

// A diff with no `@@` hunks carries no reviewable text: a binary file, a pure
// rename, or a mode change. Sending it wastes budget and tells the agent
// nothing, so these are omitted with their own reason rather than being
// misreported as "too large".
export function hasHunks(diff: string): boolean {
  return splitHunks(diff).hunks.length > 0;
}

// Keep the header plus as many whole hunks as fit. Returns undefined when the
// header plus the first hunk already exceed the budget, or when there are no
// hunks at all (a binary file) — the caller drops the file rather than sending
// something broken.
export function truncateAtHunkBoundary(
  diff: string,
  budget: number,
): { text: string; keptHunks: number; totalHunks: number } | undefined {
  const { header, hunks } = splitHunks(diff);
  if (hunks.length === 0) return undefined;
  let text = header;
  let kept = 0;
  for (const hunk of hunks) {
    if (text.length + hunk.length > budget) break;
    text += hunk;
    kept += 1;
  }
  if (kept === 0) return undefined;
  return { text, keptHunks: kept, totalHunks: hunks.length };
}

// Greedy, whole-file, in the order given. The single documented exception is the
// first file: if nothing fits at all, it goes in hunk-truncated rather than
// leaving the command dead.
export function selectWithinBudget(
  entries: ReadonlyArray<{ path: string; diff: string }>,
  budget: number,
): DiffSelection {
  const files: SelectedFile[] = [];
  const omitted: OmittedFile[] = [];
  let used = 0;
  for (const entry of entries) {
    // Checked before the budget: a binary file's diff is a one-liner that would
    // otherwise sail under the budget and be sent as a contentless block.
    if (!hasHunks(entry.diff)) {
      omitted.push({ path: entry.path, reason: "non-textual" });
      continue;
    }
    if (used + entry.diff.length <= budget) {
      files.push({ path: entry.path, diff: entry.diff });
      used += entry.diff.length;
      continue;
    }
    if (files.length === 0 && used === 0) {
      const truncatedDiff = truncateAtHunkBoundary(entry.diff, budget);
      if (truncatedDiff !== undefined) {
        files.push({
          path: entry.path,
          diff: truncatedDiff.text,
          truncated: { kept: truncatedDiff.keptHunks, total: truncatedDiff.totalHunks },
        });
        used += truncatedDiff.text.length;
        continue;
      }
    }
    omitted.push({ path: entry.path, reason: "too-large" });
  }
  return { files, omitted };
}

// The prompt block: one fenced diff per file under a repo-relative header. The
// truncation marker is part of the prompt on purpose — the agent should know it
// is looking at part of a file.
export function renderDiffBlock(files: readonly SelectedFile[]): string {
  return files
    .map((f) => {
      const mark =
        f.truncated === undefined
          ? ""
          : ` (truncated — ${f.truncated.kept} of ${f.truncated.total} hunks)`;
      return `File: ${f.path}${mark}\n\`\`\`diff\n${f.diff}\n\`\`\``;
    })
    .join("\n\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test -- scm-diff`
Expected: PASS, all describe blocks green.

- [ ] **Step 5: Add the setting to `package.json`**

In `contributes.configuration.properties`, after `nimbus.quickAsk.presets`, add:

```json
"nimbus.scm.skipSecretFiles": {
  "type": "boolean",
  "default": true,
  "description": "Exclude likely-secret files (.env*, *.pem, *.key, id_rsa*, *.p12, *.pfx) from diffs sent to the agent by the Generate Commit Message and Review Changes commands."
}
```

- [ ] **Step 6: Add the typed accessor**

In `src/settings.ts`, add to the `Settings` interface after `quickAskPresets()`:

```ts
  scmSkipSecretFiles(): boolean;
```

and to the returned object after the `quickAskPresets` line:

```ts
    scmSkipSecretFiles: () => cfg().get<boolean>("scm.skipSecretFiles", true),
```

- [ ] **Step 7: Document the setting**

In `docs/settings.md`, add a section after `### nimbus.quickAsk.presets`, matching the surrounding style:

```markdown
### `nimbus.scm.skipSecretFiles`

- **Type:** boolean · **Default:** `true`
- Exclude likely-secret files — `.env*`, `*.pem`, `*.key`, `id_rsa*`, `*.p12`,
  `*.pfx` — from the diffs that **Generate Commit Message** and **Review
  Changes** send to the agent. Skipped files are reported, never dropped
  silently. Turn this off only if you genuinely need those files reviewed.
```

- [ ] **Step 8: Verify the settings-doc guard**

Run: `bun run check-settings-docs && bun run test && bun run typecheck && bun run lint`
Expected: all exit 0.

- [ ] **Step 9: Commit**

```bash
git add src/scm/diff.ts test/unit/scm-diff.test.ts src/settings.ts package.json docs/settings.md
git commit -m "feat(scm): add diff classification, budgeting, and hunk-boundary truncation"
```

---

## Task 3: Commit-message prompt, log filtering, and sanitizing

**Files:**
- Create: `src/scm/commit-message.ts`
- Test: `test/unit/scm-commit-message.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks (pure string work).
- Produces: `COMMIT_LOG_FETCH`, `COMMIT_STYLE_EXAMPLES`, `filterStyleExamples(messages, limit)`, `buildCommitPrompt({ diffBlock, examples })`, `sanitizeCommitMessage(reply)`, `composeInputBoxValue(existing, drafted, mode)`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/scm-commit-message.test.ts`:

```ts
import { describe, expect, test } from "vitest";

import {
  buildCommitPrompt,
  COMMIT_STYLE_EXAMPLES,
  composeInputBoxValue,
  filterStyleExamples,
  sanitizeCommitMessage,
} from "../../src/scm/commit-message.js";

describe("filterStyleExamples", () => {
  test("keeps human subject lines, newest first", () => {
    expect(filterStyleExamples(["feat: a", "fix: b"], 10)).toEqual(["feat: a", "fix: b"]);
  });
  test("uses only the subject line of a multi-line message", () => {
    expect(filterStyleExamples(["feat: a\n\nlong body here"], 10)).toEqual(["feat: a"]);
  });
  test("drops merge commits", () => {
    const out = filterStyleExamples(
      ["Merge branch 'main'", "Merge pull request #3 from x", "Merge remote-tracking branch 'o/m'", "feat: a"],
      10,
    );
    expect(out).toEqual(["feat: a"]);
  });
  test("drops release-automation commits", () => {
    const out = filterStyleExamples(["chore(release): 0.5.0", "chore: release 1.2.3", "Release v2.0.0", "fix: b"], 10);
    expect(out).toEqual(["fix: b"]);
  });
  test("drops dependency bumps", () => {
    const out = filterStyleExamples(
      ["Bump lodash from 1 to 2", "build(deps): bump x", "chore(deps): bump y", "feat: c"],
      10,
    );
    expect(out).toEqual(["feat: c"]);
  });
  test("drops blank messages", () => {
    expect(filterStyleExamples(["", "   ", "feat: a"], 10)).toEqual(["feat: a"]);
  });
  test("caps at the requested limit", () => {
    const many = Array.from({ length: 30 }, (_, i) => `feat: change ${i}`);
    expect(filterStyleExamples(many, COMMIT_STYLE_EXAMPLES)).toHaveLength(COMMIT_STYLE_EXAMPLES);
  });
  test("returns empty when the log is nothing but automation", () => {
    expect(filterStyleExamples(["Merge branch 'x'", "chore(release): 1.0.0"], 10)).toEqual([]);
  });
});

describe("buildCommitPrompt", () => {
  test("includes the diff and the style examples", () => {
    const p = buildCommitPrompt({ diffBlock: "File: a.ts\n```diff\n+a\n```", examples: ["feat: a", "fix: b"] });
    expect(p).toContain("+a");
    expect(p).toContain("feat: a");
    expect(p).toContain("fix: b");
    expect(p).toContain("72");
  });
  test("falls back to a conventional-commit instruction with no examples", () => {
    const p = buildCommitPrompt({ diffBlock: "d", examples: [] });
    expect(p).toContain("Conventional Commits");
    expect(p).not.toContain("Recent commit messages");
  });
  test("asks for the message only, with no commentary", () => {
    expect(buildCommitPrompt({ diffBlock: "d", examples: [] })).toContain("no commentary");
  });
});

describe("sanitizeCommitMessage", () => {
  test("strips a surrounding code fence", () => {
    expect(sanitizeCommitMessage("```\nfeat: a\n```")).toBe("feat: a");
  });
  test("strips a language-tagged fence", () => {
    expect(sanitizeCommitMessage("```text\nfeat: a\n```")).toBe("feat: a");
  });
  test("strips conversational preamble", () => {
    expect(sanitizeCommitMessage("Here's a commit message:\n\nfeat: a")).toBe("feat: a");
    expect(sanitizeCommitMessage("Here is the commit message:\nfix: b")).toBe("fix: b");
  });
  test("keeps a body intact", () => {
    expect(sanitizeCommitMessage("feat: a\n\nWhy this matters.")).toBe("feat: a\n\nWhy this matters.");
  });
  test("trims trailing whitespace on every line", () => {
    expect(sanitizeCommitMessage("feat: a   \n\nbody  \n\n")).toBe("feat: a\n\nbody");
  });
  test("returns empty for a blank reply", () => {
    expect(sanitizeCommitMessage("   \n  ")).toBe("");
  });
  test("does not truncate a long subject", () => {
    const long = `feat: ${"x".repeat(120)}`;
    expect(sanitizeCommitMessage(long)).toBe(long);
  });
});

describe("composeInputBoxValue", () => {
  test("replace discards the existing text", () => {
    expect(composeInputBoxValue("wip", "feat: a", "replace")).toBe("feat: a");
  });
  test("append joins with a blank line", () => {
    expect(composeInputBoxValue("wip", "feat: a", "append")).toBe("wip\n\nfeat: a");
  });
  test("append to an empty box does not add leading blank lines", () => {
    expect(composeInputBoxValue("", "feat: a", "append")).toBe("feat: a");
  });
  test("append trims trailing whitespace on the existing text first", () => {
    expect(composeInputBoxValue("wip\n\n", "feat: a", "append")).toBe("wip\n\nfeat: a");
  });
  test("append is a no-op when the draft is already present", () => {
    expect(composeInputBoxValue("feat: a", "feat: a", "append")).toBe("feat: a");
    expect(composeInputBoxValue("wip\n\nfeat: a", "feat: a", "append")).toBe("wip\n\nfeat: a");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- scm-commit-message`
Expected: FAIL — cannot resolve `../../src/scm/commit-message.js`.

- [ ] **Step 3: Write the implementation**

Create `src/scm/commit-message.ts`:

```ts
// How many log entries to fetch, and how many survivors to actually use. We over-
// fetch because the filter below can discard most of a bot-heavy log.
export const COMMIT_LOG_FETCH = 30;
export const COMMIT_STYLE_EXAMPLES = 10;

// Merges, release automation, and dependency bumps are not the human commit
// style we want the agent to imitate. In a Release-Please repo, unfiltered
// examples are mostly automation and the agent dutifully writes like a bot.
const EXCLUDED_SUBJECTS: readonly RegExp[] = [
  /^Merge (branch|pull request|remote|tag)\b/i,
  /^chore\(release\):/i,
  /^chore: release\b/i,
  /^Release v?\d/i,
  /^Bump\b/i,
  /^build\(deps\):/i,
  /^chore\(deps\):/i,
];

// Subject lines only (first line of each message), newest first, automation
// removed, capped at `limit`.
export function filterStyleExamples(messages: readonly string[], limit: number): string[] {
  const out: string[] = [];
  for (const message of messages) {
    const subject = (message.split("\n")[0] ?? "").trim();
    if (subject.length === 0) continue;
    if (EXCLUDED_SUBJECTS.some((re) => re.test(subject))) continue;
    out.push(subject);
    if (out.length === limit) break;
  }
  return out;
}

export function buildCommitPrompt(input: {
  diffBlock: string;
  examples: readonly string[];
}): string {
  // With examples the agent matches the repo's real style, whatever it is; with
  // none (a fresh repo, or an all-automation log) we fall back to a convention.
  const style =
    input.examples.length > 0
      ? `Match the style of these recent commit messages from this repository:\n${input.examples
          .map((e) => `- ${e}`)
          .join("\n")}`
      : "Follow the Conventional Commits format (e.g. `feat(scope): summary`).";
  return [
    "Write a commit message for the following staged changes.",
    style,
    "Keep the subject line under 72 characters. Add a short body only if the change needs explaining.",
    "Reply with the commit message only — no commentary, no code fences.",
    "",
    input.diffBlock,
  ].join("\n");
}

// Agents like to wrap the answer in a fence and introduce it. Strip both, then
// trim trailing whitespace per line. Deliberately no length enforcement:
// truncating a message mid-word is worse than a long one.
export function sanitizeCommitMessage(reply: string): string {
  let text = reply.trim();
  const fenced = /^```[^\n]*\n([\s\S]*?)\n?```$/.exec(text);
  if (fenced?.[1] !== undefined) text = fenced[1];
  text = text.replace(/^(here(''|'|)s|here is)[^\n:]*:\s*\n+/i, "");
  return text
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .join("\n")
    .trim();
}

export function composeInputBoxValue(
  existing: string,
  drafted: string,
  mode: "replace" | "append",
): string {
  if (mode === "replace") return drafted;
  const base = existing.replace(/\s+$/, "");
  if (base.length === 0) return drafted;
  // Running the command twice and appending the same draft again is never what
  // anyone wants, so an append that would duplicate is a no-op.
  if (base.includes(drafted)) return base;
  return `${base}\n\n${drafted}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test -- scm-commit-message`
Expected: PASS.

- [ ] **Step 5: Verify the gate**

Run: `bun run typecheck && bun run lint`
Expected: both exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/scm/commit-message.ts test/unit/scm-commit-message.test.ts
git commit -m "feat(scm): add commit-message prompt, log filtering, and sanitizing"
```

---

## Task 4: Review prompt and coverage-headed document

**Files:**
- Create: `src/scm/review.ts`
- Test: `test/unit/scm-review.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `ReviewCoverage` interface, `buildReviewPrompt(diffBlock)`, `buildReviewDocument(coverage, findings)`.

The coverage header is the load-bearing part: a user must never read this tab and wrongly conclude an untracked or skipped file was reviewed.

- [ ] **Step 1: Write the failing test**

Create `test/unit/scm-review.test.ts`:

```ts
import { describe, expect, test } from "vitest";

import { buildReviewDocument, buildReviewPrompt, type ReviewCoverage } from "../../src/scm/review.js";

const coverage = (over: Partial<ReviewCoverage> = {}): ReviewCoverage => ({
  repoLabel: "nimbus-vscode",
  reviewed: ["src/a.ts"],
  omittedTooLarge: [],
  skippedSecret: [],
  nonTextual: [],
  untracked: [],
  ...over,
});

describe("buildReviewPrompt", () => {
  test("includes the diff", () => {
    expect(buildReviewPrompt("File: a.ts\n```diff\n+a\n```")).toContain("+a");
  });
  test("asks for a fixed shape: summary then findings by file with severity", () => {
    const p = buildReviewPrompt("d");
    expect(p).toContain("summary");
    expect(p).toContain("grouped by file");
    expect(p).toContain("severity");
  });
});

describe("buildReviewDocument", () => {
  test("names the repo and the reviewed files", () => {
    const doc = buildReviewDocument(coverage(), "No issues found.");
    expect(doc).toContain("nimbus-vscode");
    expect(doc).toContain("src/a.ts");
    expect(doc).toContain("No issues found.");
  });
  test("names untracked files so they are never mistaken for reviewed", () => {
    const doc = buildReviewDocument(coverage({ untracked: ["src/new.ts"] }), "f");
    expect(doc).toContain("Not reviewed — untracked");
    expect(doc).toContain("src/new.ts");
  });
  test("names files skipped as secret-bearing", () => {
    const doc = buildReviewDocument(coverage({ skippedSecret: [".env"] }), "f");
    expect(doc).toContain("Not reviewed — possible secrets");
    expect(doc).toContain(".env");
  });
  test("names files omitted for size", () => {
    const doc = buildReviewDocument(coverage({ omittedTooLarge: ["big.ts"] }), "f");
    expect(doc).toContain("Not reviewed — too large");
    expect(doc).toContain("big.ts");
  });
  test("names binary and non-textual changes distinctly from too-large ones", () => {
    const doc = buildReviewDocument(coverage({ nonTextual: ["logo.png"] }), "f");
    expect(doc).toContain("Not reviewed — binary or non-textual changes");
    expect(doc).toContain("logo.png");
    expect(doc).not.toContain("too large");
  });
  test("omits each not-reviewed section entirely when it is empty", () => {
    const doc = buildReviewDocument(coverage(), "f");
    expect(doc).not.toContain("Not reviewed");
  });
  test("puts the findings after the header", () => {
    const doc = buildReviewDocument(coverage(), "FINDINGS-MARKER");
    expect(doc.indexOf("nimbus-vscode")).toBeLessThan(doc.indexOf("FINDINGS-MARKER"));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- scm-review`
Expected: FAIL — cannot resolve `../../src/scm/review.js`.

- [ ] **Step 3: Write the implementation**

Create `src/scm/review.ts`:

```ts
export interface ReviewCoverage {
  // Basename only — the absolute repo root is never displayed or sent.
  repoLabel: string;
  reviewed: readonly string[];
  omittedTooLarge: readonly string[];
  skippedSecret: readonly string[];
  // Binary files, pure renames, mode changes — nothing textual to review.
  nonTextual: readonly string[];
  // Content is never sent; named here so the user knows they were not reviewed.
  untracked: readonly string[];
}

export function buildReviewPrompt(diffBlock: string): string {
  return [
    "Review the following changes and report problems you are confident about.",
    "Structure the reply as: a one-paragraph summary, then findings grouped by file.",
    "Tag each finding with a severity of high, medium, or low. If there are no problems, say so plainly.",
    "",
    diffBlock,
  ].join("\n");
}

function section(title: string, paths: readonly string[]): string {
  if (paths.length === 0) return "";
  return `\n**${title}:** ${paths.map((p) => `\`${p}\``).join(", ")}\n`;
}

// The reply is never parsed — the shape instruction above exists so the tab
// reads the same every time. This header is ours, and it is the mechanism that
// stops a user assuming an untracked or skipped file was covered.
export function buildReviewDocument(coverage: ReviewCoverage, findings: string): string {
  const reviewed =
    coverage.reviewed.length > 0
      ? coverage.reviewed.map((p) => `\`${p}\``).join(", ")
      : "_nothing_";
  return [
    `# Nimbus review — ${coverage.repoLabel}`,
    "",
    `**Reviewed (${coverage.reviewed.length} file${coverage.reviewed.length === 1 ? "" : "s"}):** ${reviewed}`,
    section("Not reviewed — too large", coverage.omittedTooLarge),
    section("Not reviewed — possible secrets", coverage.skippedSecret),
    section("Not reviewed — binary or non-textual changes", coverage.nonTextual),
    section("Not reviewed — untracked", coverage.untracked),
    "",
    "---",
    "",
    findings,
    "",
  ].join("\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test -- scm-review`
Expected: PASS.

- [ ] **Step 5: Verify the gate**

Run: `bun run typecheck && bun run lint`
Expected: both exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/scm/review.ts test/unit/scm-review.test.ts
git commit -m "feat(scm): add review prompt and coverage-headed findings document"
```

---

## Task 5: Test/docstring generation logic

**Files:**
- Create: `src/scm/generate.ts`
- Test: `test/unit/scm-generate.test.ts`

**Interfaces:**
- Consumes: `buildQuickAskPrompt` from `src/quick-ask.js`.
- Produces: `deriveTestFileName(sourcePath)`, `extractCode(reply)`, `spliceSelection(full, start, end, replacement)`, `buildTestsPrompt(input)`, `buildDocstringsPrompt(input)`.

`buildTestsPrompt` / `buildDocstringsPrompt` delegate to `buildQuickAskPrompt` — same fenced-context shape as Quick Ask, only the question differs. Do not reimplement it.

- [ ] **Step 1: Write the failing test**

Create `test/unit/scm-generate.test.ts`:

```ts
import { describe, expect, test } from "vitest";

import {
  buildDocstringsPrompt,
  buildTestsPrompt,
  deriveTestFileName,
  extractCode,
  isWholeFileRewrite,
  spliceSelection,
} from "../../src/scm/generate.js";

describe("deriveTestFileName", () => {
  test("uses the language's conventional test name", () => {
    expect(deriveTestFileName("src/quick-ask.ts")).toBe("quick-ask.test.ts");
    expect(deriveTestFileName("src/main.tsx")).toBe("main.test.tsx");
    expect(deriveTestFileName("app/helpers.py")).toBe("test_helpers.py");
    expect(deriveTestFileName("src/Widget.java")).toBe("WidgetTest.java");
    expect(deriveTestFileName("lib/thing.rb")).toBe("thing_spec.rb");
    expect(deriveTestFileName("pkg/server.go")).toBe("server_test.go");
  });
  test("falls back to <base>.test.<ext> for unknown extensions", () => {
    expect(deriveTestFileName("src/a.zig")).toBe("a.test.zig");
  });
  test("takes only the basename, never the directory", () => {
    expect(deriveTestFileName("/home/dev/secret-project/src/a.ts")).toBe("a.test.ts");
    expect(deriveTestFileName("C:\\Users\\dev\\src\\a.ts")).toBe("a.test.ts");
  });
  test("handles dotted names", () => {
    expect(deriveTestFileName("src/a.config.ts")).toBe("a.config.test.ts");
  });
  test("handles an extensionless file", () => {
    expect(deriveTestFileName("scripts/build")).toBe("build.test");
  });
  test("degrades gracefully for an unsaved buffer (fileName is 'Untitled-1')", () => {
    // VS Code reports a bare label, not a path, for untitled documents. No
    // throw, no path leak, just an extensionless name the user renames on Save.
    expect(deriveTestFileName("Untitled-1")).toBe("Untitled-1.test");
  });
  test("handles a dotfile with no extension", () => {
    expect(deriveTestFileName(".gitignore")).toBe(".gitignore.test");
  });
});

describe("extractCode", () => {
  test("returns the contents of a fenced block", () => {
    expect(extractCode("Sure:\n```ts\nconst a = 1;\n```\nHope that helps")).toBe("const a = 1;");
  });
  test("returns the first block when there are several", () => {
    expect(extractCode("```ts\nA\n```\ntext\n```ts\nB\n```")).toBe("A");
  });
  test("falls back to the whole reply when there is no fence", () => {
    expect(extractCode("const a = 1;")).toBe("const a = 1;");
  });
  test("preserves indentation inside the block", () => {
    expect(extractCode("```python\ndef f():\n    return 1\n```")).toBe("def f():\n    return 1");
  });
});

describe("spliceSelection", () => {
  test("replaces the selected range", () => {
    expect(spliceSelection("abcdef", 2, 4, "XY")).toBe("abXYef");
  });
  test("handles a selection at the start", () => {
    expect(spliceSelection("abcdef", 0, 2, "X")).toBe("Xcdef");
  });
  test("handles a selection at the end", () => {
    expect(spliceSelection("abcdef", 4, 6, "X")).toBe("abcdX");
  });
  test("handles an empty selection as an insertion", () => {
    expect(spliceSelection("abcdef", 3, 3, "X")).toBe("abcXdef");
  });
  test("clamps out-of-range offsets rather than producing undefined slices", () => {
    expect(spliceSelection("abc", -5, 99, "X")).toBe("X");
  });
});

describe("isWholeFileRewrite", () => {
  const full = "import { thing } from './somewhere-else';\nconst selected = 1;\nexport default selected;\n";
  const start = full.indexOf("const selected");
  const end = start + "const selected = 1;".length;

  test("is false for an honest selection-only rewrite", () => {
    expect(isWholeFileRewrite("// doc\nconst selected = 1;", full, start, end)).toBe(false);
  });
  test("is true when the reply echoes a line from before the selection", () => {
    const whole = "import { thing } from './somewhere-else';\n// doc\nconst selected = 1;";
    expect(isWholeFileRewrite(whole, full, start, end)).toBe(true);
  });
  test("is true when the reply echoes a line from after the selection", () => {
    const whole = "// doc\nconst selected = 1;\nexport default selected;";
    expect(isWholeFileRewrite(whole, full, start, end)).toBe(true);
  });
  test("ignores short lines that recur everywhere", () => {
    const braces = "function f() {\n}\nconst selected = 1;\n}\n";
    const s = braces.indexOf("const selected");
    expect(isWholeFileRewrite("// doc\nconst selected = 1;\n}", braces, s, s + 19)).toBe(false);
  });
  test("is false when the selection is the whole document", () => {
    expect(isWholeFileRewrite("// doc\n".concat(full), full, 0, full.length)).toBe(false);
  });
});

describe("prompts", () => {
  test("the tests prompt asks for a runnable suite and includes the code", () => {
    const p = buildTestsPrompt({ code: "const a = 1;", filePath: "a.ts", languageId: "typescript" });
    expect(p).toContain("const a = 1;");
    expect(p).toContain("File: a.ts (typescript)");
    expect(p.toLowerCase()).toContain("test");
  });
  test("the docstrings prompt asks for the same code back with docs added", () => {
    const p = buildDocstringsPrompt({ code: "def f(): pass", filePath: "a.py", languageId: "python" });
    expect(p).toContain("def f(): pass");
    expect(p.toLowerCase()).toContain("unchanged");
  });
  test("both mark a truncated context", () => {
    const p = buildTestsPrompt({ code: "x", filePath: "a.ts", languageId: "typescript", truncated: true });
    expect(p).toContain("(truncated)");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- scm-generate`
Expected: FAIL — cannot resolve `../../src/scm/generate.js`.

- [ ] **Step 3: Write the implementation**

Create `src/scm/generate.ts`:

```ts
import { buildQuickAskPrompt } from "../quick-ask.js";

// Conventional test filenames per language. The value is a template over the
// base name; anything not listed falls back to `<base>.test.<ext>`.
const TEST_NAME_BY_EXT: Readonly<Record<string, (base: string, ext: string) => string>> = {
  py: (base) => `test_${base}.py`,
  java: (base) => `${base}Test.java`,
  kt: (base) => `${base}Test.kt`,
  rb: (base) => `${base}_spec.rb`,
  go: (base) => `${base}_test.go`,
};

// Name only — never a directory. The buffer opens untitled, so Save presents a
// location picker and the user places it; guessing the directory would need
// filesystem probing for very little gain.
export function deriveTestFileName(sourcePath: string): string {
  const fileName = sourcePath.split(/[\\/]/).at(-1) ?? sourcePath;
  const dot = fileName.lastIndexOf(".");
  if (dot <= 0) return `${fileName}.test`;
  const base = fileName.slice(0, dot);
  const ext = fileName.slice(dot + 1);
  const special = TEST_NAME_BY_EXT[ext];
  return special === undefined ? `${base}.test.${ext}` : special(base, ext);
}

// Agents wrap code in a fence and often add prose around it. Take the first
// fenced block; if there is none, assume the whole reply is bare code.
export function extractCode(reply: string): string {
  const fenced = /```[^\n]*\n([\s\S]*?)```/.exec(reply);
  const inner = fenced?.[1];
  if (inner === undefined) return reply.trim();
  return inner.replace(/\n$/, "");
}

// Rebuild a whole document with the selected range replaced, so the docstrings
// diff shows only the annotated region instead of a whole-file mismatch.
// Offsets are clamped: a stale selection must not silently produce garbage.
export function spliceSelection(
  full: string,
  start: number,
  end: number,
  replacement: string,
): string {
  const lo = Math.max(0, Math.min(start, full.length));
  const hi = Math.max(lo, Math.min(end, full.length));
  return full.slice(0, lo) + replacement + full.slice(hi);
}

// Agents asked to annotate a selection sometimes return the WHOLE file instead
// — helpfully, in their view. Splicing a whole-file reply into a selection's
// offsets duplicates everything around it and produces a nonsense diff.
//
// The signal is crisp and needs no guessing: if the reply repeats a non-empty
// line that lives OUTSIDE the selection, it is not a selection rewrite. The
// caller then diffs whole-file instead of splicing — which is exactly what the
// user wants when the agent returned a whole file.
export function isWholeFileRewrite(
  rewritten: string,
  fullText: string,
  start: number,
  end: number,
): boolean {
  const outside = [fullText.slice(0, start), fullText.slice(end)];
  for (const region of outside) {
    for (const line of region.split("\n")) {
      const trimmed = line.trim();
      // Short lines ("}", ")") recur everywhere and would false-positive.
      if (trimmed.length < 12) continue;
      if (rewritten.includes(trimmed)) return true;
    }
  }
  return false;
}

interface GeneratePromptInput {
  code: string;
  filePath: string;
  languageId: string;
  truncated?: boolean;
}

// Both reuse quick-ask's fenced-context builder; only the instruction differs.
function build(question: string, input: GeneratePromptInput): string {
  return buildQuickAskPrompt({
    question,
    code: input.code,
    filePath: input.filePath,
    languageId: input.languageId,
    ...(input.truncated === true ? { truncated: true } : {}),
  });
}

export function buildTestsPrompt(input: GeneratePromptInput): string {
  return build(
    [
      "Write a complete, runnable test suite for the following code.",
      "Use the testing framework and conventions idiomatic to this language.",
      "Cover the meaningful edge cases, not just the happy path.",
      "Reply with the test file contents only, in a single fenced code block.",
    ].join(" "),
    input,
  );
}

export function buildDocstringsPrompt(input: GeneratePromptInput): string {
  return build(
    [
      "Add documentation comments to the following code.",
      "Return the same code with docs added and the logic left unchanged —",
      "do not rename, reformat, or restructure anything.",
      "Reply with the code only, in a single fenced code block.",
    ].join(" "),
    input,
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test -- scm-generate`
Expected: PASS.

- [ ] **Step 5: Verify the gate**

Run: `bun run typecheck && bun run lint`
Expected: both exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/scm/generate.ts test/unit/scm-generate.test.ts
git commit -m "feat(scm): add test/docstring generation logic"
```

---

## Task 6: Command orchestration — Generate Commit Message

**Files:**
- Create: `src/scm/commands.ts`
- Test: `test/unit/scm-commands.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–3.
- Produces: `ScmClientLike`, `ScmCommandDeps`, `createScmCommands(deps)` returning `{ generateCommitMessage(): Promise<void>; reviewChanges(): Promise<void>; generateTests(): Promise<void>; generateDocstrings(): Promise<void> }`, and the internal-but-exported `collectDiff(repo, scope, skipSecrets)` used by Tasks 6–7.

Tasks 7 and 8 add the other three handlers to this same file. Define all four now — `reviewChanges`, `generateTests`, and `generateDocstrings` start as `async () => undefined` stubs so the object shape is stable and later tasks only fill bodies.

- [ ] **Step 1: Write the failing test**

Create `test/unit/scm-commands.test.ts`:

```ts
import { describe, expect, test } from "vitest";

import type { Logger } from "../../src/logging.js";
import { createScmCommands, type ScmCommandDeps } from "../../src/scm/commands.js";
import type { ChangedFile, DiffScope, GitApiLike, GitRepositoryLike } from "../../src/scm/git-types.js";

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

function harness(over: Partial<ScmCommandDeps> = {}, repos: GitRepositoryLike[] = [fakeRepo()]): Harness {
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- scm-commands`
Expected: FAIL — cannot resolve `../../src/scm/commands.js`.

- [ ] **Step 3: Write the implementation**

Create `src/scm/commands.ts`:

```ts
import { errMsg, type Logger } from "../logging.js";
import { extractReply } from "../quick-ask.js";
import { PROGRESS_LOCATION_NOTIFICATION, type WindowApi } from "../vscode-shim.js";
import {
  buildCommitPrompt,
  COMMIT_LOG_FETCH,
  COMMIT_STYLE_EXAMPLES,
  composeInputBoxValue,
  filterStyleExamples,
  sanitizeCommitMessage,
} from "./commit-message.js";
import {
  type OmittedFile,
  orderFiles,
  renderDiffBlock,
  SCM_MAX_DIFF_CHARS,
  selectWithinBudget,
} from "./diff.js";
import type { DiffScope, GitRepositoryLike } from "./git-types.js";
import { classifyRepositories, findRepoByRoot, repoLabel } from "./repo-select.js";

export interface ScmClientLike {
  agentInvoke(input: string, opts: { stream: boolean; agent?: string }): Promise<unknown>;
}

export interface ScmCommandDeps {
  git(): Promise<import("./git-types.js").GitApiLike | undefined>;
  client(): ScmClientLike | undefined; // undefined = disconnected
  window: WindowApi;
  agent(): string; // askAgent() setting; "" = omit
  skipSecretFiles(): boolean;
  // Character offsets of the active selection, or undefined when there is no
  // editor or the selection is empty. Supplied by extension.ts glue.
  selectionOffsets(): { start: number; end: number } | undefined;
  openReadonly(title: string, content: string): Promise<void>;
  openUntitled(opts: { fileName: string; content: string }): Promise<void>;
  // fileName is the redacted basename (e.g. "a.ts"); the opener puts it in both
  // virtual URIs so VS Code infers the language from the extension natively.
  openDiff(opts: { title: string; left: string; right: string; fileName: string }): Promise<void>;
  log: Logger;
}

export interface CollectedDiff {
  block: string;
  reviewed: string[];
  omittedTooLarge: string[];
  skippedSecret: string[];
  nonTextual: string[];
  /** True when git reported no changed files at all for this scope. */
  empty: boolean;
}

// List → classify/order → fetch each file's diff → budget-select → render.
// Nothing here parses a unified diff: paths come from git, not from headers.
export async function collectDiff(
  repo: GitRepositoryLike,
  scope: DiffScope,
  skipSecrets: boolean,
): Promise<CollectedDiff> {
  const changed = await repo.changedFiles(scope);
  if (changed.length === 0) {
    return {
      block: "",
      reviewed: [],
      omittedTooLarge: [],
      skippedSecret: [],
      nonTextual: [],
      empty: true,
    };
  }
  const { ordered, omitted } = orderFiles(changed, { skipSecrets });
  const entries: Array<{ path: string; diff: string }> = [];
  for (const file of ordered) {
    entries.push({ path: file.path, diff: await repo.fileDiff(scope, file.path) });
  }
  const selection = selectWithinBudget(entries, SCM_MAX_DIFF_CHARS);
  const all: OmittedFile[] = [...omitted, ...selection.omitted];
  const withReason = (...reasons: OmittedFile["reason"][]): string[] =>
    all.filter((o) => reasons.includes(o.reason)).map((o) => o.path);
  return {
    block: renderDiffBlock(selection.files),
    reviewed: selection.files.map((f) => f.path),
    // The file cap is a size-driven omission too, so it shares the bucket.
    omittedTooLarge: withReason("too-large", "file-cap"),
    skippedSecret: withReason("secret"),
    nonTextual: withReason("non-textual"),
    empty: false,
  };
}

export function createScmCommands(deps: ScmCommandDeps): {
  generateCommitMessage(): Promise<void>;
  reviewChanges(): Promise<void>;
  generateTests(): Promise<void>;
  generateDocstrings(): Promise<void>;
} {
  // Resolve the git API and pick a repository, reporting each failure mode.
  // Returns undefined when the caller should stop.
  const resolveRepo = async (): Promise<GitRepositoryLike | undefined> => {
    const api = await deps.git();
    if (api === undefined) {
      void deps.window.showErrorMessage(
        "Nimbus: the built-in Git extension is disabled — enable it to use this command.",
      );
      return undefined;
    }
    const choice = classifyRepositories(api.repositories());
    if (choice.kind === "none") {
      void deps.window.showErrorMessage("Nimbus: no Git repository in this workspace.");
      return undefined;
    }
    if (choice.kind === "one") return choice.repo;
    const picked = await deps.window.showQuickPick(
      choice.repos.map((repo) => ({ label: repoLabel(repo), repo })),
      { placeHolder: "Pick a repository" },
    );
    return picked?.repo;
  };

  // Connection is checked before any diff is read, so a disconnected Gateway
  // costs nothing and reports the real problem.
  const requireClient = (): ScmClientLike | undefined => {
    const client = deps.client();
    if (client === undefined) {
      void deps.window.showErrorMessage("Nimbus: not connected to Gateway.");
    }
    return client;
  };

  const warnOmissions = (collected: CollectedDiff, total: number): void => {
    if (collected.omittedTooLarge.length > 0) {
      void deps.window.showWarningMessage(
        `Nimbus: ${collected.omittedTooLarge.length} of ${total} files omitted — diff too large.`,
      );
    }
    if (collected.skippedSecret.length > 0) {
      void deps.window.showWarningMessage(
        `Nimbus: skipped ${collected.skippedSecret.length} possible secret file(s): ${collected.skippedSecret.join(", ")}.`,
      );
    }
  };

  const invoke = async (client: ScmClientLike, prompt: string, title: string): Promise<string | undefined> => {
    const agent = deps.agent();
    const options: { stream: boolean; agent?: string } = { stream: false };
    if (agent.length > 0) options.agent = agent;
    deps.log.debug(`scm: sending ${prompt.length} chars to agentInvoke`);
    const result = await deps.window.withProgress({ location: PROGRESS_LOCATION_NOTIFICATION, title }, () =>
      client.agentInvoke(prompt, options),
    );
    const reply = extractReply(result);
    if (reply === undefined) {
      void deps.window.showInformationMessage("Nimbus: the agent returned no reply.", {});
    }
    return reply;
  };

  return {
    async generateCommitMessage(): Promise<void> {
      const repo = await resolveRepo();
      if (repo === undefined) return;
      const client = requireClient();
      if (client === undefined) return;
      try {
        const collected = await collectDiff(repo, "staged", deps.skipSecretFiles());
        if (collected.empty) {
          void deps.window.showErrorMessage("Nimbus: nothing staged to describe.");
          return;
        }
        if (collected.reviewed.length === 0) {
          // Say which reason actually applied — "too large" for a staged PNG
          // would be a lie the user cannot act on.
          const reason =
            collected.skippedSecret.length > 0
              ? "every staged file was skipped as possibly secret-bearing"
              : collected.nonTextual.length > 0 && collected.omittedTooLarge.length === 0
                ? "the staged changes are binary or non-textual"
                : "the staged diff is too large to summarise";
          void deps.window.showErrorMessage(`Nimbus: ${reason}.`);
          return;
        }
        warnOmissions(collected, collected.reviewed.length + collected.omittedTooLarge.length);
        const examples = filterStyleExamples(await repo.log(COMMIT_LOG_FETCH), COMMIT_STYLE_EXAMPLES);
        const prompt = buildCommitPrompt({ diffBlock: collected.block, examples });
        const reply = await invoke(client, prompt, "Nimbus: drafting commit message…");
        if (reply === undefined) return;
        const message = sanitizeCommitMessage(reply);
        if (message.length === 0) {
          void deps.window.showInformationMessage("Nimbus: the agent returned no reply.", {});
          return;
        }
        // agentInvoke is uncancellable and can run a while; the folder may have
        // closed meanwhile. Re-find the repo before writing, and never drop the
        // draft on the floor if it is gone.
        const api = await deps.git();
        const live = api === undefined ? undefined : findRepoByRoot(api.repositories(), repo.rootPath);
        if (live === undefined) {
          void deps.window.showWarningMessage(
            "Nimbus: that repository closed while the message was being drafted — showing the draft instead.",
          );
          await deps.openReadonly("Nimbus commit message.md", message);
          return;
        }
        if (live.inputBox.value.trim().length === 0) {
          live.inputBox.value = message;
          return;
        }
        const answer = await deps.window.showWarningMessage(
          "The Source Control message box already has text.",
          { modal: true },
          "Replace",
          "Append",
        );
        if (answer !== "Replace" && answer !== "Append") return;
        live.inputBox.value = composeInputBoxValue(
          live.inputBox.value,
          message,
          answer === "Replace" ? "replace" : "append",
        );
      } catch (e) {
        deps.log.error(`nimbus.generateCommitMessage failed: ${errMsg(e)}`);
        void deps.window.showErrorMessage(`Nimbus commit message failed: ${errMsg(e)}`);
      }
    },

    async reviewChanges(): Promise<void> {
      return undefined; // Task 7
    },

    async generateTests(): Promise<void> {
      return undefined; // Task 8
    },

    async generateDocstrings(): Promise<void> {
      return undefined; // Task 8
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test -- scm-commands`
Expected: PASS, 16 tests.

- [ ] **Step 5: Verify the gate**

Run: `bun run test && bun run typecheck && bun run lint`
Expected: all exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/scm/commands.ts test/unit/scm-commands.test.ts
git commit -m "feat(scm): add Generate Commit Message command"
```

---

## Task 7: Review Changes command

**Files:**
- Modify: `src/scm/commands.ts` (replace the `reviewChanges` stub)
- Modify: `test/unit/scm-commands.test.ts` (append a `describe`)

**Interfaces:**
- Consumes: `collectDiff`, `resolveRepo`/`requireClient`/`invoke`/`warnOmissions` (already in the closure), `buildReviewPrompt`/`buildReviewDocument`/`ReviewCoverage` from Task 4, `repoLabel` from Task 1.
- Produces: no new exports.

- [ ] **Step 1: Write the failing test**

Append to `test/unit/scm-commands.test.ts`:

```ts
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
    const binary = "diff --git a/logo.png b/logo.png\nBinary files a/logo.png and b/logo.png differ\n";
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

  test("errors when disconnected", async () => {
    const h = harness({ client: () => undefined });
    await createScmCommands(h.deps).reviewChanges();
    expect(h.errors[0]).toContain("not connected");
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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- scm-commands`
Expected: FAIL — the `reviewChanges` stub opens nothing, so `h.opened[0]` is undefined.

- [ ] **Step 3: Add the imports**

In `src/scm/commands.ts`, add to the import block:

```ts
import { buildReviewDocument, buildReviewPrompt, type ReviewCoverage } from "./review.js";
```

- [ ] **Step 4: Replace the stub**

Replace the `reviewChanges` stub body with:

```ts
    async reviewChanges(): Promise<void> {
      const repo = await resolveRepo();
      if (repo === undefined) return;
      const client = requireClient();
      if (client === undefined) return;
      try {
        // Scope "all": staged and unstaged together. "Review my changes"
        // returning nothing because the user staged their work first would be a
        // bad first experience.
        const collected = await collectDiff(repo, "all", deps.skipSecretFiles());
        if (collected.empty) {
          void deps.window.showInformationMessage("Nimbus: no local changes to review.", {});
          return;
        }
        if (collected.reviewed.length === 0) {
          void deps.window.showErrorMessage(
            "Nimbus: nothing reviewable — every changed file was skipped or too large.",
          );
          return;
        }
        warnOmissions(collected, collected.reviewed.length + collected.omittedTooLarge.length);
        const reply = await invoke(
          client,
          buildReviewPrompt(collected.block),
          "Nimbus: reviewing changes…",
        );
        if (reply === undefined) return;
        // Untracked content is never sent — only counted and named here, so the
        // reader cannot mistake a brand-new file for a reviewed one.
        const coverage: ReviewCoverage = {
          repoLabel: repoLabel(repo),
          reviewed: collected.reviewed,
          omittedTooLarge: collected.omittedTooLarge,
          skippedSecret: collected.skippedSecret,
          nonTextual: collected.nonTextual,
          untracked: await repo.untrackedPaths(),
        };
        await deps.openReadonly("Nimbus review.md", buildReviewDocument(coverage, reply));
      } catch (e) {
        deps.log.error(`nimbus.reviewChanges failed: ${errMsg(e)}`);
        void deps.window.showErrorMessage(`Nimbus review failed: ${errMsg(e)}`);
      }
    },
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun run test -- scm-commands`
Expected: PASS, all `generateCommitMessage` and `reviewChanges` tests green.

- [ ] **Step 6: Verify the gate**

Run: `bun run test && bun run typecheck && bun run lint`
Expected: all exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/scm/commands.ts test/unit/scm-commands.test.ts
git commit -m "feat(scm): add Review Changes command"
```

---

## Task 8: Generate Tests and Generate Docstrings commands

**Files:**
- Modify: `src/scm/commands.ts` (replace both remaining stubs)
- Modify: `test/unit/scm-commands.test.ts` (append a `describe`)

**Interfaces:**
- Consumes: `deriveTestFileName`, `extractCode`, `spliceSelection`, `buildTestsPrompt`, `buildDocstringsPrompt` from Task 5; `clampContext`, `QUICK_ASK_MAX_CONTEXT_CHARS`, `redactPath` from `src/quick-ask.js`; `deps.selectionOffsets`, `deps.openUntitled`, `deps.openDiff`.
- Produces: no new exports.

These two commands need no git access at all — they operate on the active editor. They live here because they share the connection, progress, and reply-handling plumbing.

- [ ] **Step 1: Write the failing test**

Append to `test/unit/scm-commands.test.ts`:

```ts
interface FakeEditorOpts {
  text?: string;
  fileName?: string;
  languageId?: string;
  selectionText?: string;
}

function editorDeps(opts: FakeEditorOpts = {}): Partial<ScmCommandDeps> {
  const text = opts.text ?? "const a = 1;\nconst b = 2;\n";
  const selectionText = opts.selectionText;
  return {
    window: {
      showErrorMessage: async () => undefined,
      showWarningMessage: async () => undefined,
      showInformationMessage: async () => undefined,
      showQuickPick: async () => undefined,
      withProgress: async <R>(_o: unknown, task: () => Promise<R>) => task(),
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
});

describe("generateDocstrings", () => {
  test("diffs the original against the annotated whole file", async () => {
    const diffs: Array<{ title: string; left: string; right: string; fileName: string }> = [];
    const h = harness({
      ...editorDeps({ text: "def f(): pass\n", languageId: "python", fileName: "/p/a.py" }),
      client: () => ({ agentInvoke: async () => ({ reply: "```python\ndef f():\n    \"\"\"Doc.\"\"\"\n    pass\n```" }) }),
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
    const full = "import { thing } from './somewhere-else';\nconst selected = 1;\nexport default selected;\n";
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- scm-commands`
Expected: FAIL — both stubs are no-ops, so nothing is opened.

- [ ] **Step 3: Add the imports**

In `src/scm/commands.ts`, add:

```ts
import { clampContext, QUICK_ASK_MAX_CONTEXT_CHARS, redactPath } from "../quick-ask.js";
import {
  buildDocstringsPrompt,
  buildTestsPrompt,
  deriveTestFileName,
  extractCode,
  isWholeFileRewrite,
  spliceSelection,
} from "./generate.js";
```

Merge the `../quick-ask.js` import with the existing `extractReply` one rather than adding a second import from the same module.

- [ ] **Step 4: Add a shared editor-context helper**

Inside `createScmCommands`, above the returned object, add:

```ts
  // Selection when there is one, whole file otherwise — the same rule Quick Ask
  // uses. Paths we add are always redacted to a basename.
  const readEditorContext = ():
    | {
        code: string;
        truncated: boolean;
        fullText: string;
        fileName: string;
        languageId: string;
        hasSelection: boolean;
      }
    | undefined => {
    const editor = deps.window.activeTextEditor;
    if (editor === undefined) {
      void deps.window.showErrorMessage("Nimbus: open a file first.");
      return undefined;
    }
    const selectionText = editor.selection.isEmpty
      ? ""
      : editor.document.getText(editor.selection);
    const hasSelection = selectionText.trim().length > 0;
    const fullText = editor.document.getText();
    const { code, truncated } = clampContext(
      hasSelection ? selectionText : fullText,
      QUICK_ASK_MAX_CONTEXT_CHARS,
    );
    if (truncated) {
      void deps.window.showWarningMessage(
        `Nimbus: context truncated to ${QUICK_ASK_MAX_CONTEXT_CHARS} characters.`,
      );
    }
    return {
      code,
      truncated,
      fullText,
      fileName: editor.document.fileName,
      languageId: editor.document.languageId,
      hasSelection,
    };
  };
```

- [ ] **Step 5: Replace both stubs**

```ts
    async generateTests(): Promise<void> {
      const ctx = readEditorContext();
      if (ctx === undefined) return;
      const client = requireClient();
      if (client === undefined) return;
      try {
        const prompt = buildTestsPrompt({
          code: ctx.code,
          filePath: redactPath(ctx.fileName),
          languageId: ctx.languageId,
          ...(ctx.truncated ? { truncated: true } : {}),
        });
        const reply = await invoke(client, prompt, "Nimbus: generating tests…");
        if (reply === undefined) return;
        // Untitled: nothing touches disk, and Save presents a location picker.
        await deps.openUntitled({
          fileName: deriveTestFileName(ctx.fileName),
          content: extractCode(reply),
        });
      } catch (e) {
        deps.log.error(`nimbus.generateTests failed: ${errMsg(e)}`);
        void deps.window.showErrorMessage(`Nimbus generate tests failed: ${errMsg(e)}`);
      }
    },

    async generateDocstrings(): Promise<void> {
      const ctx = readEditorContext();
      if (ctx === undefined) return;
      const client = requireClient();
      if (client === undefined) return;
      try {
        const prompt = buildDocstringsPrompt({
          code: ctx.code,
          filePath: redactPath(ctx.fileName),
          languageId: ctx.languageId,
          ...(ctx.truncated ? { truncated: true } : {}),
        });
        const reply = await invoke(client, prompt, "Nimbus: generating docstrings…");
        if (reply === undefined) return;
        const rewritten = extractCode(reply);
        const offsets = ctx.hasSelection ? deps.selectionOffsets() : undefined;
        // A selection rewrite is spliced back into the full document, so the
        // diff shows only the annotated region rather than a whole-file
        // mismatch. Without offsets we cannot splice honestly, so fall back to
        // a read-only tab rather than showing a misleading diff.
        if (ctx.hasSelection && offsets === undefined) {
          await deps.openReadonly("Nimbus docstrings.md", rewritten);
          return;
        }
        // A whole-file reply to a selection prompt must not be spliced — that
        // would duplicate everything around the selection. Diff whole-file
        // instead, which is what the reply actually is.
        const spliceable =
          offsets !== undefined &&
          !isWholeFileRewrite(rewritten, ctx.fullText, offsets.start, offsets.end);
        if (offsets !== undefined && !spliceable) {
          deps.log.debug("scm: docstrings reply looks whole-file; diffing without splicing");
        }
        const right =
          offsets !== undefined && spliceable
            ? spliceSelection(ctx.fullText, offsets.start, offsets.end, rewritten)
            : rewritten;
        await deps.openDiff({
          title: `${redactPath(ctx.fileName)} ↔ Nimbus docstrings`,
          left: ctx.fullText,
          right,
          fileName: redactPath(ctx.fileName),
        });
      } catch (e) {
        deps.log.error(`nimbus.generateDocstrings failed: ${errMsg(e)}`);
        void deps.window.showErrorMessage(`Nimbus generate docstrings failed: ${errMsg(e)}`);
      }
    },
```

- [ ] **Step 6: Run test to verify it passes**

Run: `bun run test -- scm-commands`
Expected: PASS, all four command describes green.

- [ ] **Step 7: Verify the gate**

Run: `bun run test && bun run typecheck && bun run lint`
Expected: all exit 0.

- [ ] **Step 8: Commit**

```bash
git add src/scm/commands.ts test/unit/scm-commands.test.ts
git commit -m "feat(scm): add Generate Tests and Generate Docstrings commands"
```

---

## Task 9: VS Code glue — git adapter, output surfaces, registration

**Files:**
- Create: `src/scm/real-git.ts`
- Modify: `src/extension.ts`
- Modify: `package.json` (`contributes.commands`, `contributes.menus`)
- Modify: `vitest.config.ts`
- Test: `test/unit/extension.test.ts` (one registration smoke test)

**Interfaces:**
- Consumes: `createScmCommands`, `ScmCommandDeps` from Task 6; `GitApiLike` from Task 1.
- Produces: `createRealGitApi(): Promise<GitApiLike | undefined>`; four registered command ids.

This is the only task that touches the real `vscode` git API. Everything it adapts is already covered by tests through fakes; `real-git.ts` itself is coverage-excluded, like the other `real-*.ts` adapters.

- [ ] **Step 1: Write the git adapter**

Create `src/scm/real-git.ts`:

```ts
import * as vscode from "vscode";
import { errMsg, type Logger } from "../logging.js";
import type { ChangedFile, DiffScope, GitApiLike, GitRepositoryLike } from "./git-types.js";

// Thin vscode-git glue — mirrors real-participant.ts. Excluded from coverage;
// the pure modules carry the logic and the tests.
//
// The git extension's API is not typed on our side, so every access is guarded
// and any shape mismatch degrades to "git unavailable" rather than throwing.

interface RawChange {
  uri: { fsPath: string };
  status: number;
}

interface RawRepository {
  rootUri: { fsPath: string };
  inputBox: { value: string };
  state: { untrackedChanges?: RawChange[] };
  diffIndexWithHEAD(): Promise<RawChange[]>;
  diffIndexWithHEAD(path: string): Promise<string>;
  diffWithHEAD(): Promise<RawChange[]>;
  diffWithHEAD(path: string): Promise<string>;
  log(opts: { maxEntries: number }): Promise<Array<{ message: string }>>;
}

interface RawGitApi {
  repositories: RawRepository[];
}

function relative(root: string, absolute: string): string {
  const normalizedRoot = root.replace(/[\\/]+$/, "");
  const rel = absolute.startsWith(normalizedRoot)
    ? absolute.slice(normalizedRoot.length)
    : absolute;
  return rel.replace(/^[\\/]+/, "").replace(/\\/g, "/");
}

function adaptRepository(raw: RawRepository): GitRepositoryLike {
  const root = raw.rootUri.fsPath;
  const listing = async (scope: DiffScope): Promise<readonly ChangedFile[]> => {
    const changes = scope === "staged" ? await raw.diffIndexWithHEAD() : await raw.diffWithHEAD();
    return changes.map((c) => ({ path: relative(root, c.uri.fsPath), status: String(c.status) }));
  };
  return {
    rootPath: root,
    changedFiles: listing,
    fileDiff: async (scope, path) =>
      scope === "staged" ? raw.diffIndexWithHEAD(path) : raw.diffWithHEAD(path),
    untrackedPaths: async () =>
      (raw.state.untrackedChanges ?? []).map((c) => relative(root, c.uri.fsPath)),
    log: async (maxEntries) => (await raw.log({ maxEntries })).map((c) => c.message),
    inputBox: raw.inputBox,
  };
}

// Resolved lazily on first use: the git extension may activate after us.
export function createRealGitApi(log: Logger): () => Promise<GitApiLike | undefined> {
  return async () => {
    try {
      const ext = vscode.extensions.getExtension("vscode.git");
      if (ext === undefined) return undefined;
      const exports: unknown = ext.isActive ? ext.exports : await ext.activate();
      if (typeof exports !== "object" || exports === null) return undefined;
      const getApi = (exports as { getAPI?: (v: number) => unknown }).getAPI;
      if (typeof getApi !== "function") return undefined;
      const api = getApi.call(exports, 1) as RawGitApi | undefined;
      if (api === undefined || !Array.isArray(api.repositories)) return undefined;
      return { repositories: () => api.repositories.map(adaptRepository) };
    } catch (e) {
      log.warn(`scm: git extension unavailable: ${errMsg(e)}`);
      return undefined;
    }
  };
}
```

- [ ] **Step 2: Exclude it from coverage**

In `vitest.config.ts`, add to `coverage.exclude`, after the `real-participant.ts` line:

```ts
        "src/scm/real-git.ts",
```

- [ ] **Step 3: Add the output-surface factories**

In `src/extension.ts`, next to `createReadonlyJsonOpener`, add:

```ts
// Opens an untitled document with the given name, beside the active editor. The
// `untitled:` URI carries the file name (so the tab is named and syntax-
// highlighted); the buffer is unsaved, so nothing touches disk until the user
// saves and picks a location. Injectable as deps.openUntitled for tests.
function createUntitledOpener(): (opts: {
  fileName: string;
  content: string;
}) => Promise<void> {
  return async ({ fileName, content }) => {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(`untitled:${fileName}`));
    const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
    await editor.edit((edit) => {
      edit.insert(new vscode.Position(0, 0), content);
    });
  };
}

// Opens a side-by-side diff between two in-memory texts via a virtual
// read-only scheme, so the extension never applies an edit itself — any merge
// is the user's own action in the diff editor. Injectable as deps.openDiff.
//
// Both virtual URIs end in the source's basename, so VS Code infers the
// language from the extension natively — no setTextDocumentLanguage call, and
// no language-change events fired at other extensions.
function createDiffOpener(
  ctx: ExtensionContextLike,
): (opts: { title: string; left: string; right: string; fileName: string }) => Promise<void> {
  const scheme = "nimbus-diff";
  const MAX_DOCS = 20;
  const docs = new Map<string, string>();
  let seq = 0;
  let registered = false;
  const provider: vscode.TextDocumentContentProvider = {
    provideTextDocumentContent: (uri) => docs.get(uri.path) ?? "",
  };
  return async ({ title, left, right, fileName }) => {
    if (!registered) {
      ctx.subscriptions.push(
        vscode.workspace.registerTextDocumentContentProvider(scheme, provider),
      );
      registered = true;
    }
    seq += 1;
    // The trailing basename is what drives syntax highlighting.
    const leftPath = `/${seq}/original/${fileName}`;
    const rightPath = `/${seq}/nimbus/${fileName}`;
    docs.set(leftPath, left);
    docs.set(rightPath, right);
    while (docs.size > MAX_DOCS) {
      const oldest = docs.keys().next().value;
      if (oldest === undefined) break;
      docs.delete(oldest);
    }
    const leftUri = vscode.Uri.parse(`${scheme}:${leftPath}`);
    const rightUri = vscode.Uri.parse(`${scheme}:${rightPath}`);
    await vscode.commands.executeCommand("vscode.diff", leftUri, rightUri, title);
  };
}
```

- [ ] **Step 4: Extend `ActivateDeps`**

In `src/extension.ts`, add to the `ActivateDeps` interface:

```ts
  git?: () => Promise<GitApiLike | undefined>;
  openUntitled?: (opts: { fileName: string; content: string }) => Promise<void>;
  openDiff?: (opts: {
    title: string;
    left: string;
    right: string;
    fileName: string;
  }) => Promise<void>;
  selectionOffsets?: () => { start: number; end: number } | undefined;
```

with the imports:

```ts
import { createScmCommands } from "./scm/commands.js";
import type { GitApiLike } from "./scm/git-types.js";
import { createRealGitApi } from "./scm/real-git.js";
```

- [ ] **Step 5: Wire and register**

In `activateWithDeps`, after the `openReadonlyJson` / `openSource` / `saveJson` block, add:

```ts
  const openUntitled = deps.openUntitled ?? createUntitledOpener();
  const openDiff = deps.openDiff ?? createDiffOpener(ctx);
  // Computed here because it needs the real editor's Position→offset mapping;
  // the shim's TextEditorLike deliberately stays narrow.
  const selectionOffsets =
    deps.selectionOffsets ??
    ((): { start: number; end: number } | undefined => {
      const editor = vscode.window.activeTextEditor;
      if (editor === undefined || editor.selection.isEmpty) return undefined;
      return {
        start: editor.document.offsetAt(editor.selection.start),
        end: editor.document.offsetAt(editor.selection.end),
      };
    });

  const scm = createScmCommands({
    git: deps.git ?? createRealGitApi(log),
    client: () => {
      const client = nimbus();
      return client === undefined ? undefined : { agentInvoke: (i, o) => client.agentInvoke(i, o) };
    },
    window: deps.window,
    agent: () => settings.askAgent(),
    skipSecretFiles: () => settings.scmSkipSecretFiles(),
    selectionOffsets,
    openReadonly: openReadonlyJson,
    openUntitled,
    openDiff,
    log,
  });

  register("nimbus.generateCommitMessage", () => scm.generateCommitMessage());
  register("nimbus.reviewChanges", () => scm.reviewChanges());
  register("nimbus.generateTests", () => scm.generateTests());
  register("nimbus.generateDocstrings", () => scm.generateDocstrings());
```

- [ ] **Step 6: Add the contributions**

In `package.json`, add to `contributes.commands`:

```json
{ "command": "nimbus.generateCommitMessage", "title": "Generate Commit Message", "category": "Nimbus", "icon": "$(sparkle)" },
{ "command": "nimbus.reviewChanges", "title": "Review Changes", "category": "Nimbus" },
{ "command": "nimbus.generateTests", "title": "Generate Tests", "category": "Nimbus" },
{ "command": "nimbus.generateDocstrings", "title": "Generate Docstrings", "category": "Nimbus" }
```

Add an `scm/title` menu block to `contributes.menus`:

```json
"scm/title": [
  { "command": "nimbus.generateCommitMessage", "when": "scmProvider == git", "group": "navigation" }
]
```

and append to the existing `editor/context` array:

```json
{ "command": "nimbus.generateTests", "when": "editorTextFocus", "group": "nimbus@5" },
{ "command": "nimbus.generateDocstrings", "when": "editorTextFocus", "group": "nimbus@6" }
```

The existing entries are `nimbus@1`–`nimbus@4` (`askAboutSelection`, `searchSelection`, `quickAsk`, `findRelated`), so `nimbus@5`/`nimbus@6` continue the sequence. Note both use `editorTextFocus`, not `editorHasSelection` — these commands fall back to whole-file context, so they must be available with no selection.

- [ ] **Step 7: Add a registration smoke test**

In `test/unit/extension.test.ts`, inside the existing describe that asserts registered commands, add:

```ts
  test("registers the four SCM commands", async () => {
    const { captured } = await activate();
    for (const id of [
      "nimbus.generateCommitMessage",
      "nimbus.reviewChanges",
      "nimbus.generateTests",
      "nimbus.generateDocstrings",
    ]) {
      expect(captured.commandHandlers.has(id)).toBe(true);
    }
  });
```

Use whatever the file's existing activation helper is named — read the surrounding tests and match them rather than inventing a new harness.

- [ ] **Step 8: Run the full gate**

Run: `bun run test && bun run typecheck && bun run lint && bun run build && bun run check-bundle && bun run check-vsix-contents && bun run check-settings-docs`
Expected: all exit 0. `check-bundle` must still report `vscode` as the only external — `real-git.ts` imports `vscode` and nothing else new.

- [ ] **Step 9: Commit**

```bash
git add src/scm/real-git.ts src/extension.ts package.json vitest.config.ts test/unit/extension.test.ts
git commit -m "feat(scm): wire the dev-workflow trio into the extension host"
```

---

## Task 10: Documentation and verification

**Files:**
- Modify: `docs/architecture.md`, `docs/ROADMAP.md`, `README.md`, `CLAUDE.md`

**Interfaces:**
- Consumes: the shipped behaviour from Tasks 1–9.
- Produces: nothing code-facing.

`CHANGELOG.md` is **not** edited by hand — Release Please generates it from the `feat(scm):` commits.

- [ ] **Step 1: Document the seam in `docs/architecture.md`**

Add a subsection describing `src/scm/`: the pure modules, the `GitApiLike` seam, `real-git.ts` as the only file touching the git extension, and the rule that diffs are fetched per-file (paths come from git, never parsed out of `diff --git` headers). Match the file's existing heading depth and tone.

- [ ] **Step 2: Update `docs/ROADMAP.md`**

Move the **Dev-workflow trio** row out of the Phase 2 table and into **Already shipped**:

```markdown
| **Dev-workflow trio** — Generate commit message (staged diff → SCM input box), Review changes (all local changes vs `HEAD` → findings tab), Generate tests / docstrings (untitled test buffer / docstring diff) | `agentInvoke` + SCM API |
```

- [ ] **Step 3: Update `README.md` and `CLAUDE.md`**

Add the four commands to the README feature list, and extend the CLAUDE.md "Surface today" paragraph and Layout section with `src/scm/`. Keep both descriptions consistent with what actually shipped — in particular, that output is always a suggestion (input box, untitled buffer, read-only tab, diff view) and never an applied edit.

- [ ] **Step 4: Run the full local gate**

Run: `bun run test && bun run typecheck && bun run lint && bun run build && bun run check-bundle && bun run check-vsix-contents && bun run check-settings-docs`
Expected: all exit 0.

- [ ] **Step 5: Verify in a real Extension Development Host**

Use the `verify-extension` skill for Layer 2. It must be driven against a **real git repo with a running Gateway**, exercising at minimum:

1. Stage a change → `Nimbus: Generate Commit Message` → a message appears in the SCM box in the repo's own style.
2. Repeat with text already in the box → the Replace/Append/Cancel modal appears and each branch behaves.
3. Edit files (some staged, some not) plus add an untracked file → `Nimbus: Review Changes` → findings tab lists staged *and* unstaged files as reviewed and names the untracked file as **not** reviewed.
4. Stage a `.env` alongside a source file → the warning names the skipped file and the `.env` contents appear nowhere in the prompt (check the Nimbus output channel and the egress ledger).
5. `Nimbus: Generate Tests` on a selection → an untitled `*.test.*` tab opens beside the source; Save offers a location and nothing was written beforehand.
6. `Nimbus: Generate Docstrings` on a selection → a diff opens showing only the annotated region changed.
7. Disable the built-in Git extension → all git-backed commands report it cleanly with no crash.

- [ ] **Step 6: Commit**

```bash
git add docs/architecture.md docs/ROADMAP.md README.md CLAUDE.md
git commit -m "docs: document the dev-workflow trio"
```

- [ ] **Step 7: Open the PR**

```bash
git push -u origin HEAD
gh pr create --title "feat(scm): dev-workflow trio — commit message, review changes, generate tests/docs" --body "..."
```

Squash-merge so Release Please sees a single `feat(scm):` commit. Resolve CodeRabbit and Sonar threads before merging.

---

## Self-Review

**Spec coverage.** Every spec section maps to a task: seam + repo handling → Task 1; clamping, secret-skip, hunk truncation, the setting → Task 2; commit style/sanitize/clobber → Tasks 3 and 6; review scope + coverage header → Tasks 4 and 7; test filenames, code extraction, selection splice, diff view → Tasks 5 and 8; contributions, adapters, registration → Task 9; docs + the Layer 2 gate → Task 10. The spec's `SCM_MAX_FILES` cap, the stale-repo guard, and the "untracked counted but never sent" rule each have a named test.

**One deliberate deviation**, recorded under Global Constraints: selection offsets ride a deps accessor instead of a widened `TextEditorLike`, to avoid churning a dozen existing test fakes for no behavioural gain.

**Review-driven additions** (beyond the spec, all with tests): a distinct `"non-textual"` omission reason so binary files and renames are never reported as "too large"; `isWholeFileRewrite` so a whole-file reply to a selection prompt is diffed rather than spliced; a duplicate-append guard on the SCM input box; and language inference from the virtual URI's extension instead of `setTextDocumentLanguage`.

**Type consistency.** `DiffScope`, `ChangedFile`, `GitRepositoryLike`, `GitApiLike`, `OmittedFile`, `SelectedFile`, `DiffSelection`, `ReviewCoverage`, `CollectedDiff`, `ScmClientLike`, and `ScmCommandDeps` are each defined once and referenced with the same member names throughout. `collectDiff` returns the exact field names (`block`, `reviewed`, `omittedTooLarge`, `skippedSecret`, `empty`) that Tasks 6–7 consume and that `ReviewCoverage` maps onto.
