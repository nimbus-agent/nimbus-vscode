# Design & Plan Review: Ambient Context Panel — PR 3

This document contains a structured review, suggestions, improvements, and open questions for the [2026-08-17-ambient-context-panel-pr3.md](2026-08-17-ambient-context-panel-pr3.md) implementation plan and [2026-08-17-context-panel-f5-findings.md](2026-08-17-context-panel-f5-findings.md).

---

## 1. Open Questions & Alignment Check

### A. Formatting of `rawMeta.file` vs `snapshot.path`
* **Context:** In Task 1, you compare `file !== undefined && file === snapshot.path`.
* **Question:**
  * Are we guaranteed that the paths in `rawMeta.file` (from the local index/Gateway) and `snapshot.path` (computed via `toRelativeRef`) are normalized in the exact same format (e.g. forward slashes on Windows vs backward slashes, case-sensitivity)?
  * **Recommendation:** It would be safer to normalize slashes on both paths before comparison, or double-check if `toRelativeRef` and the Gateway indexer both output standardized POSIX-style paths (which is typical but worth explicit verification).

### B. VS Code `initialSize` Support and Layout Override
* **Context:** Task 6 introduces `"initialSize"` in `package.json` to assign height ratios.
* **Concern:** As noted, VS Code persists the user's layout once they manually drag or modify it. If a user already ran a version of Nimbus with the old layout, the new `initialSize` rules might not apply at all.
* **Recommendation:**
  * Keep the fallback step (`"visibility": "collapsed"` for the other tree views) ready.
  * Explicitly document in the "PR 3 pass" verification notes that developers testing this change must launch VS Code with a fresh profile (e.g. `--profile nimbus-pr3-check`) to verify `initialSize` behaves as expected.

---

## 2. Code Quality & Integration Suggestions

### A. Deduplication Key in `relatedSection`
* **Context:** In Task 1, the deduplication key is:
  ```ts
  const key = `${i.name} ${file ?? ""}`;
  ```
* **Suggestion:** If `i.name` is the symbol name and `file` is the relative file path, this key correctly collapses identical symbols within the same file. However, if `rawMeta.file` is missing (i.e. `file` is `undefined`), the key resolves to `${i.name} `. Make sure this doesn't accidentally deduplicate unrelated symbols from different files that both have a missing `rawMeta.file`. While rare, checking `file !== undefined` before deduplication or fallback behavior is safer.

### B. Unioning Git Paths (`changedPathsNow` vs `stagedPathsNow`)
* **Context:** Task 2 updates `gitSummary` to union the staged and unstaged changes:
  ```ts
  const changedPaths = [...new Set([...repo.changedPathsNow(), ...repo.stagedPathsNow()])];
  ```
* **Review:**
  * This is clean, uses O(N) operations, and correctly aligns the panel count with `git status`.
  * Ensure that deleted files (which still show up in git changes) don't trigger errors when path operations are run on them elsewhere in the panel. Since this is just a path count (`changedPaths.length`), it is safe.

### C. Logging Payload Note Conditionality
* **Context:** Task 5 changes the pre-flight footer note based on:
  ```ts
  const bare = p.files.every((f) => !f.name.includes("/") && !f.name.includes("\\"));
  ```
* **Suggestion:** Ensure this check accounts for Windows style paths (`\\`) as well as POSIX style (`/`), which it does. Consider edge cases where files might have no directory but do have a colon (e.g., `logging.ts:11` - is that considered "bare"?). Since a colon isn't a directory separator, it will count as `bare` and show `REDACTION_NOTE`, which is correct since no directory paths are sent.

---

## 3. Recommended Verification Steps

During Task 9 (Verification), pay special attention to:
1. **`nimbus.context.enabled` Reactivity:** Verify that toggling the setting to `false` and back to `true` dynamically triggers the configuration listener, and that the view updates instantly without requiring a cursor move or file switch.
2. **Empty States:** Ensure that when the panel is disabled, the `DISABLED_NOTICE` markup styles match the look-and-feel of the rest of the Nimbus sidebar themes.
