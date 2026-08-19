import { resolve as resolvePath, sep } from "node:path";

/**
 * Path helpers bridging the chat attachment system's REPO-RELATIVE identity
 * (what a chip and a block header show) and the absolute paths the `vscode`
 * shim reads by. Pure and workspace-root-explicit — `root` is the first
 * workspace folder's fsPath, matching what every other single-root assumption
 * in this codebase already does — so the one property that matters here can
 * be unit tested directly: `toRepoRelative(root, toAbsolute(root, p)) === p`.
 * A mismatch does not throw — it silently misses the attachment cache and
 * reports a perfectly readable file as "unreadable · not sent".
 *
 * With no folder open (`root` undefined), a path passes through unchanged: a
 * loose file is still attachable, it just has no root to be relative to.
 */

export function toAbsolute(root: string | undefined, repoRelative: string): string {
  return root === undefined ? repoRelative : `${root}/${repoRelative}`;
}

export function toRepoRelative(root: string | undefined, fsPath: string): string {
  if (root === undefined || !fsPath.startsWith(root)) return fsPath;
  return fsPath
    .slice(root.length)
    .replace(/^[\\/]+/, "")
    .replaceAll("\\", "/");
}

/**
 * True when `absolute` resolves to a location inside `root` (or root itself).
 * `toAbsolute` builds its result by string concatenation, so it does not
 * collapse ".." segments — this is the separate check that catches a path
 * like "../../etc/passwd" escaping the workspace before it ever reaches a
 * file read. With no root open there is nothing to escape, so everything
 * counts as "within".
 */
export function isWithinRoot(root: string | undefined, absolute: string): boolean {
  if (root === undefined) return true;
  const normalizedRoot = resolvePath(root);
  const normalizedAbsolute = resolvePath(absolute);
  return (
    normalizedAbsolute === normalizedRoot || normalizedAbsolute.startsWith(normalizedRoot + sep)
  );
}
