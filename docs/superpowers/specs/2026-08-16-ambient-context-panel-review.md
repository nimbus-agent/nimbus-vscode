# Design Review: Ambient Context Panel

This document contains a structured review, suggestions, improvements, and open questions for the [2026-08-16-ambient-context-panel-design.md](file:///C:/gitrep/nimbus-vscode/.claude/worktrees/ambient-context-panel/docs/superpowers/specs/2026-08-16-ambient-context-panel-design.md) design spec.

---

## 1. Open Questions

### A. Dirty/Modified Document Handling
* **The Issue:** The `blame` signal is cached on `path + line`, and the `related` signal on `path` or `selection`. If a file has dirty (unsaved) edits, the local line numbers might drift from the Git history or indexed database state.
* **Questions:**
  1. Does `ContextSnapshot` track whether the document is dirty (`TextDocument.isDirty`)?
  2. If a document has unsaved edits, should we indicate to the user that the blame/related signals might be stale, or should we disable them for dirty files/lines?
  3. When a document is saved (`workspace.onDidSaveTextDocument`), should we clear the cache for that specific file path?

### B. Gateway Disconnect Recovery
* **The Issue:** Under **5. Disconnected means skip, not fail**, when the Gateway is disconnected, the signals are skipped and render "needs the Gateway".
* **Question:**
  1. If the Gateway reconnects, does the controller automatically trigger a refresh/retry for the visible panel, or does the user have to trigger a cursor/selection change to wake it up? We should ensure the connection change event (`connection.onDidChangeState` or similar) forces a cache invalidation and snapshot collection.

---

## 2. Suggestions & Improvements

### A. Cache Invalidation Strategy
* **Current Spec:** Bounded LRU cache of ~50 entries per signal, cleared on disconnect.
* **Proposed Improvements:**
  * **File System / Git Events:** Invalidate cache entries for a file path when:
    * A file is saved (`workspace.onDidSaveTextDocument`).
    * The git repository status changes (e.g., a file is modified, staged, or checked out).
    * The editor text changes (perhaps debounce-invalidate or just drop cache for that file).
  * **Document Versioning:** Incorporate the VS Code `TextDocument.version` into the cache key for `blame` and `related` (when using selection). That way, any keystroke in the file eventually invalidates the old cached lines automatically.

### B. Selection Size Limits (Defensive Coding)
* **Current Spec:** `ContextSnapshot` includes `selection text`.
* **Proposed Improvement:**
  * If a user selects the entire contents of a huge file (e.g., 50,000 lines), passing that entire string to the snapshot and using it as a cache key or passing it to `searchRanked` could cause high memory usage or performance bottlenecks.
  * **Suggestion:** Cap the selection text length stored in `ContextSnapshot` (e.g., maximum 5000 characters). If it exceeds this, truncate it or omit it and indicate "Selection too large" in the snapshot data.

### C. Webview Visibility and Inactivity
* **Current Spec:** `WebviewView.onDidChangeVisibility` is used to pause/resume collection.
* **Proposed Improvement:**
  * While `WebviewView.visible` is a reliable check, it does not catch when the VS Code window itself loses focus or is minimized (which keeps the webview "visible" in the tab sense, but the user is not looking at it).
  * **Suggestion:** We should check if we can listen to window focus events (`window.state.focused`) or simply accept that window focus loss is a minor edge case. At a minimum, ensure visibility pause is robustly unit-tested.

### D. Security Command Allowlist
* **Current Spec:** Host validates every posted command against an allowlist.
* **Proposed Improvement:**
  * Define the allowlist statically or auto-derived strictly from structural types (e.g., `ReadonlyArray<string>`).
  * Ensure command arguments are also type-validated. For example, if `nimbus.brief.why` is invoked, the args must strictly match `{ ref: string, line: number }` rather than letting arbitrary JSON payloads flow into the execution channel.

---

## 3. Implementation Checkpoints (Minor Suggestions)

1. **VSIX Package Inspection:** Since `media/context.js` is added to the "must exist" check in `check-vsix-contents.mjs`, remember to verify that both `context.js` and `context.css` are correctly ignored/included in `.vscodeignore`.
2. **Settings Registry:** Ensure that the default for `nimbus.context.enabled` is documented correctly in `package.json` configurations so that `check-settings-docs.mjs` passes without warnings.
