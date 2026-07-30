# Review: "Preview what leaves" pre-flight gate — Implementation Plan

This document contains a review, suggestions, and improvements for the implementation plan at [2026-07-30-preview-what-leaves.md](file:///C:/gitrep/nimbus-vscode/docs/superpowers/plans/2026-07-30-preview-what-leaves.md).

---

## 1. UX Improvement Implemented in the Plan
* **Observation:** The implementation plan successfully resolves the VS Code modal blocking issue highlighted in the design review. 
* **Details:** In **Task 5 (Step 3)**, `askAfterFullText` uses a **non-modal** message (`{}` options instead of `{ modal: true }`) for the second confirmation dialog. This allows the user to fully inspect, scroll, and search the newly opened read-only tab before confirming or cancelling the send.

---

## 2. Multi-root Workspace Support
* **Observation:** In **Task 7 (Step 3)**, `egressRoots` is implemented as:
  ```ts
  const egressRoots = (): readonly string[] => {
    const folders = deps.workspace.workspaceFolders ?? [];
    return [...folders.map((f) => f.uri.fsPath), homedir()];
  };
  ```
  This correctly collects root paths from all folders in a multi-root workspace and the home directory, addressing the multi-root concern.
* **Suggestion:** We should check if `workspaceFolders` can change dynamically during a session. Since `egressRoots` is a function executed dynamically on each check/record (`deps.roots()`), it will successfully pick up workspace folder changes.

---

## 3. Short Path Needles and False Positives (Leak Checker)
* **Observation:** `MIN_NEEDLE_LENGTH = 5` is used to prevent false positives from short path needles (like `/` or `/tmp`).
* **Open Question:** What if a user's home directory is `/root` (4 characters) or `/home`? Under the current plan, these needles will be ignored entirely.
* **Suggestion:** Instead of silently ignoring needles under 5 characters, we could apply a more precise matching strategy for short needles (e.g., checking if the needle matches with boundary characters like slashes, spaces, or quotes, rather than a raw `.includes` check). If we stick to the `MIN_NEEDLE_LENGTH = 5` threshold, we should document this limitation in the source code comments of `leak-check.ts`.

---

## 4. Drive Letter Case Sensitivity in Windows Paths
* **Observation:** VS Code frequently exposes paths with lowercase drive letters (e.g., `c:\path`) while other tools/Node APIs might use uppercase (e.g., `C:\path`).
* **Validation:** The leak check logic converts both the haystack and the path variants to lowercase:
  ```ts
  const haystack = text.toLowerCase();
  // ...
  const found = pathVariants(root).some((v) => haystack.includes(v.toLowerCase()));
  ```
  This is extremely robust and correctly handles drive letter case mismatch on Windows.

---

## 5. Potential Temp Directory Leaks
* **Suggestion:** Consider adding the system temp directory (`os.tmpdir()`) to the roots list if its length is >= 5. This would capture leaks from temporary files generated during diff or SCM operations.
