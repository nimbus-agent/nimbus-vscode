// Which changed files are untracked, given the git extension's two change
// groups.
//
// This is its own module rather than a few lines inside real-git.ts because
// real-git.ts is untested vscode glue, and getting this wrong is silent: the
// "Not reviewed — untracked" list is what stops a reader assuming a brand-new
// file was covered, so an empty list reads as "nothing was left out".

/** `Status.UNTRACKED` from the git extension's API enum. */
export const GIT_STATUS_UNTRACKED = 7;

/** One entry from a git extension change group, reduced to what we need. */
export interface StatusedPath {
  path: string;
  status: number;
}

// VS Code fills the dedicated untracked group ONLY when the user has set
// `git.untrackedChanges: "separate"`. Under the default `"mixed"` the group is
// empty and untracked entries sit in the working-tree group next to real
// modifications — so reading the dedicated group alone finds nothing on a
// default install. Merge both, keeping only genuinely untracked working-tree
// entries, and dedupe so a path listed in both groups is reported once.
export function untrackedPathsFrom(
  untrackedGroup: readonly StatusedPath[],
  workingTreeGroup: readonly StatusedPath[],
): readonly string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const candidates = [
    ...untrackedGroup,
    ...workingTreeGroup.filter((c) => c.status === GIT_STATUS_UNTRACKED),
  ];
  for (const candidate of candidates) {
    if (seen.has(candidate.path)) continue;
    seen.add(candidate.path);
    out.push(candidate.path);
  }
  return out;
}
