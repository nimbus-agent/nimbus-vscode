# Design Review: Connector Management & Index Health

This document contains a structured review, suggestions, improvements, and open questions for the [2026-08-18-connector-management-design.md](2026-08-18-connector-management-design.md) design spec.

---

## Dispositions (2026-08-18)

Every point below was answered in the design spec. Four were adopted, two
adopted in part, one declined on evidence, one found not implementable.

| # | Point | Disposition | Where |
| --- | --- | --- | --- |
| 1A | Concurrent mutations | **Fixed** — two guards: a `.syncing` `contextValue` hiding the sync family, and an in-flight `serviceId:command` set in `commands.ts`. Pause and Remove stay available mid-sync on purpose | *Write operations → Concurrency* |
| 1B | HITL timeout | **Declined, on evidence** — the Gateway already bounds the wait and reports it through `GatedRejection`. Adopted the half that matters: the `reason` is shown verbatim so an expiry does not read as a human denial | *The two blocking calls* |
| 1C | Credential validation | **Fixed in part** — required-non-empty and trimming, yes; URL/path format checking, no | *Credentials → Validation stops at emptiness* |
| 2A | MCP command line in the tooltip | **Not implementable** — `commandLine` is an input to `connectorAddMcp` and appears in no result or status type. Recorded as a Phase 4 want, not a backlog task | *Scope* |
| 2B | Debounce panel updates | **Fixed** — both consumers take `configChanged` through `createDebouncer(250, …)`; in-flight coalescing does not cover a burst that lands between refreshes | *The view → Liveness* |
| 2C | Sanitise error text | **Declined for the UI, fixed for the log** — the text is the user's own and is what makes an error actionable, so it renders verbatim; it is never written to the output channel, which is the copy that travels | *On expand* |

Two of these are claims rather than facts, and both are now on the F5
verification list: that an unanswered consent request settles on its own
(step 10), and that the `.syncing` menu guard behaves (step 11).

---

## 1. Open Questions

### A. Concurrent Mutations & Action Guarding
* **The Issue:** A user could trigger multiple write operations (e.g., "Sync now", "Full re-sync", "Re-index", "Remove") on a single connector simultaneously, or trigger mutations while a connector is already in a `syncing` status.
* **Questions:**
  1. Should we disable destructive or mutating commands (like "Remove", "Full re-sync", "Re-index", "Sync now") when a connector's status is `syncing`?
  2. Can we use VS Code `when` clauses in `package.json` (via custom `contextValue` flags) to prevent concurrent operations? E.g., setting a `nimbus.connector.syncing` context value.

### B. HITL Progress Infinite Spinner / Timeout
* **The Issue:** `connectorAddMcp` and `connectorRemove` use non-cancellable `withProgress` bars. If a user walks away or ignores the Gateway's HITL request, the progress bar will spin indefinitely.
* **Questions:**
  1. Does the Gateway/Client RPC have a built-in timeout after which the promise rejects/resolves with a timeout outcome?
  2. If the Gateway does not enforce a timeout, should the extension implement a defensive timeout (e.g., 2–5 minutes) to close the progress notification and alert the user?

### C. Client-Side Credential Field Validation
* **The Issue:** The credential flow gathers fields using `showInputBox`. If a user enters a completely invalid value (e.g., an empty string for a required field, or an invalid URL format for `apiBaseUrl`), the request travels to the Gateway only to be rejected.
* **Questions:**
  1. Should the extension perform basic client-side validation (e.g., checking if required fields are non-empty) before submitting `connectorAuth`?
  2. For URLs and paths (`apiBaseUrl`, `gcpCredentialsJsonPath`), should we do light format/sanity checking to provide immediate feedback?

---

## 2. Suggestions & Improvements

### A. MCP Command Line Visibility in Tooltips
* **Current Spec:** Editing a registered MCP connector's command line is out.
* **Proposed Improvement:**
  * While editing is out of scope, displaying the command and arguments of registered MCP connectors in their row's tooltip or description would be very useful. This aligns with Nimbus's security-conscious posture, allowing users to verify what command/executable is running under their editor's context without opening the CLI.

### B. Debouncing Webview / Context Panel Updates
* **Current Spec:** The context panel's Sources row is invalidated on `connectorConfigChanged` and any mutation.
* **Proposed Improvement:**
  * If the Gateway sends multiple config-changed notifications or sync updates in quick succession, we should debounce the context panel collector (e.g., by 250ms) to prevent unnecessary re-renders of the webview context panel.

### C. Error Sanitization in Telemetry Rows
* **Current Spec:** Telemetry rows display the `errorMsg` when present.
* **Proposed Improvement:**
  * Gateway errors can sometimes contain sensitive database path configurations, database usernames, or connection string details. 
  * While the Gateway should ideally sanitize its error payloads, the extension's telemetry rows should do a quick check (or the adapter should ensure clean message extraction) so that sensitive data is not accidentally exposed in plain text in the UI tooltips or views.
