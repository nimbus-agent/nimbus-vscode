# Review and Feedback: First-run Walkthrough — Design

**Date of Review:** 2026-07-17  
**Spec Reviewed:** [2026-07-17-walkthrough-design.md](2026-07-17-walkthrough-design.md)

---

## 1. Critical Suggestions & Improvements

### A. Completion Event for Step 6 (`explore`)
* **Current Design:** The `explore` step completes when the user runs the troubleshooter (`nimbus.troubleshootConnection`).
* **Critique:** Forcing users to run the connection troubleshooter to complete the "Explore" step is counter-intuitive, especially if they have just successfully connected in Step 2. It sends a mixed message (i.e., suggesting something is wrong when everything is working).
* **Recommendation:** 
  * Remove the explicit `completionEvents` (or set it to a default action that completes immediately upon selection).
  * Alternatively, map the button and completion event to a more positive/neutral explorer command, such as focusing the Nimbus sidebar: `workbench.view.extension.nimbus-sidebar` (or the corresponding sidebar view container ID).

### B. Initializing `nimbus.connected` Context Key on Startup
* **Current Design:** Context key is set in the connection state listener: `deps.commands.executeCommand("setContext", "nimbus.connected", s.kind === "connected")`.
* **Critique:** If the state listener only fires on changes, a user who is *already* successfully connected upon opening VS Code/the walkthrough will not see Step 2 complete automatically until a state transition occurs.
* **Recommendation:** Ensure that the initial connection state is evaluated and `nimbus.connected` is set immediately during extension activation/initialization, in addition to subscribing to subsequent state transitions.

### C. `vscode-shim` Alignment
* **Current Design:** The spec dictates that all `vscode` interactions must go through `src/vscode-shim.ts`.
* **Critique:** We must verify if the shim already exports/wraps `commands.executeCommand` for generic commands (like `setContext` and `workbench.action.openWalkthrough`).
* **Recommendation:** Ensure that `executeCommand` is exposed cleanly on the shim dependencies (`deps`), or add specific shimmed functions like `deps.commands.setContext(key, value)` and `deps.commands.openWalkthrough(id)` to keep the shim API typed and clean, avoiding raw stringly-typed calls directly in feature code if that violates shim design principles.

---

## 2. Open Questions & Points for Clarification

### Q1. Localization (l10n) Requirements
* **Context:** The markdown media files are stored as static files (`resources/walkthrough/*.md`).
* **Question:** Does Nimbus currently support multi-language localization? If so, does the walkthrough require localized markdown files (e.g., using VS Code's l10n subdirectories/naming conventions), or is English-only sufficient for Phase 1?

### Q2. Walkthrough Auto-Open Behavior
* **Context:** "No auto-popup, no `globalState`" is listed as a design decision to respect user preference.
* **Question:** VS Code sometimes automatically displays new walkthroughs to users upon extension installation or update if they are registered under `contributes.walkthroughs`. Have we verified if VS Code will auto-surface/popup this walkthrough for new users by default? If yes, does that conflict with the "passive + command" goal? (If we want to ensure it is *never* shown automatically by VS Code itself, we should confirm if VS Code provides a manifest field or behavior to control this).
