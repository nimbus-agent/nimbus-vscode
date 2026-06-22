# Changelog

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
