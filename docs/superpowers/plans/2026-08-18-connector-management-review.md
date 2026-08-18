# Plan Review: Connector Management & Index Health Implementation Plan

This document contains a structured review, suggestions, improvements, and open questions for the [2026-08-18-connector-management.md](2026-08-18-connector-management.md) implementation plan.

---

## Dispositions (2026-08-18)

Three adopted, one declined as already-correct. 1B was the valuable one: it
caught the plan contradicting a convention the repo already has.

| # | Point | Disposition | Where |
| --- | --- | --- | --- |
| 1A | Debouncer as a subscription | **Declined — already correct.** `Debouncer` is `{ trigger(): void; dispose(): void }` and `DisposableLike` is `{ dispose(): void }`, so it satisfies the interface structurally and `ctx.subscriptions.push(connectorRefresh)` typechecks. A wrapper object would add a layer for nothing. Comment added stating why | Task 9, step 5 |
| 1B | Commands invoked with no node | **Fixed.** `resolveTarget` falls back to a QuickPick over registered connectors, reports a listing failure, and says something true when there are none — mirroring `createWorkflowCommands`' `pick`. Five tests added | Task 8 |
| — | (consequence of 1B) | The manifest no longer hides these commands from the palette. The repo hides a command only when it *cannot* work without its node (`openIndexItem`, the diagnostic actions); `nimbus.runWorkflow` is palette-visible because it prompts. These now prompt, so they follow that half of the convention. The manifest test asserts the opposite of what it did | Task 9 |
| 2A | Defensive node handling | **Fixed.** `resolveTarget` checks `typeof node === "object" && node !== null` before reading a payload, which also removes the `as { label: string } & Node` cast the old `target` needed. A non-object argument now falls through to the picker instead of being coerced | Task 8 |
| 2B | F5 findings filename | **Fixed.** Concrete name, with an instruction to use the real verification date if the pass runs on another day | Task 11, step 5 |

---

## 1. Open Questions

### A. Debouncer Interface Compatibility in VS Code Subscriptions
* **The Issue:** In Task 9, step 5, the plan adds a debouncer to the extension's subscriptions:
  ```ts
  const connectorRefresh = createDebouncer(250, () => connectorsView.refresh());
  ctx.subscriptions.push(connectorRefresh);
  ```
* **Questions:**
  1. Does `createDebouncer` returned from `./context/debounce.js` strictly implement the `Disposable` interface (i.e. does it have a `dispose()` method)?
  2. If it does not, we should either wrap it in a custom disposable object or invoke its custom cleanup method in a callback registered with `ctx.subscriptions.push({ dispose: () => connectorRefresh.dispose() })` to prevent memory leaks during extension deactivation/reconnects.

### B. Command Invocation without Node Arguments
* **The Issue:** Task 8 describes commands mapped in `createConnectorCommands` like:
  ```ts
  "nimbus.syncConnector": async (node) => {
    const t = target(node);
    if (t === undefined) return;
    ...
  }
  ```
* **Questions:**
  1. If a command is triggered via a keyboard shortcut, an API call, or custom workflow execution rather than clicking a specific TreeView row, the `node` parameter will be `undefined`.
  2. Is this behavior acceptable, or should we prompt the user with a QuickPick of registered connectors if `node` is `undefined`, rather than silently returning early?

---

## 2. Suggestions & Improvements

### A. Defensive Handling of Unknown Tree Nodes
* **Current Plan:** `target(node)` is defined as:
  ```ts
  const target = (node?: unknown): { serviceId: string; itemCount: number } | undefined =>
    connectorPayloadOf((node ?? {}) as { label: string } & Node);
  ```
* **Improvement:** 
  * VS Code sometimes passes arbitrary contexts to commands. We should verify that `node` is indeed an object containing a valid `payload` before attempting to cast it. Utilizing a safe checker inside `connectorPayloadOf` is good, but adding a check like `if (typeof node !== "object" || node === null)` at the start of `target` prevents unexpected runtime type errors.

### B. F5 Findings Filename Template
* **Current Plan:** Task 11 mentions writing the findings to `docs/superpowers/plans/2026-08-<dd>-connector-f5-findings.md`.
* **Improvement:**
  * Since multiple developers or runs might work on this spec, suggest using the specific verification date for `<dd>` (e.g., `2026-08-18-connector-f5-findings.md`) to keep findings cleanly organized and aligned with the plan's timestamp.
