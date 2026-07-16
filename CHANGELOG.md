# Changelog

## Unreleased

- **Quick Ask** (`Nimbus: Quick Ask…`) — a one-shot editor quick-ask: ask about
  the selection (or the whole file when nothing is selected) and get the reply in
  a read-only markdown tab, without opening the chat panel. Backed by
  `agentInvoke`; the file path is reduced to its basename so the absolute local
  path is not sent to the agent or the egress ledger.
- **Quick Ask presets** — the `Nimbus: Quick Ask…` command now opens a picker of
  preset actions (**Explain**, **Fix**, **Review**, **Docstring**) plus a
  **Custom question…** row. Picking a preset pre-fills the input box with its
  prompt, editable before sending. Presets are configurable via
  `nimbus.quickAsk.presets` (a non-empty list replaces the defaults).
- **Search** — the result limit is now configurable via `nimbus.search.limit`
  (default 50, clamped 1–500), and results the Gateway reports as having
  duplicates show a `(+N duplicates)` badge.
- **Nimbus activity-bar sidebar** with live, connection-aware tree views:
  - **Audit** — recent audit-log entries; click one to open its read-only detail.
  - **Sessions** — session history browser with chat resume.
  - **Index** — the local Nimbus index, with open-source and Ask actions.
  - **Agents** — configured agents, with an open-agent-chat action.
  - **Egress** — the egress ledger (destination.method + relative time, icon by
    result status); click a row for its read-only detail. Adds two commands:
    `Nimbus: Verify Egress Ledger` (hash-chain integrity check) and
    `Nimbus: Prove Egress Window` (saves a signed proof artifact for a chosen
    time window). Backed by the egress RPCs in `@nimbus-dev/client@0.4.0`.
- **Search** now queries the local index for real via the Gateway's ranked
  search (semantic + keyword), updating results live as you type; picking a
  result opens its source when it has one (otherwise a notice is shown), and
  **Search Selection** seeds the query with the selected text.
- Status-bar quick menu for common Nimbus actions.

## 0.2.0

- Extracted into its own repository (`nimbus-agent/nimbus-vscode`); consumes
  `@nimbus-dev/client` from npm and releases independently of the Gateway.
- Removed the non-functional `Nimbus: Run Workflow` command (it only pointed
  users at the terminal). A real workflow UI is tracked as future work.

## 0.1.x (in-monorepo releases)

- `Nimbus: Ask` — streaming chat in a persistent side panel.
- `Nimbus: Search` — Quick Pick over the local Nimbus index.
- `Nimbus: Ask About Selection` / `Nimbus: Search Selection` — editor
  right-click commands with selection context.
- Status bar: connection state + HITL pending count.
- Context-sensitive HITL: inline in chat when visible+focused; non-modal toast
  otherwise (modal opt-in via `nimbus.hitlAlwaysModal`).
- Theme-synced Webview (Dark, Light, High Contrast).
- Gateway-backed transcript rehydration via `engine.getSessionTranscript`.
