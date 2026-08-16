# Design & Plan Review: Ambient Context Panel — PR 1

This document contains a structured review, suggestions, improvements, and open questions for the [2026-08-16-ambient-context-panel-pr1.md](2026-08-16-ambient-context-panel-pr1.md) implementation plan.

---

## 1. Open Questions & Performance Concerns

### A. Lack of Debouncing on Cursor Selection Events (Keystrokes)
* **The Issue:** In Task 6, `recollect` is wired directly to `onDidChangeTextEditorSelection`:
  ```ts
  vscode.window.onDidChangeTextEditorSelection(() => recollect()),
  ```
  Every character typed by a user triggers a selection change event. If a user types quickly, `recollect` (and thus the async `gitSummary()`) will execute on every keystroke. 
  Although the generation fence (`mine !== generation`) correctly discards stale results, `await deps.git()` and `repo.branch()` will still be invoked concurrently for every keystroke. This might cause noticeble UI thread lag or clutter the Git extension.
* **Suggestion:** Consider adding a very lightweight debounce helper directly in `real-context-view.ts` for PR 1, rather than waiting for `controller.ts` in PR 2. A simple 250ms debounce wrapper on `recollect` for selection events would protect editor responsiveness during active typing.

### B. Why Add `onDidChange` to the Git Seam in PR 1 if it is Unused?
* **The Issue:** The plan adds `onDidChange` to `GitRepositoryLike` and mocks it in all fakes in PR 1 (Task 3). However, it is not actually subscribed to or used in PR 1 (as noted in the self-review).
* **Question:** Should we defer adding `onDidChange` to the Git interface and updating all test fakes to PR 2, keeping PR 1's changes strictly minimal? Or is it preferred to lay the interface groundwork now? (Typically, keeping changes strictly minimal is better).

---

## 2. Code Quality & Integration Suggestions

### A. Non-File Scheme Filtering
* **Review of Task 1:** `buildSnapshot` treats non-file schemes (untitled, output pane, settings, etc.) as no editor.
* **Suggestion:** Ensure we also handle binary files or virtual files gracefully. The file scheme check `editor.scheme === "file"` is a good safety gate.

### B. Correct Asset Paths in `.vscodeignore`
* **Review of Task 5:** `check-vsix-contents.mjs` is updated, which is excellent.
* **Reminder:** Double check that `media/context.js` and `media/context.css` are not accidentally ignored by patterns in `.vscodeignore`.

### C. Error Logging on executeCommand
* **Review of Task 6:**
  ```ts
  void vscode.commands.executeCommand(result.command, ...result.args).then(undefined, (e: unknown) => {
    deps.log.error(`context panel command failed: ${errMsg(e)}`);
  });
  ```
  This is a good practice. Make sure `errMsg` is imported correctly from `../logging.js`.

---

## 3. Typo / Import Check

* In `src/context/real-context-view.ts`:
  ```ts
  import { toRelativeRef } from "../briefs/params.js";
  ```
  Confirm if `params.ts` exports `toRelativeRef` and if the compiled output uses `.js`. The import path with `.js` is correct under the strict ES module import rule.
