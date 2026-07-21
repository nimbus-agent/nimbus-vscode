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
