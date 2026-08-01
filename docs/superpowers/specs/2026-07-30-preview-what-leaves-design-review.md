# Review: "Preview what leaves" pre-flight — design

This document contains a design review, open questions, suggestions, and improvements for the [2026-07-30-preview-what-leaves-design.md](file:///C:/gitrep/nimbus-vscode/docs/superpowers/specs/2026-07-30-preview-what-leaves-design.md) specification.

---

## 1. Critical UX & VS Code API Conflict

### The "Show full text" Modal Blockage
> [!CAUTION]
> **VS Code API Constraint:** A modal dialog (`showWarningMessage` with `{ modal: true }`) is **fully blocking**. 

* **The Problem:** If the extension opens the read-only editor tab with the verbatim prompt and immediately re-shows the modal dialog, the user will **not** be able to scroll, search, copy, or read the tab contents. The modal dialog must be dismissed before the user can interact with the editor behind it.
* **Suggested Solutions:**
  1. **Non-blocking Dialog during review:** Instead of a modal dialog, use a non-modal warning notification or a `QuickPick` which allows slightly better context switching (though QuickPick is still somewhat blocking, it allows cursor movement).
  2. **Editor-based Actions:** When opening the read-only tab, use a custom document scheme (e.g., `nimbus-preview:`) and register a [CodeLens](https://code.visualstudio.com/api/references/vscode-api#CodeLensProvider) or an editor title bar button (menu contribution `editor/title`) with "Send Payload" and "Cancel" actions. This allows the user to inspect the file naturally and click a button directly in the editor to proceed.
  3. **Deferred Modal:** Open the tab first, and show a status bar item or a non-modal message "Reviewing outbound payload. [Approve] [Cancel]".

---

## 2. Multi-root Workspace Support

### Checking `rootHint`
* **The Problem:** The payload defines `rootHint?: string` (singular) representing the repository root. VS Code supports multi-root workspaces where a user can have multiple repositories/folders open in the same window.
* **Suggested Solution:** Change `rootHint` to `rootHints?: readonly string[]` and populate it with the root paths of all workspace folders (e.g. using `vscode.workspace.workspaceFolders`). The leak checker should check the outbound prompt against all roots to prevent leaks from any active workspace folder.

---

## 3. Leak Checker Scope & False Positives

### What else should we check?
* **Absolute Path Leaks:** Besides `repo.rootPath`, should the leak check scan for other common absolute paths that might leak? For example:
  * The user's home directory (`os.homedir()`).
  * System temp directories (`os.tmpdir()`).
* **Multi-OS Path Formats:** If a user is on Windows but running a dev container or WSL, path separators might be mixed (`\` vs `/`). The leak check should search for both forward-slash and back-slash variations of the root paths.

---

## 4. Performance & Memory Management

### Large Prompt Payload Buffering
* **The Problem:** The `lastPayload` is stored in-memory to support the `nimbus.showLastOutbound` command. A large diff or prompt could easily be several megabytes.
* **Suggested Solution:** To prevent memory bloat or memory leaks, ensure that `lastPayload` is cleared or garbage-collected appropriately, or stored as a reference that is easily garbage collected when no longer needed. Since it's only a single last payload, memory consumption is generally bounded, but we should make sure we don't accidentally leak older payloads in any array/list.

---

## 5. LM Tools Integration

### Confirmation Cards
* **Question:** For LM tools (`lmTool`), the spec states that the gate behaves as "record-only — the confirmation happened upstream". 
* **Details:** Does the upstream confirmation card in VS Code show the redacted paths and warning messages, or does it just show a generic confirmation? If we cannot run our leak check or customize the details of the native confirmation card, is there a risk that absolute paths or secrets leak via the LM Tools path without the user being warned?
* **Suggestion:** Investigate if we can intercept/pre-process the payload before the native `prepareInvocation` confirmation card is shown to perform the leak check and inject any warnings into the confirmation message itself.
