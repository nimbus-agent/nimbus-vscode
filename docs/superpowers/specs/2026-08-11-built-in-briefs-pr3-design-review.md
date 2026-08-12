# Review & Suggestions: Built-in briefs, PR 3 Design

This document reviews the design proposed in [2026-08-11-built-in-briefs-pr3-design.md](./2026-08-11-built-in-briefs-pr3-design.md) and outlines suggestions, improvements, and open questions.

---

## 1. Scope of Namespace Storage (`workspaceState`)

### Observation
The design specifies that the last-used namespace is stored in `workspaceState` (via `src/briefs/namespace-store.ts`) to prefill the prompt for subsequent Preflight runs:
> Prefill order: the workspace-remembered last value → the `nimbus.briefs.defaultNamespace` setting → blank.

### Open Questions / Suggestions
* **Multi-Root Workspaces & Multi-Repo setups:** `workspaceState` is shared across the entire VS Code window. If a user has a multi-root workspace (multiple projects open in one window) or switches branches/folders, a single global namespace key will overwrite other projects' remembered namespaces.
* **Proposed Improvement:** Key the `workspaceState` cache by the active workspace folder's URI or the repository root URI (e.g., `namespace:${rootUri}`). This ensures that running a preflight in project A doesn't overwrite or prefill the namespace for project B.

---

## 2. Input Validation for Janitor's `idleDays`

### Observation
The design notes:
> `idleDays`, optional. Empty means omit the parameter and let the Gateway use its own default; a non-numeric answer is rejected by the input box's `validateInput` rather than silently dropped.

### Suggestions
* **Boundary Validation:** We should explicitly define what constitutes a valid number. For instance, should we reject:
  * Negative numbers (`-5`)?
  * Floating-point numbers (`2.5`)?
  * Excessively large integers (e.g. `> 3650`)?
* **Proposed Improvement:** The `validateInput` function should enforce that `idleDays` (if provided) is a positive integer (e.g., matching `/^[1-9]\d*$/`).

---

## 3. Active Editor Prefill Safeguards for Janitor's `resourceRef`

### Observation
The design notes:
> `resourceRef`, prefilled with the active editor's relative ref when there is one, since a file is a plausible resource and a prefill the user can overwrite costs nothing.

### Suggestions
* **Scheme Verification:** If the active editor is a non-file document (e.g., the Nimbus read-only JSON result tab, a settings editor, a git diff view, or an output panel), prefilling with its URI could result in confusing or invalid input.
* **Proposed Improvement:** Restrict the prefill logic to only extract `resourceRef` if the active editor's document scheme is `file`. If the document is unsaved ("Untitled"), it should also be ignored.

---

## 4. Egress Gate & Restricted Mode Behavior for the Ops Three

### Observation
The design notes that the three ops briefs (`catchup`, `expert`, `impact`) are routed under kind `"participant"` via `gate.record` (no prompting):
> Routing them under kind `"brief"` would drop a workbench-blocking modal into the middle of a chat turn, and would do it on the strength of an argument the user had just typed.

### Open Questions
* **Restricted Mode / Strict Egress Policies:** If the workspace is in Restricted Mode, does `gate.record` still allow the payload to pass through silently, or does it block it?
* **Egress Leak Prevention:** If a user has a policy that prohibits outbound transmission of certain file paths (e.g., files matching a secret pattern), does routing via `"participant"` (which doesn't block/prompt) bypass this restriction?
* **Proposed Clarification:** We should explicitly specify in the test cases and code whether `gate.record` respects Restricted Mode blocks, or if `"participant"` is exempted from block rules because the parent chat turn is already gated.

---

## 5. Scope of `nimbus.briefs.defaultNamespace` Setting

### Observation
The setting is described as:
> `nimbus.briefs.defaultNamespace` | string | `""`

### Suggestions
* **Setting Scope:** Since default namespaces are highly project-specific, this setting should be registered with `resource` scope (i.e., `"scope": "resource"` in `package.json`).
* **Benefit:** This allows users to configure different default namespaces per folder in a multi-root workspace or per project in `.vscode/settings.json`.

---

## 6. Execution Flow of Command Retries

### Observation
The design specifies:
> Retry re-runs the command with the same pre-resolved args, so nothing is re-prompted for — and it goes back through the gate like any other send.

### Suggestions
* **Command Registry Compatibility:** Ensure that the registered command handlers (e.g., `nimbus.brief.preflight`) check if they were invoked with a full parameter payload (including the resolved namespace and ref) to skip prompts during retry.
* **Verification:** Ensure that the arguments structure passed to the retry command matches the signature of the command's pre-resolved arguments pathway.
