// Absolute-path leak detection for the pre-flight gate.
//
// Deliberately NOT a "looks like a path" regex. Every needle is a literal
// string we already know (a workspace root, the home directory), so a match is
// a fact rather than a guess — a regex would fire on every `#!/usr/bin/env` in
// a diff, and a gate that cries wolf trains people to click through it.
//
// Needles never leave the machine; they exist only to be searched for.

// Shorter needles are dropped. A root of "/" or "" would match everything,
// and this is what makes os.tmpdir() safe to pass in: on Linux it is usually
// "/tmp" — four characters that appear legitimately in shebangs, fixtures and
// documentation — so it is filtered here rather than at the call site, while
// the long macOS form (/var/folders/…/T) still gets checked.
//
// LIMITATION: a dropped root is not searched for at all. That is the right
// trade (a 1-4 character needle would fire on almost any payload), but it is
// silent, so callers should log droppedRoots() once. Homedirs at or above the
// threshold — including "/root", which is exactly 5 — are unaffected.
export const MIN_NEEDLE_LENGTH = 5;

// The same path can appear in one payload written both ways — a Windows tool
// prints "C:\a\b" while a script in the same diff writes "C:/a/b". Both forms
// are exact transforms of a known string, so neither weakens the guarantee.
export function pathVariants(root: string): readonly string[] {
  const forward = root.replaceAll("\\", "/");
  const back = root.replaceAll("/", "\\");
  return forward === back ? [forward] : [root, root.includes("\\") ? forward : back];
}

function usable(root: string): boolean {
  return root.trim().length >= MIN_NEEDLE_LENGTH;
}

// The roots found verbatim in `text`, each reported once, in the order given.
// An empty result means the payload is clean.
export function findLeakedRoots(text: string, roots: readonly string[]): readonly string[] {
  const haystack = text.toLowerCase();
  const hits: string[] = [];
  for (const root of roots) {
    if (!usable(root)) continue;
    if (hits.includes(root)) continue;
    const found = pathVariants(root).some((v) => haystack.includes(v.toLowerCase()));
    if (found) hits.push(root);
  }
  return hits;
}

// The roots findLeakedRoots will NOT search for. Exported so the caller can
// log them: narrowing coverage silently reads as "we checked everything" when
// we did not.
export function droppedRoots(roots: readonly string[]): readonly string[] {
  return roots.filter((r) => !usable(r));
}
