# Changelog

## [0.21.1](https://github.com/nimbus-agent/nimbus-vscode/compare/v0.21.0...v0.21.1) (2026-08-25)


### Bug Fixes

* **connectors:** denial detection was quadratic in the message length ([#119](https://github.com/nimbus-agent/nimbus-vscode/issues/119)) ([8e08d30](https://github.com/nimbus-agent/nimbus-vscode/commit/8e08d30181dd56bce609bea3852b61523adf3ad7))

## [0.21.0](https://github.com/nimbus-agent/nimbus-vscode/compare/v0.20.0...v0.21.0) (2026-08-19)


### Features

* **chat:** attach files, selections and index items to an Ask turn ([#117](https://github.com/nimbus-agent/nimbus-vscode/issues/117)) ([77eb883](https://github.com/nimbus-agent/nimbus-vscode/commit/77eb883ce82a95dd87595ad3a6e5cc3e8d10aa7c))

## [0.20.0](https://github.com/nimbus-agent/nimbus-vscode/compare/v0.19.0...v0.20.0) (2026-08-19)


### Features

* **connectors:** manage connectors and index health from the editor ([#115](https://github.com/nimbus-agent/nimbus-vscode/issues/115)) ([4ffe94e](https://github.com/nimbus-agent/nimbus-vscode/commit/4ffe94eb56e5f0d2d5c8a6d804b4b93d6952a3cd))

## [0.19.0](https://github.com/nimbus-agent/nimbus-vscode/compare/v0.18.0...v0.19.0) (2026-08-18)


### Features

* **context:** add nimbus.context.enabled and fix four real-editor findings ([#113](https://github.com/nimbus-agent/nimbus-vscode/issues/113)) ([a13823e](https://github.com/nimbus-agent/nimbus-vscode/commit/a13823e6ff0e581f07ac7a3c884862b0b2032127))

## [0.18.0](https://github.com/nimbus-agent/nimbus-vscode/compare/v0.17.2...v0.18.0) (2026-08-17)


### Features

* **context:** blame and related neighbours in the context panel ([#112](https://github.com/nimbus-agent/nimbus-vscode/issues/112)) ([5684096](https://github.com/nimbus-agent/nimbus-vscode/commit/56840967350812e69830fa808ad37fa58034197e))
* **context:** offer the agents that fit what is on screen ([#109](https://github.com/nimbus-agent/nimbus-vscode/issues/109)) ([776599f](https://github.com/nimbus-agent/nimbus-vscode/commit/776599f383e1b4aed1b4d44f8b4de5ba750732fa))

## [0.17.2](https://github.com/nimbus-agent/nimbus-vscode/compare/v0.17.1...v0.17.2) (2026-08-16)


### Bug Fixes

* **chat:** resolve the Gateway client per call so reconnect does not strand it ([#103](https://github.com/nimbus-agent/nimbus-vscode/issues/103)) ([e7936f0](https://github.com/nimbus-agent/nimbus-vscode/commit/e7936f0a0f79dbcc38ee7e13956b71e31135e87d))
* **diagnostics:** remove a latent quadratic regex, and clear the Sonar backlog ([#105](https://github.com/nimbus-agent/nimbus-vscode/issues/105)) ([8d5ec5a](https://github.com/nimbus-agent/nimbus-vscode/commit/8d5ec5a0f012a14e85a1448bb46505a094466edd))

## [0.17.1](https://github.com/nimbus-agent/nimbus-vscode/compare/v0.17.0...v0.17.1) (2026-08-13)


### Bug Fixes

* **workflows:** forward the cancellation token, not the progress reporter ([#100](https://github.com/nimbus-agent/nimbus-vscode/issues/100)) ([be5156c](https://github.com/nimbus-agent/nimbus-vscode/commit/be5156c12ea24ee4d2c273fde067843350f7d8cf))

## [0.17.0](https://github.com/nimbus-agent/nimbus-vscode/compare/v0.16.0...v0.17.0) (2026-08-13)


### Features

* **diagnostics:** offer explain, fix and prior-occurrences on the lightbulb ([#98](https://github.com/nimbus-agent/nimbus-vscode/issues/98)) ([aebe5c9](https://github.com/nimbus-agent/nimbus-vscode/commit/aebe5c9894d611c67e3ff2c3d955236995568147))

## [0.16.0](https://github.com/nimbus-agent/nimbus-vscode/compare/v0.15.0...v0.16.0) (2026-08-13)


### Features

* **sidebar:** add a read-only Workflows view ([#95](https://github.com/nimbus-agent/nimbus-vscode/issues/95)) ([c47aa7f](https://github.com/nimbus-agent/nimbus-vscode/commit/c47aa7fe9799a07b5ca0b7978dc99451e75c58ae))
* **workflows:** run and cancel a workflow from the editor ([#96](https://github.com/nimbus-agent/nimbus-vscode/issues/96)) ([ad94c1a](https://github.com/nimbus-agent/nimbus-vscode/commit/ad94c1a12837c688908eaca0dea2e1cf71d0f2d8))

## [0.15.0](https://github.com/nimbus-agent/nimbus-vscode/compare/v0.14.0...v0.15.0) (2026-08-12)


### Features

* **briefs:** reach the last two briefs, and route every agent call through one seam ([#91](https://github.com/nimbus-agent/nimbus-vscode/issues/91)) ([63956e5](https://github.com/nimbus-agent/nimbus-vscode/commit/63956e5197267c676264c40d1f63d62bdb3df2f8))

## [0.14.0](https://github.com/nimbus-agent/nimbus-vscode/compare/v0.13.0...v0.14.0) (2026-08-11)


### Features

* render per-class egress coverage instead of the removed tier scalar ([#89](https://github.com/nimbus-agent/nimbus-vscode/issues/89)) ([36f76d5](https://github.com/nimbus-agent/nimbus-vscode/commit/36f76d520b8226bbc79c9609113a383db43a1011))

## [0.13.0](https://github.com/nimbus-agent/nimbus-vscode/compare/v0.12.1...v0.13.0) (2026-08-10)


### Features

* **briefs:** blame, PR and ticket on hover, with a link into the full Why brief ([#87](https://github.com/nimbus-agent/nimbus-vscode/issues/87)) ([b6ffec1](https://github.com/nimbus-agent/nimbus-vscode/commit/b6ffec1b9bfc7cdef83a7ad4272bcd3b68afac84))
* **briefs:** surface the built-in briefs where the editor already has context ([#84](https://github.com/nimbus-agent/nimbus-vscode/issues/84)) ([620c119](https://github.com/nimbus-agent/nimbus-vscode/commit/620c11913be62bd6fbb5a658433057b43bb7a70c))


### Bug Fixes

* recover from a Gateway restart, and close the URI-truncation bug class ([#86](https://github.com/nimbus-agent/nimbus-vscode/issues/86)) ([80b2934](https://github.com/nimbus-agent/nimbus-vscode/commit/80b293420e4df8f93e3fbedc90ad297336478005))

## [0.12.1](https://github.com/nimbus-agent/nimbus-vscode/compare/v0.12.0...v0.12.1) (2026-08-01)


### Bug Fixes

* clear the 7 open SonarCloud code smells in the egress preview gate ([#70](https://github.com/nimbus-agent/nimbus-vscode/issues/70)) ([66bfe20](https://github.com/nimbus-agent/nimbus-vscode/commit/66bfe204e3d5eedbe48b0df853c7457548523455))

## [0.12.0](https://github.com/nimbus-agent/nimbus-vscode/compare/v0.11.0...v0.12.0) (2026-08-01)


### Features

* **egress:** preview what leaves — a pre-flight gate on every agent-bound path ([#67](https://github.com/nimbus-agent/nimbus-vscode/issues/67)) ([690cb38](https://github.com/nimbus-agent/nimbus-vscode/commit/690cb38b7663d647cc30d3c5b1b78d4cc69710e8))

## [0.11.0](https://github.com/nimbus-agent/nimbus-vscode/compare/v0.10.0...v0.11.0) (2026-07-29)


### Features

* **ci:** tell an expiring publish token apart from a dead one ([#64](https://github.com/nimbus-agent/nimbus-vscode/issues/64)) ([1a93ed4](https://github.com/nimbus-agent/nimbus-vscode/commit/1a93ed4ae7c76bfa88f1e064d8d09ee97baaf307))

## [0.10.0](https://github.com/nimbus-agent/nimbus-vscode/compare/v0.9.0...v0.10.0) (2026-07-24)


### Features

* **marketplace:** re-cut the listing for the on-call/incident ICP + ROADMAP + why-lens tease ([#55](https://github.com/nimbus-agent/nimbus-vscode/issues/55)) ([aaab5a8](https://github.com/nimbus-agent/nimbus-vscode/commit/aaab5a8cabc537fbc282c6ced1abe6f0a6289970))


### Bug Fixes

* **sonar:** clear 17 code smells across egress, participant, ops-commands, presets ([#53](https://github.com/nimbus-agent/nimbus-vscode/issues/53)) ([43deff7](https://github.com/nimbus-agent/nimbus-vscode/commit/43deff7c779620109ad503afa24476aac96df879))

## [0.9.0](https://github.com/nimbus-agent/nimbus-vscode/compare/v0.8.0...v0.9.0) (2026-07-23)


### Features

* egress receipts — delta footer, HTML proof, commit trailer, proof of denial (Stage 2c) ([#50](https://github.com/nimbus-agent/nimbus-vscode/issues/50)) ([7d6c715](https://github.com/nimbus-agent/nimbus-vscode/commit/7d6c715fb32da1606fe8a2e5324e990939edd3e7))

## [0.8.0](https://github.com/nimbus-agent/nimbus-vscode/compare/v0.7.0...v0.8.0) (2026-07-23)


### Features

* ops slash-command vocabulary + infra quick-ask presets (Stage 2b) ([#49](https://github.com/nimbus-agent/nimbus-vscode/issues/49)) ([475d24b](https://github.com/nimbus-agent/nimbus-vscode/commit/475d24b01e6ea0037c9d6745d53dcfe1da73b221))

## [0.7.0](https://github.com/nimbus-agent/nimbus-vscode/compare/v0.6.2...v0.7.0) (2026-07-23)


### Features

* consume the Stage 1 client surface (client ^0.11.0) ([#45](https://github.com/nimbus-agent/nimbus-vscode/issues/45)) ([7717246](https://github.com/nimbus-agent/nimbus-vscode/commit/77172462975cf5febfbc742939748352fde1640f))
* Restricted-Mode support, extensionKind, and native welcome views (Stage 2e-core) ([#46](https://github.com/nimbus-agent/nimbus-vscode/issues/46)) ([dd9731e](https://github.com/nimbus-agent/nimbus-vscode/commit/dd9731e5731d2df0c6297f3f28bad9b172b52ee5))
* register nimbus_search + nimbus_ask as Language Model tools (Stage 2d) ([#47](https://github.com/nimbus-agent/nimbus-vscode/issues/47)) ([db0b42f](https://github.com/nimbus-agent/nimbus-vscode/commit/db0b42fefd83802c986a61f68c43420202d6644d))

## [0.6.2](https://github.com/nimbus-agent/nimbus-vscode/compare/v0.6.1...v0.6.2) (2026-07-22)


### Bug Fixes

* clear the SonarCloud board (11) + close [#37](https://github.com/nimbus-agent/nimbus-vscode/issues/37) and [#19](https://github.com/nimbus-agent/nimbus-vscode/issues/19) ([#43](https://github.com/nimbus-agent/nimbus-vscode/issues/43)) ([2a1d20f](https://github.com/nimbus-agent/nimbus-vscode/commit/2a1d20f6cf890bf89150aec720c59fa69a7d0cb1))

## [0.6.1](https://github.com/nimbus-agent/nimbus-vscode/compare/v0.6.0...v0.6.1) (2026-07-22)


### Bug Fixes

* Index view shows item types and sorts by time ([#40](https://github.com/nimbus-agent/nimbus-vscode/issues/40)) ([f881e8c](https://github.com/nimbus-agent/nimbus-vscode/commit/f881e8c5a2c8c15b9be6f388397d13c9e4375581))

## [0.6.0](https://github.com/nimbus-agent/nimbus-vscode/compare/v0.5.1...v0.6.0) (2026-07-21)


### Features

* **scm:** dev-workflow trio — commit message, review changes, generate tests/docs ([#38](https://github.com/nimbus-agent/nimbus-vscode/issues/38)) ([1376474](https://github.com/nimbus-agent/nimbus-vscode/commit/1376474fafcf33fd7d92f182d0d9bfc005bd8aad))

## [0.5.1](https://github.com/nimbus-agent/nimbus-vscode/compare/v0.5.0...v0.5.1) (2026-07-20)


### Bug Fixes

* redact and clamp ask-about-selection, and stop shipping repo internals ([#31](https://github.com/nimbus-agent/nimbus-vscode/issues/31)) ([935c7e0](https://github.com/nimbus-agent/nimbus-vscode/commit/935c7e0eb299975e2fbff8fc0ccc102bb7770fed))

## [0.5.0](https://github.com/nimbus-agent/nimbus-vscode/compare/v0.4.0...v0.5.0) (2026-07-18)


### Features

* **chat:** native [@nimbus](https://github.com/nimbus) VS Code Chat participant ([#28](https://github.com/nimbus-agent/nimbus-vscode/issues/28)) ([a9669e6](https://github.com/nimbus-agent/nimbus-vscode/commit/a9669e652ab74f71ffe9dc491fd3c2814fd2df1b))

## 0.4.0 — 2026-07-18

- **Get Started walkthrough** — a first-run walkthrough (`Nimbus: Open Walkthrough`,
  also on the Welcome page) that guides you through connecting the Gateway and
  trying Ask, Search, and Quick Ask, then points at the sidebar and egress ledger.
  The "Connect the Gateway" step checks itself off on a real connection.
- **Fix: the chat panel now renders in current VS Code.** The webview dropped
  every extension→webview message (blank panel) because its message guard required
  `ev.source === window.parent`, but VS Code's MessageChannel transport delivers
  host messages with a different source. It now trusts the non-spoofable
  `vscode-webview://` origin instead.
- **Ask surfaces failures instead of failing silently** — when the Gateway can't
  answer (e.g. no LLM provider configured / invalid API key), the panel now shows a
  clear, actionable message rather than nothing (a thrown stream error or an
  empty completion used to leave a blank turn).
- **Fix: broken install-guide link** (`nimbus-agent.dev/install` → `…/user-guide/install/`).

## 0.3.0 — 2026-07-17

- **Egress status-bar badge** — a status-bar item (shown while connected, on by
  default) shows the egress-ledger row count plus a ledger-live ✓ (the head was read successfully —
  not a cryptographic verify; run `Nimbus: Verify Egress Ledger` for that).
  Clicking it opens the Egress view. Polls `egressHead` on the
  `nimbus.statusBarPollMs` cadence; toggle with `nimbus.egress.showStatusBarBadge`.
- **Stop a streaming Ask** — the chat panel's Stop button now finalizes the
  partial reply, marks the turn `⏹ Stopped`, and returns the controls to idle;
  the in-flight generation is cancelled on the Gateway via `cancelStream`.
- **Connection troubleshooter** (`Nimbus: Troubleshoot Connection`) — a
  state-aware modal that explains why you're disconnected and offers one-click
  fixes (start the Gateway, reconnect, open logs, or edit the socket path), with
  platform-specific guidance for socket-permission errors. No RPC.
- **Find related** — pivot from a selection (`Nimbus: Find Related`) or an Index
  sidebar item to the ranked local knowledge around it via `searchRanked`,
  excluding the item itself.
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
