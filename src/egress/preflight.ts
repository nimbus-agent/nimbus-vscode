import { findLeakedRoots } from "./leak-check.js";

// Which surface a payload came from. Fixed per surface at wiring time so a
// call site cannot misreport itself.
export type EgressKind =
  | "quickAsk"
  | "scm"
  | "ask"
  | "participant"
  | "lmTool"
  | "brief"
  | "workflow"
  | "diagnostic";

export interface EgressFile {
  /** ALREADY redacted by the call site — a basename or repo-relative path. */
  name: string;
  /** "whole file", "selected code", "staged + unstaged" */
  note: string;
}

export interface EgressPayload {
  kind: EgressKind;
  /** Human label for the action: "Review Changes", "Quick Ask". */
  action: string;
  /** Verbatim — exactly the string that would be sent. */
  prompt: string;
  files: readonly EgressFile[];
  /** What was deliberately left out: "2 files omitted (diff too large)." */
  omissions: readonly string[];
  /** Absolute paths held LOCALLY as leak-check needles. Never sent. */
  roots: readonly string[];
}

// What a call site supplies. `kind`, `prompt` and `roots` come from the seam,
// so no call site can forget the needles or misreport its surface.
export type EgressMeta = Omit<EgressPayload, "kind" | "prompt" | "roots">;

// A modal cannot scroll, so the list elides. The full list is always one click
// away in "Show full text".
export const EGRESS_FILES_SHOWN = 5;

export const REDACTION_NOTE = "Paths sent as file names only — no directories, no repository path.";

export const RELATIVE_PATH_NOTE =
  "Paths sent relative to your project root — no absolute paths, no machine layout.";

export const LEAK_WARNING =
  "WARNING: this payload contains an absolute path from this machine. Nimbus does not add it — it is inside your own content.";

// Group digits without toLocaleString, whose output depends on the host locale
// and would make these strings untestable across machines.
function groupDigits(n: number): string {
  const s = String(n);
  let out = "";
  for (let i = 0; i < s.length; i += 1) {
    if (i > 0 && (s.length - i) % 3 === 0) out += ",";
    out += s[i];
  }
  return out;
}

function headline(p: EgressPayload): string {
  const chars = `${groupDigits(p.prompt.length)} characters`;
  if (p.files.length === 0) return `${p.action} — ${chars}`;
  const files = `${p.files.length} file${p.files.length === 1 ? "" : "s"}`;
  return `${p.action} — ${files}, ${chars}`;
}

function leaked(p: EgressPayload): boolean {
  return findLeakedRoots(p.prompt, p.roots).length > 0;
}

function footerLines(p: EgressPayload): string[] {
  const lines: string[] = [];
  if (p.files.length > 0) {
    // Which claim is true depends on what the call site actually put in. Quick
    // Ask and two of the SCM trio's commands — Generate Tests, Generate
    // Docstrings — redact to a basename; Generate Commit Message, Review
    // Changes, and the briefs send the repo-relative path, because that is
    // what the Gateway resolves against. Asserting the stronger claim over the
    // weaker payload is the one failure this surface cannot afford.
    //
    // Three states, not two. An ABSOLUTE name is neither a bare file name nor
    // repository-relative, so it gets no reassurance at all rather than the
    // weaker of two false claims. It also gets no LEAK_WARNING: leaked() below
    // inspects p.prompt only, never p.files, so an absolute name sitting in
    // files is silent, not flagged — still the safe outcome (no false claim),
    // just not a loud one. No surface is supposed to produce an absolute name
    // here (see the redaction split above), which is exactly why the fallback
    // must not quietly assert something nice about it.
    const absolute = (name: string): boolean =>
      name.startsWith("/") || name.startsWith("\\\\") || /^[A-Za-z]:[\\/]/.test(name);
    const names = p.files.map((f) => f.name);
    const bare = names.every((n) => !n.includes("/") && !n.includes("\\"));
    if (bare) lines.push(`  ${REDACTION_NOTE}`);
    else if (!names.some(absolute)) lines.push(`  ${RELATIVE_PATH_NOTE}`);
  }
  if (leaked(p)) lines.push(`  ${LEAK_WARNING}`);
  for (const omission of p.omissions) lines.push(`  ${omission}`);
  return lines;
}

function render(p: EgressPayload, limit: number | undefined): string {
  const shown = limit === undefined ? p.files : p.files.slice(0, limit);
  const rest = p.files.length - shown.length;
  const lines: string[] = [headline(p)];
  if (shown.length > 0) {
    lines.push("");
    for (const f of shown) lines.push(`  ${f.name} — ${f.note}`);
    if (rest > 0) lines.push(`  … and ${rest} more`);
  }
  const footer = footerLines(p);
  if (footer.length > 0) lines.push("", ...footer);
  return lines.join("\n");
}

// The modal's main message. Deliberately not action-specific: the detail below
// it already names the action, and a modal title reads better short.
export function egressTitle(_p: EgressPayload): string {
  return "Send this to the Nimbus agent?";
}

// The modal's `detail` — a summary, elided to fit without scrolling.
export function summarizeEgress(p: EgressPayload): string {
  return render(p, EGRESS_FILES_SHOWN);
}

// The read-only tab — every file, then the exact bytes that would be sent.
export function renderFullEgress(p: EgressPayload): string {
  return `${render(p, undefined)}\n\n---\n\n${p.prompt}`;
}

// The LM-tool confirmation card. Rendered inline by the calling chat, so it
// stays to a couple of sentences.
export function confirmationMessage(p: EgressPayload): { title: string; message: string } {
  const parts = [headline(p)];
  if (leaked(p)) parts.push(LEAK_WARNING);
  return { title: egressTitle(p), message: parts.join(" ") };
}
