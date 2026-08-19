# Plan Review: Context-grounded Ask Implementation Plan

This document contains a structured review, suggestions, improvements, and open questions for the [2026-08-19-context-grounded-ask.md](2026-08-19-context-grounded-ask.md) implementation plan.

---

## Dispositions (2026-08-19)

All four adopted. **1A and 1B were bugs that would have shipped broken
behaviour**, not ambiguities.

| # | Point | Disposition | Where |
| --- | --- | --- | --- |
| 1A | `looksBinary` checking a space | **Fixed — root cause found.** Not a typo: the plan file contained **four raw NUL bytes**, which git reported as a binary file and which rendered as spaces to every reader, the reviewer included. The intent (`includes("\0")`) was right; the encoding was not. All four are now two-character `\0` escapes, with a comment saying why the literal must never come back. Had it shipped as read, every source file containing a space — i.e. all of them — would have been refused as binary | Task 1 |
| 1B | Cache unprimed at attach time | **Fixed** — a real broken first render. `attach()` posts provisional chips synchronously, so an unprimed cache would show a perfectly readable file as `unreadable · not sent`. A `cacheFile(path)` helper now runs before every `file` attachment, and the spec's own promise ("about 4 KB, measured when attached") depends on it. Covered by a new test | Task 3, plus a test in Task 2 |
| 2A | Composer stuck non-provisional after send | **Fixed** — the composer returns to provisional in the same tick as the send, so no flicker. The resolved numbers belong to the turn, which keeps them permanently; for the composer they are already an estimate, because the attachments carry into the follow-up and will be re-read | Task 2 |
| 2B | Index-based id↔chip zip | **Fixed** — zipped by object identity instead. The index alignment was correct today and silently wrong the moment `buildAttachedContext` filters anything, and the symptom would be a remove button deleting the wrong chip, which nobody would suspect the zip for | Task 2 |

One knock-on the review did not raise: adding 2A's second post made the ordering
test weaker than it looked, since "some `attachments` message preceded
`askStream`" would pass even if the *resolved* one came after. That test now
pins the resolved post specifically — the composer being the pre-flight preview
is the entire argument for Ask not prompting, so that ordering is the feature.

---

## 1. Open Questions

### A. Space Check vs. NUL Byte in `looksBinary`
* **The Issue:** In Task 1, step 3, the proposed implementation of `looksBinary` is:
  ```ts
  export function looksBinary(text: string): boolean {
    return text.includes(" ");
  }
  ```
  However, the test case in Step 1 asserts:
  ```ts
  test("a NUL byte marks it binary", () => {
    expect(looksBinary("abc def")).toBe(true); // Wait, this has a space, not a NUL byte!
  });
  ```
* **Questions:**
  1. Is this a typo in the plan? Checking for a space (`" "`) will classify almost all natural language and source code documents as binary, refusing them.
  2. Should the implementation check for NUL bytes (`"\0"`) instead, i.e., `text.includes("\0")`?
  3. Should the test case be corrected to `expect(looksBinary("abc\0def")).toBe(true)`?

### B. Read Timing and Cache Priming in Draft Phase
* **The Issue:** `buildAttachedContext` runs synchronously on `attach()` and `detach()`, and reads file contents via `deps.readFile` (which maps to `attachmentCache.get(path)`). However, `attachmentCache` is only primed inside `primeAttachments` immediately before calling `ctl.start()`.
* **Questions:**
  1. When a user first attaches a file, `postAttachments(true)` is immediately triggered. At this point, the cache has not been primed for that file. Will the composer render the newly attached file as `unreadable · not sent`?
  2. To resolve this, should the attachment commands (like the picker or editor action) prime `attachmentCache` for the specific path *before* calling `chatController.attach()`?

---

## 2. Suggestions & Improvements

### A. Clarification on Provisional Status in Composer after Send
* **Scenario:** Attachments survive the turn since they are session-scoped.
* **Suggestion:** When `start()` runs, it calls `postAttachments(false)` to post the resolved non-provisional manifest. However, once the response starts/finishes streaming, or when the user starts typing their next follow-up, the active attachments in the composer should return to a `provisional: true` state (since they might be edited before the next send). Ensure the webview/controller updates the composer back to provisional state for subsequent inputs.

### B. Safe Map-to-ID Alignment in `postAttachments`
* **Scenario:** The `postAttachments` function maps indices to keys:
  ```ts
  const ids = [...attached.keys()];
  chips: built.chips.map((c, i) => ({
    id: ids[i] ?? "",
    ...
  }))
  ```
* **Suggestion:** Since `Map.prototype.keys()` and `values()` both preserve insertion order, this is structurally correct. However, to make it completely robust and self-documenting, consider storing the generated ID directly inside the `Attachment` structure or returning a mapped list of `{ id, attachment }` pairs from the controller's internal state.
