# Nimbus — On-Call & Incident Agent for VS Code

A **private, local-first** agent for on-call and platform engineers. It answers
from *your own* indexed context — incidents, deploys, ownership, code — and keeps
a verifiable record of what it does off your machine. All running locally; your
data never leaves the box except through actions you can see and prove.

## Built for incident response & platform work

Structured, grounded answers via the built-in Chat participant — not generic prompts:

- **`/incident`** — what's going on right now: a catch-up brief across the services you own.
- **`/deploys <service>`** — DORA metrics (deploy frequency, lead time, change-fail rate, MTTR).
- **`/owns <file|service|topic>`** — who owns it, from your indexed history.
- **`/blast <file|PR>`** — blast radius: what a change touches downstream.

Each degrades honestly — an empty brief tells you *why* (missing connector, no data), never a confident guess.

## A verifiable record of what the agent does off your machine

Nimbus keeps a **signed, hash-chained egress ledger** of **every outbound action
the agent dispatches** — one row, appended before the action leaves. Inspect it,
verify the chain, and export a signed proof for any time window, all locally. A
claim no cloud assistant can make, because completeness *for the agent's actions*
can only be established at the point of departure, under your control.

**Scope, stated plainly:** this records the agent's *dispatched actions*, not raw
network traffic. It is not a firewall or host DLP and does not capture sockets or
HTTP made outside the agent (the OS, other processes, or an unsandboxed
third-party MCP server). It is a provable record of *what the agent did* — not a
claim about every byte that left the machine.

### Preview what leaves — before it does

The ledger answers "what left?". The **pre-flight gate** answers "should this
leave at all?", while you can still say no. Every agent-bound path routes through
one seam that renders exactly what would be sent — file names only, never
directory or repository paths — and can refuse to send it.

Where the extension assembles the context for you, you get the final say: **Quick
Ask** and the **dev-workflow trio** show a manifest of the payload (how many
files, how many characters, what was left out and why) with *Show full text* to
read the exact bytes in a tab, and *Always send … here* to stop asking per
surface, per workspace. `nimbus_ask` confirms inline when another chat extension
calls it. The Ask panel and `@nimbus` participant send text you typed yourself,
so they record without interrupting.

It also warns when the payload contains an absolute path from your machine —
Nimbus never adds one, but your own code and comments sometimes do. In Restricted
Mode a stored *Always send* is ignored and you are asked again, since that is
precisely when you wanted to be. The gate needs no Gateway connection: it works
while disconnected. `Nimbus: Show Last Outbound Payload` replays the last send
verbatim, and `Nimbus: Reset Egress Preview Prompts` clears the stored choices.

## Everything else it does

- **Ask** — chat with the Nimbus agent in a side panel; responses stream token-by-token, and a **Stop** button cancels a long generation cleanly while keeping the partial reply.
- **`@nimbus` Chat participant** — also works as a general assistant: free-form questions can pull in `#file` context (or your selection), answers stream token-by-token, and replies include clickable citations back to local-index sources. Explain / Fix / Review / Docstring live as **Quick Ask presets** rather than slash commands.
- **Language Model tools** — other chat extensions and agents can call Nimbus as a tool: `nimbus_search` (ranked search over your private local index) and `nimbus_ask` (a one-shot answer from your local agent), referenceable in a prompt as `#nimbusSearch` / `#nimbusAsk`.
- **Quick Ask** — ask about a selection (or the whole file) and get a one-shot answer in a read-only tab, without opening the chat panel.
- **Search** — live ranked (semantic + keyword) search over your local Nimbus index; results update as you type, and selecting one opens its source (or notifies you when it has none). **Search Selection** seeds it from the editor.
- **Find related** — from a selection or an Index sidebar item, pivot to the local knowledge around it (ranked search that excludes the item itself).
- **Selection-aware** — right-click a selection to *Ask About Selection*, *Search Selection*, or *Find Related*.
- **Dev-workflow trio** — *Generate Commit Message* drafts a message from your staged diff, in your repository's own commit style, into the Source Control input box; *Review Changes* reviews all local changes (staged and unstaged) in a findings tab that also names what wasn't reviewed (too large, possibly secret, binary or non-textual changes, untracked); *Generate Tests* and *Generate Docstrings* work over an editor selection, opening an untitled test buffer or a docstring diff. Output is always a suggestion — nothing is written to disk or applied automatically.
- **Nimbus sidebar** — activity-bar views for Sessions (with chat resume), the local Index, and Agents.
- **Audit & Egress ledgers** — inspect what the agent did and everything it sent off-device; verify the egress hash-chain and export a signed proof for any time window, all locally. A **status-bar badge** (shown while connected, on by default) displays the egress row count with a ledger-live ✓ — click to open the ledger, or toggle it with `nimbus.egress.showStatusBarBadge`.
- **Connection troubleshooter** — *Nimbus: Troubleshoot Connection* explains why you're disconnected and offers one-click fixes (start the Gateway, reconnect, open logs, or edit the socket path).
- **Get Started walkthrough** — a first-run walkthrough (*Nimbus: Open Walkthrough*, also on the Welcome page) that guides you from connecting the Gateway through Ask, Search, and Quick Ask.
- **Restricted Mode aware** — the extension still works in an untrusted workspace; only the workspace-level `nimbus.socketPath` and `nimbus.autoStartGateway` settings are ignored, so a workspace can't redirect the IPC socket or spawn a process.

## Install

- **VS Code Marketplace:** `ext install nimbus-agent.nimbus-vscode`
- **Open VSX** (Cursor, VSCodium): `ext install nimbus-agent.nimbus-vscode`
- **Manual:** download the `.vsix` from the [latest release](https://github.com/nimbus-agent/nimbus-vscode/releases) and run `code --install-extension nimbus-<ver>.vsix`.

## Verifying a release

Starting with the next release after v0.5.0, every release attaches a build
provenance attestation to the `.vsix` on the GitHub Release — this is an
attestation, not a signature on the file itself. To verify a `.vsix` from one
of those releases was built by this repository's publish workflow:

```bash
gh attestation verify nimbus-<version>.vsix --repo nimbus-agent/nimbus-vscode
```

This covers the `.vsix` attached to the **GitHub Release**. The Visual Studio
Marketplace performs its own repository signing, which VS Code verifies at
install time; that is a separate mechanism and this attestation is not
surfaced through it.

## Quickstart

Run **`Nimbus: Ask`** from the command palette, or right-click a selection in the editor and choose *Ask About Selection* / *Search Selection*. The extension connects to your local Nimbus Gateway automatically (enable `nimbus.autoStartGateway` to have it start the Gateway for you).

First time? Run **`Nimbus: Open Walkthrough`** (or open it from the **Get Started** / Welcome page) for a guided setup — connect the Gateway, then try Ask, Search, and Quick Ask.

## Requires

A running Nimbus Gateway. See <https://nimbus-agent.dev/user-guide/install/> for setup.

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
| `nimbus.scm.skipSecretFiles` | `true` | Exclude likely-secret files (`.env*`, `*.pem`, `*.key`, `id_rsa*`, `*.p12`, `*.pfx`) from diffs sent by Generate Commit Message / Review Changes. |
| `nimbus.scm.egressProofTrailer` | `false` | Append a signed `Nimbus-Egress-Proof` trailer (last-24h window digest + Ed25519 signature) to drafted commit messages. |
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

## On the roadmap (not yet shipped)

- **The `why` lens** — hover any line to see who wrote it, the PR, the ticket, the
  incident it responded to, and what breaks if you change it. Built on the gateway
  and reachable through the client today ([`agents.why`/`agents.whyPeek`](https://github.com/nimbus-agent/Nimbus/blob/main/docs/roadmap.md)); the in-editor hover is the next slice.

See the [Nimbus roadmap](https://github.com/nimbus-agent/Nimbus/blob/main/docs/roadmap.md) for the full plan.

## License

[MIT](./LICENSE)
