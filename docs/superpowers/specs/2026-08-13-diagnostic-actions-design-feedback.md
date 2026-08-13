# Feedback & Suggestions: Diagnostic Actions Design

This document contains open questions, suggestions, and proposed improvements for the [Diagnostic Actions Design Spec](file:///C:/gitrep/nimbus-vscode/docs/superpowers/specs/2026-08-13-diagnostic-actions-design.md).

---

## 1. Open Questions

### Q1.1: Does "Find prior occurrences" work when offline?
* **Context:** The design states: *"while disconnected, `actions.ts` offers nothing"* (Part 6). However, Part 1 states that "Find prior occurrences" is not gated, reaches no model, and only queries the local index via `searchRanked`.
* **Question:** If the user is disconnected from the model/remote server, can we still offer "Find prior occurrences"? If the Gateway runs locally, the local search should still be fully functional. Complete blockage of all actions might unnecessarily degrade the offline/local utility of the extension.

### Q1.2: CodeActionKind Grouping in VS Code
* **Context:** Code actions are ordered and filtered by VS Code using `CodeActionKind` (e.g., `QuickFix`, `Refactor`).
* **Question:** Which `CodeActionKind` will these actions carry? 
  * "Suggest a fix" maps naturally to `CodeActionKind.QuickFix`.
  * "Explain this problem" and "Find prior occurrences" might fit better under a custom kind or `CodeActionKind.Empty` to avoid polluting standard quick-fix keyboard shortcuts (like `editor.action.quickFix` which might automatically apply the first available quick-fix).

### Q1.3: Handling Multiple Diagnostics on the Same Line
* **Context:** It is common for a single line or range to trigger multiple diagnostics (e.g., a TypeScript compiler error and an ESLint warning).
* **Question:** If there are multiple diagnostics, will we offer three actions *per diagnostic*? A list of 6–9 lightbulb actions for a single line could create significant visual noise. Should we:
  * Limit the total number of Nimbus actions shown at once?
  * Group them (e.g., a single "Explain..." action that handles the primary/most severe diagnostic, or prompts the user)?
  * Deduplicate/filter based on severity or source?

---

## 2. Improvements & Suggestions

### Suggestion 2.1: Performance, Caching, and Debouncing
VS Code invokes `provideCodeActions` frequently (e.g., during cursor movement, selection changes, typing pauses). 
* **Proposal:** Normalize and cache diagnostics/actions. If the cursor moves within the same diagnostic range, we should return the cached action descriptors rather than re-normalizing the message or checking the connection state again.

### Suggestion 2.2: Extensible Quoted-Token Policy
* **Context:** The design proposes a hardcoded `Record<string, "keep" | "drop">` for quoted tokens based on `diagnostic.source`.
* **Proposal:** Provide a clear extension point or dynamic mapping. Other common sources like `pyright`, `gopls`, or `rustc` have different quoting conventions. In the future, we could allow adding patterns/regexes via the configuration or extending the dictionary dynamically without modifying code.

### Suggestion 2.3: Filtering by Diagnostic Source
* **Context:** The current design filters by severity (`Error` and `Warning` only).
* **Proposal:** Some linters/sources can be extremely verbose with warnings (e.g., style warnings from older ESLint configs). We should consider adding a setting `nimbus.diagnostics.ignoredSources` (array of strings, e.g. `["tslint", "some-noisy-linter"]`) so users can mute Nimbus actions on diagnostics from specific sources.
