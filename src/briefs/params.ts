// Editor context → brief parameters.
//
// The one invariant this module exists to hold: an absolute path never becomes
// a parameter. A repo-relative ref is more useful to the Gateway than a bare
// basename, and it carries no home directory — but when no workspace root
// matches, the basename is the safe floor.

export interface EditorTarget {
  /** Already relative — the output of toRelativeRef. */
  ref: string;
  /** Zero-based, as VS Code reports the cursor line. */
  line: number;
}

function normalise(p: string): string {
  return p.replace(/\\/g, "/");
}

function basename(p: string): string {
  const segments = normalise(p).split("/");
  return segments.at(-1) ?? p;
}

export function toRelativeRef(fileName: string, roots: readonly string[]): string {
  const file = normalise(fileName);
  // Longest root first: with nested folders open, the innermost is the useful
  // one, and a shorter parent would otherwise win by appearing earlier.
  const sorted = [...roots].map(normalise).sort((a, b) => b.length - a.length);
  for (const root of sorted) {
    const prefix = root.endsWith("/") ? root : `${root}/`;
    // Compare case-insensitively: on Windows the editor's fileName and the
    // workspace folder can disagree on drive-letter case ("C:/" vs "c:/"), and
    // an exact compare would miss, silently degrading a useful repo-relative
    // ref to a bare basename. Slice from the ORIGINAL string so real casing
    // survives — the Gateway's index may be case-sensitive.
    if (file.toLowerCase().startsWith(prefix.toLowerCase())) return file.slice(prefix.length);
  }
  return basename(file);
}

/**
 * VS Code counts lines from 0; editor gutters, git blame, and every "file:line"
 * a human reads count from 1. Everything that leaves this module — the RPC
 * parameter and the egress manifest alike — goes through here, so the number in
 * the modal, the number in the rendered brief, and the number in the gutter can
 * never disagree.
 *
 * ASSUMPTION: `agentsWhy` expects 1-based lines. The client types `line?:
 * number` with no stated base and the SDK fixture uses 42 for both `query.line`
 * and `subject.lineNo`, so it settles nothing. 1-based is the convention git
 * blame uses and the one the brief is rendered against. If verification shows
 * the Gateway is 0-based, this function is the single line to change.
 */
export function toOneBased(line: number): number {
  return line + 1;
}

export function whyParams(t: EditorTarget): { ref: string; line: number } {
  return { ref: t.ref, line: toOneBased(t.line) };
}

export function fileParams(t: EditorTarget): { file: string } {
  return { file: t.ref };
}
