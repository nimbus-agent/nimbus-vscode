# Design Review: Context-grounded Ask

This document contains a structured review, suggestions, improvements, and open questions for the [2026-08-19-context-grounded-ask-design.md](2026-08-19-context-grounded-ask-design.md) design spec.

---

## Dispositions (2026-08-19)

Six adopted, one deferred. **1C found a factual error in the spec**, not merely
an ambiguity.

| # | Point | Disposition | Where |
| --- | --- | --- | --- |
| 1A | Selection: snapshot vs range | **Fixed** — a selection stores its **text, captured at attach**; a file stores a path read at send. A stored range drifts under edits, so by send time `L12–30` can cover different code, and sending that as "the code you selected" is worse than sending nothing. The range is provenance, not a pointer. Chip: `selection · foo.ts (L12–30) · captured at attach` | *A selection is a snapshot; a file is a path* |
| 1B | Post-send lifecycle | **Fixed** — three separate pieces of state, spelled out: the sent turn keeps its resolved manifest as a permanent record, the composer keeps its attachments (session-scoped, so a follow-up inherits them), and the resolved sizes become the next turn's provisional baseline. Sent chips are not detachable; composer chips are | *What happens to the chips after send* |
| 1C | `truncateAtHunkBoundary` on a plain file | **Fixed — the spec was wrong.** That helper splits a diff into hunks and returns `undefined` when there are none; `selectWithinBudget` likewise takes `{path, diff}` entries. Neither transfers to a continuous file. Only `isSecretPath` is reused; clamping is our own, cut at a **line boundary** so the last line of a clamped block is whole | *Architecture*, *The payload* |
| 2A | Chip layout in a crowded composer | **Fixed** — chips wrap or scroll in their own container and never compress the text area; the running total stays visible; sent chips are visually distinct from live ones | *The payload* |
| 2B | Drag-and-drop from the Explorer | **Deferred, with the reason recorded** — additive rather than load-bearing, and its edge cases (folders, files outside the workspace, untitled buffers, multi-select) each need chip vocabulary this slice has not earned yet. Grouped with typed `@`-mentions as the follow-up that makes attaching fluent | *Scope* |
| 2C | Content-based secret checking | **Fixed as documentation** — `isSecretPath` matches names, not contents, and this design does not scan bodies. Stated plainly because a user seeing "possible secret · not sent" on one chip will assume the others were checked the same way. Same limitation *Review Changes* ships with | *Architecture* |
| 2D | Distinct icons for file vs index item | **Fixed** — file icon for the working tree, database icon for the index, because the two can disagree about the same path and a label alone is easy to skim past | *Attaching* |

Two of these are now pinned by tests rather than prose: a selection ignores
later edits to its file, and a file attachment does not — the asymmetry a reader
is most likely to mistake for a bug.

---

## 1. Open Questions

### A. Editor Selection Attachments: Snapshot vs. Dynamic Range
* **The Issue:** Under **Attaching**, one entry point is the "editor selection". If a user selects a block of text and attaches it, how is it represented?
* **Questions:**
  1. Do we snapshot the selected text *at the moment of attachment*, or do we track the file path and line/character `Range`?
  2. If we track the `Range`, how do we handle edits in the document that shift the range or modify the text within it?
  3. If we snapshot, how does that align with the load-bearing rule that "Bytes resolve at send, not at attach"? (A snapshot at attach time guarantees the user's intent when selecting, whereas resolving at send might capture completely different code if the user edited the file in the meantime).
  4. What does the chip display for a selection? e.g., `selection · foo.ts (L12-30)`?

### B. UI Lifecycle: Composer vs. Chat History
* **The Issue:** The design states "The controller posts the resolved manifest to the webview before the request goes out, so the chips render what was actually assembled."
* **Questions:**
  1. Once sent, is the resolved manifest (showing final bytes, clamped state, or refusal status) attached permanently to the *sent message* in the chat history?
  2. Does the composer clear its draft attachments immediately after the request is fired?
  3. Since attachments persist across session turns, are they cloned from the resolved state back into draft state for the next turn, or do they remain in the composer as active chips?

### C. Clamping Rules for Raw Files vs. Diff Hunks
* **The Issue:** The design notes that `attachments.ts` will reuse helper functions like `truncateAtHunkBoundary` from `src/scm/diff.ts`.
* **Question:**
  1. A workspace file is a continuous document rather than a git diff with hunks. How does `truncateAtHunkBoundary` apply to a plain file? We should specify that plain files are clamped line-by-line up to the budget, rather than attempting hunk-based truncation.

---

## 2. Suggestions & Improvements

### A. Layout and Wrap in Composer UI
* **Scenario:** A user attaches 5–6 files/index items.
* **Suggestion:** The composer UI should support wrapping or scrolling for the attachment chips. Ensure that:
  * Chips wrap to a new line or scroll horizontally in a dedicated scroll container so they do not compress the main text area of the composer.
  * There is a clear visual distinction between active draft chips in the composer and sent chips in the chat history.

### B. Drag-and-Drop Files/Selection Support
* **Scenario:** Friction of opening the Quick Pick menu for files.
* **Suggestion:** Consider support for drag-and-drop of files from the VS Code Explorer directly into the chat webview. 
  * While `@`-autocomplete is out-of-scope for Phase 2, basic HTML drag-and-drop handling for files in the webview is relatively low effort and drastically improves usability.

### C. Context-Based Secret Checking
* **Scenario:** The path-based `isSecretPath` checks for `.env` or `key.pem`, but the user might attach a regular `.ts` file that contains an accidental API key or credential.
* **Suggestion:** Keep content-based secret checks out of scope for the initial implementation to avoid performance overhead, but explicitly document this limitation (i.e., that `isSecretPath` only filters by file name/pattern).

### D. Distinction Between "File on Disk" and "Index Item" in UI
* **Scenario:** The picker blends workspace files and index items.
* **Suggestion:** Use distinct icons for files vs. index items (e.g., standard VS Code file icons vs. a database/index icon) to make it immediately obvious to the user what type of context they are attaching.
