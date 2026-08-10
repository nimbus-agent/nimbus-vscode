# Review & Suggestions: 2026-08-10-built-in-briefs-pr1.md

Here is a review of the PR 1 implementation plan for built-in briefs, along with suggestions and open questions.

## 1. Open Questions & Implementation Details

### A. Missing `active` selection fields in tests
- **Checking mock editors:** The plan instructs:
  > If typecheck reports another `TextEditorLike` literal missing `active`, add `active: { line: 0 }` to it — the grep in Step 5 covered the two that exist today.
  
  It would be safer to verify this upfront by checking if any other unit tests (e.g., in `chat-participant.test.ts` or other files) mock `TextEditorLike` or if there are manual mocks in helper utilities (like `test/helpers.ts`).

### B. Progress runner naming conventions
- The new `GatedBriefs` interface introduces:
  `function gateRawBriefs(client: RawBriefClient, gate: EgressGate, withProgress?: ProgressRunner): GatedBriefs`
  Is `ProgressRunner` a standard type in `src/vscode-shim.ts` or similar? We should double check that we do not introduce type mismatches with standard VS Code progress handling or other services in the codebase.

---

## 2. Improvements & Suggestions

### A. Line Number Zero-Based vs One-Based Translation
- **Translation safety:** VS Code selection active line is **0-based** (0 represents line 1 in editor).
- The `renderWhy` output formatting says:
  `const line = brief.query.line === null ? "" : \`:${brief.query.line}\`;`
  If the Gateway expects 1-based line numbers, we must perform a `+ 1` translation somewhere (usually in `params.ts` or `commands.ts`). The specification doesn't mention if `agentsWhy` expects 0-based or 1-based, but Git blame and typical API bounds usually expect 1-based. If it expects 1-based, `whyParams({ ref, line })` should map `line: line + 1`.

### B. Longest-matching root path safety
- In `toRelativeRef`:
  ```ts
  const sorted = [...roots].map(normalise).sort((a, b) => b.length - a.length);
  ```
  This is a good practice! However, ensure that case-insensitivity on Windows doesn't bypass this. Since `roots` or `fileName` could have mismatched casing (e.g. `C:\gitrep` vs `c:\gitrep`), it is safer to lowercase both strings before calling `startsWith`.
