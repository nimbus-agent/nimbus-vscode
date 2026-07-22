// Pure path logic shared by the git adapter. No vscode import — this is the
// one place the "never send an absolute path to the agent" rule is enforced
// in code, so it is unit-tested directly rather than only through real-git.ts
// (which is vscode glue and excluded from coverage).

function basename(path: string): string {
  const segments = path.split(/[\\/]+/).filter((s) => s.length > 0);
  return segments.at(-1) ?? path;
}

// A drive-letter root ("C:\..." or "C:/...") is the only case where the git
// extension can hand back a path that differs from the root only in case
// (e.g. a case-insensitive filesystem reporting "C:\Repo\..." against a root
// of "c:\repo"). POSIX roots are compared byte-for-byte.
function isDriveLetterRoot(root: string): boolean {
  return /^[A-Za-z]:/.test(root);
}

// Scanned rather than matched with `/[\\/]+$/`: an end-anchored quantifier
// backtracks super-linearly on a long run of separators. This is linear.
function trimTrailingSeparators(path: string): string {
  let end = path.length;
  while (end > 0) {
    const ch = path[end - 1];
    if (ch !== "/" && ch !== "\\") break;
    end--;
  }
  return path.slice(0, end);
}

// Repo-relative path for a changed file, for display and for the prompt sent
// to the agent. NEVER falls back to the raw absolute path: on any mismatch —
// a prefix that isn't actually an ancestor (a sibling directory sharing a
// string prefix), a drive-letter case difference the caller didn't already
// normalize, a symlink, anything — the result is the basename only. There is
// no second line of defense past this function, so "no separator boundary
// after the root" and "no case-insensitive compare" both fail closed to the
// basename rather than open to the full path.
export function relativeOrBasename(root: string, absolute: string): string {
  const normalizedRoot = trimTrailingSeparators(root);
  const driveLetterRoot = isDriveLetterRoot(normalizedRoot);
  const rootForCompare = driveLetterRoot ? normalizedRoot.toLowerCase() : normalizedRoot;
  const absoluteForCompare = driveLetterRoot ? absolute.toLowerCase() : absolute;
  const boundaryChar = absoluteForCompare.charAt(rootForCompare.length);
  const withinRoot =
    absoluteForCompare.startsWith(rootForCompare) &&
    (boundaryChar === "" || /[\\/]/.test(boundaryChar));
  if (!withinRoot) return basename(absolute);
  return absolute
    .slice(normalizedRoot.length)
    .replace(/^[\\/]+/, "")
    .replaceAll("\\", "/");
}
