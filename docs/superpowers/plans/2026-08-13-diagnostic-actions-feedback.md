# Feedback & Suggestions: Diagnostic Actions Implementation Plan

This document contains open questions, suggestions, and proposed improvements for the [Diagnostic Actions Implementation Plan](./2026-08-13-diagnostic-actions.md).

---

## 1. Open Questions & Code Safety

### Q1.1: Reference Identity Dependency in `selectDiagnostic`
* **Context:** In `real-provider.ts` (Task 7, Step 7), the implementation recovers the original `vscode.Diagnostic` using index identity:
  ```ts
  const likes = context.diagnostics.map(toLike);
  const offered = opts.offer(likes);
  ...
  const chosen = context.diagnostics[likes.indexOf(offered.diagnostic)];
  ```
  This works because `selectDiagnostic` currently returns the exact reference from the array it receives.
* **Concern:** If a developer later refactors `selectDiagnostic` or `normalizeDiagnosticMessage` to return a cloned object, `indexOf` will return `-1`, resulting in `chosen` being `undefined`.
* **Suggestion:** We should add a safeguard check (e.g., check if index is `!== -1`) or document this reference-equality contract inside `selectDiagnostic`'s docstring to prevent future regression.

### Q1.2: Support for `placeholder` in `runSearch`
* **Context:** In Task 7, Step 8, the commands call `runSearch` with options:
  ```ts
  runSearch(query, {
    placeholder: "Prior occurrences of this error",
    emptyText: "Nimbus: nothing in the local index matches this error.",
  })
  ```
  The step specifies adding `emptyText` to the options parameter of `runSearch` but does not explicitly mention adding `placeholder` support if it isn't already present in the existing signature.
* **Suggestion:** Verify whether the existing `runSearch` options already support `placeholder`. If not, the plan should explicitly list modifying the options type to include `placeholder?: string` in `extension.ts`.

---

## 2. Improvements & Suggestions

### Suggestion 2.1: Verify `extractReply` Export
* **Context:** In Task 6, Step 3, `extractReply` is imported from `../quick-ask.js`.
* **Suggestion:** Before starting Task 6, double-check that `extractReply` is indeed exported from `src/quick-ask.ts` so that no build errors occur when importing it.
