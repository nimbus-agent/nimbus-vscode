import type { ChangedFile } from "./git-types.js";

// One budget, shared with quick-ask: the justification for 50k is the same.
export { QUICK_ASK_MAX_CONTEXT_CHARS as SCM_MAX_DIFF_CHARS } from "../quick-ask.js";

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
