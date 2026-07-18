# Review and Feedback: First-run Walkthrough Implementation Plan

**Date of Review:** 2026-07-17  
**Plan Reviewed:** [2026-07-17-walkthrough.md](2026-07-17-walkthrough.md)

---

## 1. Positive Feedback & Alignment
* **Early Return Safety:** The plan correctly highlights that the `setContext` call must be placed *before* the `if (s.kind === "connected")` check/return branch in `connection.onState`. This is a vital catch to ensure context updating isn't bypassed.
* **Explore Step Action Alignments:** The plan updates the final "Explore" step completion from the design spec (which used `nimbus.troubleshootConnection`) to `workbench.view.extension.nimbus`. This is a much better user experience since users shouldn't have to troubleshoot connection just to finish a walkthrough.

---

## 2. Improvements & Suggestions

### A. Context Key Setup in Test Fixtures
* **Detail:** In `test/unit/extension.test.ts`, the tests for connection state checking look like:
  ```ts
  test("sets nimbus.connected=true once the Gateway connects", async () => { ... });
  ```
* **Suggestion:** We should check if the mock setup (`makeFixture`) or initialization calls `executeCommand` with `setContext` during activation before any events occur. Ensure that the test asserts that `nimbus.connected` is set initially to matches the current connection state.

### B. Verify VS Code's Triggering of `onCommand:workbench.view.extension.nimbus`
* **Detail:** The walkthrough step uses `"completionEvents": ["onCommand:workbench.view.extension.nimbus"]` to mark the Explore step as complete when the user opens the sidebar.
* **Suggestion:** While clicking the markdown command link `[Open the sidebar](command:workbench.view.extension.nimbus)` triggers the command and marks it complete, clicking the activity bar icon directly with the mouse *might not* always register as an `onCommand` event in all VS Code versions (as VS Code sometimes bypasses the command registry for direct UI clicks). 
* **Action:** In Task 3 (Verification), make sure to test completing the final step by both:
  1. Clicking the command link button in the walkthrough.
  2. Clicking the Nimbus Activity Bar icon directly in the UI.
  If the direct UI click doesn't trigger completion, we can consider adding `onView:nimbus.auditView` or `onView:nimbus.egressView` to the `completionEvents` array to ensure a robust checkmark experience.

---

## 3. Open Questions

* **Q1. Command Registration Order:** Are command registration handlers in `extension.ts` order-sensitive or grouped in any logical categories? Ensure that `register("nimbus.openWalkthrough", ...)` is grouped cleanly next to related diagnostics/connection commands (e.g. `nimbus.reconnect` or `nimbus.openLogs`).
