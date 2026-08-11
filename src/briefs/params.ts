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

/**
 * The workspace root containing `fileName`, returned in the ORIGINAL casing the
 * caller passed in, or undefined when none matches. Longest root first: with
 * nested folders open the innermost is the useful one, and a shorter parent
 * would otherwise win by appearing earlier.
 *
 * Compares case-insensitively because on Windows the editor's fileName and the
 * workspace folder can disagree on drive-letter case ("C:/" vs "c:/").
 */
export function rootFor(fileName: string, roots: readonly string[]): string | undefined {
  const file = normalise(fileName).toLowerCase();
  const sorted = [...roots].sort((a, b) => normalise(b).length - normalise(a).length);
  for (const root of sorted) {
    const n = normalise(root);
    const prefix = (n.endsWith("/") ? n : `${n}/`).toLowerCase();
    if (file.startsWith(prefix)) return root;
  }
  return undefined;
}

export function toRelativeRef(fileName: string, roots: readonly string[]): string {
  const file = normalise(fileName);
  const root = rootFor(fileName, roots);
  if (root === undefined) return basename(file);
  const n = normalise(root);
  // Slice from the ORIGINAL string so real casing survives — the Gateway's
  // index may be case-sensitive.
  return file.slice((n.endsWith("/") ? n : `${n}/`).length);
}

/**
 * VS Code counts lines from 0; editor gutters, git blame, and every "file:line"
 * a human reads count from 1. Everything that leaves this module — the RPC
 * parameter and the egress manifest alike — goes through here, so the number in
 * the modal, the number in the rendered brief, and the number in the gutter can
 * never disagree.
 *
 * VERIFIED 1-based against a live Gateway (2026-08-10), not assumed. The typed
 * client says only `line?: number`, so this was settled by probing
 * `agentsWhyPeek` — which shares WhyParams — against a file whose adjacent
 * lines have different commits: `ops-commands.ts` 1-based line 2 is uniquely
 * `caec0e0`, lines 1 and 3 are `475d24b`. Querying line 2 returned `caec0e0`,
 * and `subject.lineNo` echoed 2. Passing VS Code's 0-based value straight
 * through would have made every `why` answer about the line above.
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
