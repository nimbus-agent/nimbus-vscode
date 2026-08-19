import { isSecretPath } from "../scm/diff.js";

/**
 * What one attachment contributes to a turn. A `file` stores a path and is read
 * at send, so the user gets the version they are looking at. A `selection`
 * stores its TEXT, captured when it was attached: a stored range drifts under
 * edits, and by send time it can cover entirely different code, which is worse
 * than sending nothing. The range travels as provenance, not as a pointer.
 */
export type Attachment =
  | { kind: "file"; path: string }
  | { kind: "selection"; path: string; startLine: number; endLine: number; text: string }
  | { kind: "index"; itemId: string; name: string; service: string; snippet: string };

export type RefusalReason = "secret" | "non-textual" | "budget" | "unreadable";

export type AttachmentOutcome =
  | { state: "sent"; chars: number }
  | { state: "clamped"; chars: number; ofChars: number }
  | { state: "refused"; reason: RefusalReason };

export interface ResolvedAttachment {
  readonly attachment: Attachment;
  /** Primary chip text: the path, or the index item's name. */
  readonly label: string;
  /** Secondary chip text: what happened, in the vocabulary the spec fixes. */
  readonly detail: string;
  readonly outcome: AttachmentOutcome;
  /** The exact body this attachment contributes. Absent when refused. */
  readonly block?: string;
}

export interface AttachedContext {
  /** Everything prepended to the user's question. Empty when nothing survived. */
  readonly blocks: string;
  readonly chips: readonly ResolvedAttachment[];
  readonly totalChars: number;
}

/** One attachment's ceiling. */
export const PER_ATTACHMENT_BUDGET = 64_000;
/** One turn's ceiling across all attachments. */
export const TOTAL_BUDGET = 200_000;

// Decoded binary reaches us as text with NULs in it. A cheap, honest check —
// the alternative is sending a block of mojibake and letting the model guess.
//
// Write the two-character ESCAPE `\0`, never a literal NUL: an earlier draft of
// this plan contained real control bytes, which rendered as spaces to every
// reader. Had that shipped, `includes(" ")` would have refused every source
// file containing a space — i.e. all of them.
export function looksBinary(text: string): boolean {
  return text.includes("\0");
}

// Never cut mid-line: a truncated identifier invites a confident answer about
// code that does not exist. A single line over budget yields nothing at all.
export function clampToLineBoundary(text: string, budget: number): string {
  if (text.length <= budget) return text;
  // Search strictly BEFORE `budget`, not at-or-before it: `lastIndexOf`'s
  // fromIndex is inclusive, so searching at `budget` itself would let a
  // newline landing exactly there back in, yielding budget + 1 characters
  // once the newline is kept (`cut + 1`) — one over the promised ceiling.
  const cut = text.lastIndexOf("\n", budget - 1);
  return cut < 0 ? "" : text.slice(0, cut + 1);
}

// A path `toRepoRelative` could not make relative to any workspace root —
// living outside it, or attached with no workspace open at all — passes
// through unchanged: an absolute filesystem path (a Windows drive letter, a
// POSIX root, or a UNC share), never a repo-relative one. Every OTHER
// outbound surface in this extension redacts a path like that to repo-relative
// or basename before it is shown or sent (see redactPath); the chip and the
// block header must match, or the OS username and directory layout leak into
// a payload that Ask records without a modal preview to catch it.
function isAbsolutePath(path: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith("/") || path.startsWith("\\\\");
}

function basename(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  const idx = normalized.lastIndexOf("/");
  return idx < 0 ? normalized : normalized.slice(idx + 1);
}

// What a `file`/`selection` attachment shows: the repo-relative path as-is,
// or just the basename when it is an absolute path the workspace root could
// not account for.
function displayPath(path: string): string {
  return isAbsolutePath(path) ? basename(path) : path;
}

function labelOf(a: Attachment): string {
  return a.kind === "index" ? a.name : displayPath(a.path);
}

function refuse(a: Attachment, reason: RefusalReason, detail: string): ResolvedAttachment {
  return { attachment: a, label: labelOf(a), detail, outcome: { state: "refused", reason } };
}

function headerFor(a: Attachment): string {
  switch (a.kind) {
    case "file":
      return `--- file: ${displayPath(a.path)} ---`;
    case "selection":
      return `--- selection: ${displayPath(a.path)} (lines ${a.startLine}-${a.endLine}) ---`;
    case "index":
      return `--- index item: ${a.service}/${a.name} ---`;
  }
}

function blockFor(a: Attachment, body: string): string {
  // `body` already ends in `\n` whenever `clampToLineBoundary` cut it (it only
  // ever cuts at a line boundary) or the source itself ended in one — the
  // common case for real files. Appending another `\n` in that case would
  // count as if it were part of the budgeted body, pushing a body that is
  // exactly at PER_ATTACHMENT_BUDGET one character past it once measured back
  // out of the block. Only pad when the body is missing its own trailing
  // newline (e.g. an index snippet, or a file with no final newline).
  const suffix = body.endsWith("\n") ? "" : "\n";
  return `${headerFor(a)}\n${body}${suffix}`;
}

/**
 * The single pass that produces both what is sent and what the composer shows.
 * Two outputs from one traversal is the whole point: the chips cannot drift
 * from the payload, which is what lets the Ask panel record rather than prompt.
 * `readFile` returns undefined for anything it cannot read.
 */
export function buildAttachedContext(
  attachments: readonly Attachment[],
  readFile: (path: string) => string | undefined,
): AttachedContext {
  const chips: ResolvedAttachment[] = [];
  const bodies: string[] = [];
  let total = 0;

  for (const a of attachments) {
    // Secret wins over every other verdict, and is decided from the path alone
    // so a secret file is never even read. NOTE: isSecretPath matches names,
    // not contents — an API key pasted into an ordinary source file is not
    // caught here, and the docs say so.
    if (a.kind !== "index" && isSecretPath(a.path)) {
      chips.push(refuse(a, "secret", "possible secret · not sent"));
      continue;
    }

    const raw = a.kind === "file" ? readFile(a.path) : a.kind === "selection" ? a.text : a.snippet;
    // Empty counts as unreadable, not as a budget refusal: an index item with
    // no semanticSnippet, or an empty file, has nothing to contribute, and
    // "omitted · turn budget reached" would be a lie about why.
    if (raw === undefined || raw.trim().length === 0) {
      chips.push(refuse(a, "unreadable", "unreadable · not sent"));
      continue;
    }
    if (looksBinary(raw)) {
      chips.push(refuse(a, "non-textual", "binary · not sent"));
      continue;
    }

    const remaining = TOTAL_BUDGET - total;
    if (remaining <= 0) {
      chips.push(refuse(a, "budget", "omitted · turn budget reached"));
      continue;
    }

    // `total` (and therefore `remaining`) accumulates block.length — header
    // included — so the budget handed to the body must account for the
    // header too, or the header bytes ride free and the block can land past
    // what the caller was promised. Reserve the header's own line (its text
    // plus the "\n" that always follows it) and one more char for the
    // trailing newline blockFor pads on in the worst case (when the body
    // doesn't already end with one), so `block.length` never exceeds budget.
    const overhead = headerFor(a).length + 2;
    const budget = Math.min(PER_ATTACHMENT_BUDGET, remaining) - overhead;
    if (budget <= 0) {
      chips.push(refuse(a, "budget", "omitted · turn budget reached"));
      continue;
    }

    const body = clampToLineBoundary(raw, budget);
    if (body.length === 0) {
      chips.push(refuse(a, "budget", "omitted · turn budget reached"));
      continue;
    }

    const block = blockFor(a, body);
    bodies.push(block);
    total += block.length;

    const provenance =
      a.kind === "selection"
        ? `lines ${a.startLine}-${a.endLine} · captured at attach`
        : a.kind === "index"
          ? "from index"
          : "";
    const clampNote =
      body.length < raw.length ? `clamped · ${body.length} of ${raw.length} chars` : "";
    const detail = [provenance, clampNote].filter((s) => s.length > 0).join(" · ");

    chips.push({
      attachment: a,
      label: labelOf(a),
      detail,
      outcome:
        body.length < raw.length
          ? { state: "clamped", chars: block.length, ofChars: raw.length }
          : { state: "sent", chars: block.length },
      block,
    });
  }

  return { blocks: bodies.join(""), chips, totalChars: total };
}
