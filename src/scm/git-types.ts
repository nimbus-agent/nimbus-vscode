// Narrow structural seam over VS Code's built-in git extension API. The rest of
// the codebase programs against these four verbs, never against the git
// extension's own shape (which real-git.ts adapts). Types only — no logic, so
// this file needs no tests.

import type { DisposableLike } from "../vscode-shim.js";

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
  /**
   * The working-tree changes the git extension has ALREADY materialised, read
   * straight off its state — no subprocess, no await. `changedFiles("all")`
   * shells out to `git diff`, which is right for the SCM trio (a command the
   * user invoked, once) and wrong for the context panel, which asks on every
   * debounce tick while the user types. Repo-relative, like ChangedFile.path.
   */
  changedPathsNow(): readonly string[];
  fileDiff(scope: DiffScope, path: string): Promise<string>;
  // Counted and named in the review header; contents are never sent.
  untrackedPaths(): Promise<readonly string[]>;
  // Most recent commit messages, newest first.
  log(maxEntries: number): Promise<readonly string[]>;
  readonly inputBox: { value: string };
  /** Current branch name; undefined on a detached HEAD. */
  branch(): string | undefined;
  /**
   * Fires when the repository's state changes — branch switch, stage, checkout.
   * Without it, a branch switch made while the user sits still leaves the
   * context panel showing the previous branch until some other event happens.
   */
  onDidChange(listener: () => void): DisposableLike;
}

export interface GitApiLike {
  repositories(): readonly GitRepositoryLike[];
  /**
   * Fires when the git extension opens or discovers a repository. Repositories
   * populate ASYNCHRONOUSLY — the extension can be active while still scanning —
   * so a consumer that subscribes only to what `repositories()` returns at
   * activation can attach to nothing at all and never hear about a branch
   * switch again.
   */
  onDidOpenRepository(listener: () => void): DisposableLike;
}
