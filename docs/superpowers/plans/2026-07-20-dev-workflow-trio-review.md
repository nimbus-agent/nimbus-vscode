# Review and Feedback: Dev-workflow trio Implementation Plan

**Date of Review:** 2026-07-20  
**Plan Reviewed:** [2026-07-20-dev-workflow-trio.md](2026-07-20-dev-workflow-trio.md)

---

## 1. Positive Feedback & Alignment
* **Clean Architecture Seam:** The plan's structural boundaries are excellent. Separating all SCM git types and logical commands into pure modules while containing the raw `vscode.git` API in a coverage-excluded `real-git.ts` is highly maintainable and guarantees testability.
* **Harness & Mock Design:** The unit test designs (especially the `scm-commands.test.ts` mock harness) are thorough and cover edge cases like Gateway disconnection, empty diffs, multi-repo picks, and clobber safety.
* **Splicing Selection for Docstrings:** Splacing the selection back into the full text allows the diff view to highlight only the docstring additions, which is a massive quality-of-life improvement.

---

## 2. Improvements & Suggestions

### A. Diff Opener Language Highlighting
* **Detail in Task 9 (Step 3):** The `createDiffOpener` helper creates URIs like `nimbus-diff:/${seq}/original` and then calls `vscode.languages.setTextDocumentLanguage` on the opened document.
* **Suggestion:** Instead of manually setting the document language (which can be slow and trigger side-effect events), construct the virtual URIs with the original file's extension or name. For example:
  ```ts
  const ext = ctx.fileName.slice(ctx.fileName.lastIndexOf("."));
  const leftUri = vscode.Uri.parse(`${scheme}:${leftPath}${ext}`);
  const rightUri = vscode.Uri.parse(`${scheme}:${rightPath}${ext}`);
  ```
  VS Code will automatically map the file extension to the correct language ID, enabling syntax highlighting natively on both sides of the diff without extra API calls.

### B. Binary File Omission Classification
* **Detail in Task 2:** Binary files return `undefined` from `truncateAtHunkBoundary` and are classified under the `"too-large"` reason in `selectWithinBudget`.
* **Suggestion:** Categorizing binary files as `"too-large"` might confuse users (e.g., when they modify a small 2KB PNG and are told it was too large to review). Consider expanding `OmitReason` to support a distinct `"binary"` type:
  ```ts
  export type OmitReason = "secret" | "too-large" | "file-cap" | "binary";
  ```
  And report this in `buildReviewDocument` (e.g., `Not reviewed — binary files`).

### C. Splice Guard for Selection-Based Docstring Generation
* **Detail in Task 8:** `spliceSelection` assumes the agent returns only the rewritten selection code block.
* **Critique:** LLMs sometimes hallucinate or return the *entire* file even when instructed to only return the selection, especially when they want to provide full context. If `spliceSelection` takes a full-file response and splices it into selection offsets, the document will become corrupted (e.g., duplicating the header/footer of the file).
* **Suggestion:** Add a defensive check. If the length of the rewritten selection is unexpectedly large or if it contains indicators that it matches the outer file context (e.g. imports or class definitions that exist outside the selection), we should fallback to opening it as a read-only tab or diffing the whole file, rather than splicing and corrupting the source content.

---

## 3. Open Questions

* **Q1. Active Editor File Path Redaction for Unsaved Files:**
  * **Context:** `redactPath(ctx.fileName)` is used when building the context headers for tests and docstrings.
  * **Question:** What happens if the active editor is an unsaved file (e.g., `Untitled-1`)? Have we verified that `redactPath` handles untitled or virtual URIs correctly without throwing, and does `deriveTestFileName` degrade gracefully for an extensionless unsaved buffer?
* **Q2. Duplicate Prevention in SCM Input Box:**
  * **Context:** The `Append` action joins the existing input box text and the draft with a double newline (`\n\n`).
  * **Question:** Should we check if the draft is already contained in the input box to prevent duplicate appends if a user accidentally runs the command twice?
