# Review & Suggestions: Built-in Briefs PR 3 Implementation Plan

This document reviews the implementation plan proposed in [2026-08-11-built-in-briefs-pr3.md](./2026-08-11-built-in-briefs-pr3.md) and outlines potential improvements and edge-case concerns.

---

## 1. Type Safety with Optional `idleDays` in `renderJanitor`

### Observation (Task 1)
In the implementation plan for `renderJanitor`:
```ts
export function renderJanitor(brief: JanitorBrief): string {
  const target = `\`${brief.query.resourceRef}\``;
  const window = plural(brief.query.idleDays, "day");
  // ...
}
```
However, in `@nimbus-dev/client`'s `JanitorParams`, `idleDays` is typed as optional (`idleDays?: number`). 
Under strict compilation, `brief.query.idleDays` can be `undefined`, which will cause a type-checking error when passed to `plural(n: number, one: string)` because it expects a strict `number`.

### Proposed Improvement
Add a fallback check or condition in the renderer for when `idleDays` is `undefined`:
```ts
const window = brief.query.idleDays !== undefined 
  ? plural(brief.query.idleDays, "day") 
  : "its configured threshold";
```

---

## 2. Prefill Casing Matching in `rootFor` vs File System Paths

### Observation (Task 3)
In the extracted `rootFor` helper:
```ts
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
```
This performs a case-insensitive check which is correct for cross-platform compatibility (especially on Windows where drive letter case can differ).

### Suggestion
Verify that `normalise(root)` replaces backward slashes (`\`) with forward slashes (`/`) so that the `.toLowerCase()` starts-with match behaves correctly when windows drive paths (e.g. `C:\gitrep...`) are mixed with git/uri relative paths. Since `normalise` is defined as `p.replace(/\\/g, "/")`, this should work perfectly, but we should make sure that the `roots` array entries also get passed through `normalise` before evaluating `endsWith("/")`.
```ts
// Ensure root is normalised before suffix check
const n = normalise(root);
const prefix = (n.endsWith("/") ? n : `${n}/`).toLowerCase();
```

---

## 3. Potential for Future `changedSurface` Support in Preflight

### Observation (Task 4)
The `preflightParams` currently only maps `ref` and `namespace`:
```ts
export function preflightParams(t: { ref: string; namespace: string }) {
  return { ref: t.ref, namespace: t.namespace };
}
```
However, `PreflightParams` also accepts `changedSurface?: string[]` from the client SDK. While this is currently out of scope, it might be beneficial to keep the parameters builder forward-compatible by accepting optional parameter overrides.

---

## 4. Distinguishing Cancel (Escape) vs. Default Input in Dialog Prompts

### Observation (Task 6)
In `createBriefCommands`'s input prompt helpers:
```ts
  const ask = async (prompt: string, opts: { value?: string; validate?: (v: string) => string | undefined } = {}): Promise<string | undefined> => {
    const answer = await deps.window.showInputBox({
      prompt,
      ...(opts.value !== undefined && opts.value.length > 0 ? { value: opts.value } : {}),
      ...(opts.validate !== undefined ? { validateInput: opts.validate } : {}),
    });
    const trimmed = answer?.trim();
    return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
  };
```
If the user presses Escape, `showInputBox` returns `undefined`. If the user submits a blank input to use the Gateway default, `showInputBox` returns `""` (empty string). Both map to `undefined` in the return value of `ask()`.

This leads to an issue in `askJanitor`:
```ts
    const days = await ask("Idle for how many days? (blank = Gateway default)", { ... });
    return days === undefined ? { resourceRef } : { resourceRef, idleDays: Number(days) };
```
If the user hits **Escape** (indicating they want to cancel the command), `days` is `undefined`, and the command still executes using the default behavior `{ resourceRef }`. 

### Proposed Improvement
Refactor `ask()` or check `answer` directly so that:
- Pressing Escape/cancelling returns a token or sentinel value (or returns a distinct result like `null`), letting the command abort.
- Submitting an empty value (Enter on blank) returns a distinct result (e.g. `undefined`), indicating the user accepted the default.

