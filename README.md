# Nimbus for VS Code

Local-first AI agent for the editor. Ask and search against your private [Nimbus](https://github.com/nimbus-agent/Nimbus) index — all running on your machine.

- **Ask** — chat with the Nimbus agent in a side panel; responses stream token-by-token, and a **Stop** button cancels a long generation cleanly while keeping the partial reply.
- **Quick Ask** — ask about a selection (or the whole file) and get a one-shot answer in a read-only tab, without opening the chat panel.
- **Search** — live ranked (semantic + keyword) search over your local Nimbus index; results update as you type, and selecting one opens its source (or notifies you when it has none). **Search Selection** seeds it from the editor.
- **Find related** — from a selection or an Index sidebar item, pivot to the local knowledge around it (ranked search that excludes the item itself).
- **Selection-aware** — right-click a selection to *Ask About Selection*, *Search Selection*, or *Find Related*.
- **Nimbus sidebar** — activity-bar views for Sessions (with chat resume), the local Index, and Agents.
- **Audit & Egress ledgers** — inspect what the agent did and everything it sent off-device; verify the egress hash-chain and export a signed proof for any time window, all locally. An always-visible **status-bar badge** shows the egress row count with a ledger-live ✓ (click to open the ledger).
- **Connection troubleshooter** — *Nimbus: Troubleshoot Connection* explains why you're disconnected and offers one-click fixes (start the Gateway, reconnect, open logs, or edit the socket path).

## Install

- **VS Code Marketplace:** `ext install nimbus-agent.nimbus-vscode`
- **Open VSX** (Cursor, VSCodium): `ext install nimbus-agent.nimbus-vscode`
- **Manual:** download the `.vsix` from the [latest release](https://github.com/nimbus-agent/nimbus-vscode/releases) and run `code --install-extension nimbus-<ver>.vsix`.

## Quickstart

Run **`Nimbus: Ask`** from the command palette, or right-click a selection in the editor and choose *Ask About Selection* / *Search Selection*. The extension connects to your local Nimbus Gateway automatically (enable `nimbus.autoStartGateway` to have it start the Gateway for you).

## Requires

A running Nimbus Gateway. See <https://nimbus-agent.dev/install> for setup.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `nimbus.socketPath` | _(auto)_ | Override the Gateway socket path. |
| `nimbus.autoStartGateway` | `false` | Spawn `nimbus start` if the socket is unreachable. |
| `nimbus.statusBarPollMs` | `30000` | Status-bar connector-health poll interval (ms). |
| `nimbus.transcriptHistoryLimit` | `50` | Turns rehydrated into the chat panel on reload. |
| `nimbus.search.limit` | `50` | Max results per search (1–500). |
| `nimbus.askAgent` | _(Gateway default)_ | Default agent name passed to Ask. |
| `nimbus.agents` | `[]` | Agents shown in the Agents sidebar view. |
| `nimbus.quickAsk.presets` | `[]` | Quick Ask preset actions (empty = Explain/Fix/Review/Docstring). |
| `nimbus.egress.showStatusBarBadge` | `true` | Show the egress row-count badge (ledger-live ✓) in the status bar. |
| `nimbus.hitlAlwaysModal` | `false` | Render HITL consent as a blocking modal instead of a toast. |
| `nimbus.logLevel` | `info` | Output-channel verbosity. |

See [docs/settings.md](./docs/settings.md) for the full reference.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). This repository was extracted from the Nimbus monorepo; it consumes [`@nimbus-dev/client`](https://www.npmjs.com/package/@nimbus-dev/client) from npm and releases independently of the Gateway.

## See also

- [Documentation](./docs/) — architecture, development, settings, and release docs
- [Roadmap](./docs/ROADMAP.md) — where the extension is going, phased by SDK-readiness
- [Nimbus User Guide](https://nimbus-agent.dev/user-guide/vscode-extension/)
- [Nimbus](https://github.com/nimbus-agent/Nimbus) — the Gateway this extension talks to

## License

[MIT](./LICENSE)
