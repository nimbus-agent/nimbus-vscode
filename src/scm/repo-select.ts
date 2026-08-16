import { rootFor } from "../briefs/params.js";
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

// The repository containing `fileName`, in a multi-root workspace where more
// than one is open. Delegates the longest-root-first matching (and the
// Windows drive-letter/UNC case-insensitivity rule) to rootFor rather than
// re-deriving it — repo roots and workspace roots are matched by the same
// rule, so one implementation earns both call sites.
//
// With no fileName (no active editor) there is nothing to match against: the
// sole repository is returned when there is exactly one, and undefined
// otherwise — guessing among several would reintroduce the arbitrary choice
// this function exists to replace.
export function repoContaining(
  repos: readonly GitRepositoryLike[],
  fileName: string | undefined,
): GitRepositoryLike | undefined {
  if (fileName === undefined) {
    return repos.length === 1 ? repos[0] : undefined;
  }
  const root = rootFor(
    fileName,
    repos.map((r) => r.rootPath),
  );
  if (root === undefined) return undefined;
  return findRepoByRoot(repos, root);
}
