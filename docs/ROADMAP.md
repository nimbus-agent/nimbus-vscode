# Nimbus VS Code — Roadmap

> **Product sequencing lives in the gateway repo:
> [roadmap.md](https://github.com/nimbus-agent/Nimbus/blob/main/docs/roadmap.md)**
> — it owns what the gateway does and the order in which surfaces land. How the
> ecosystem fits together is described at org level in
> [ECOSYSTEM.md](https://github.com/nimbus-agent/.github/blob/main/ECOSYSTEM.md). This
> file is `nimbus-vscode`'s local slice: the VS Code / Open VSX extension, which
> consumes the published `@nimbus-dev/client` (see
> [Releases](https://github.com/nimbus-agent/nimbus-vscode/releases) for the
> current version). The phased plan below is this surface's own detail.

A living, phased plan for where the extension is going. It is intentionally
ordered by **SDK-readiness**, not just by value: the earlier phases ride
capabilities that already exist in a published `@nimbus-dev/client`; the final
phase is gated on **new Gateway/client development**.

> This is a direction document, not a commitment. Items move, merge, and drop as
> we learn. Dates are deliberately absent — phases are sequenced, not scheduled.

## Guiding principle

The extension is a **thin IPC client** (see [architecture.md](./architecture.md)
and [CLAUDE.md](../CLAUDE.md)). Any item that touches **Gateway data or agent
capability** must ride a **typed `@nimbus-dev/client` RPC** — no reaching past
the client into the Gateway. (Purely local or VS Code–API features — onboarding
walkthroughs, a connection troubleshooter — need no RPC and are noted as such.)
That is why, for the Gateway-backed items, the phase boundary that matters most
is "does the RPC exist yet?":

- **Phases 1–3** need nothing new from the SDK. They deepen surfaces and exploit
  RPCs that a published client already exposes (the repo pins `^0.14.0`).
- **Phase 4** is blocked until a published `@nimbus-dev/client` surfaces the
  required RPC, typed. An item graduates out of Phase 4 the moment its RPC ships.
  `0.14.0` widens the surface well past the egress-era client: it exposes the
  workflow family (`workflowList`, `workflowSave`, `workflowDelete`,
  `workflowListRuns`, `workflowRun`, plus `workflowRunStream` since `0.13.0`),
  the full connector suite (`connectorListStatus`, `connectorStatus`,
  `connectorHealthHistory`, `connectorPause`, `connectorResume`,
  `connectorSetInterval`, `connectorSetConfig`, `connectorSync`,
  `connectorAuth`, `connectorAddMcp`, `connectorRemove`, `connectorReindex`)
  and `subscribeConnectorConfigChanged` (also `0.13.0`), the nine `agents*`
  briefs, the `session*` and `audit*` families, and `metricsDora` /
  `deployPreflight`; `0.14.0` itself preserves the JSON-RPC `code`/`data` on a
  rejected call. Read the authoritative list off the `NimbusClientLike`
  interface in `node_modules/@nimbus-dev/client/dist/nimbus-client.d.ts` rather
  than re-freezing a copy here — a frozen copy is what made this section stale.
  Three items graduated out of Phase 4 once those RPCs shipped (Workflow surface,
  Connector management, Index write ops); what is left below is genuinely
  unshipped upstream.

The columns below name the enabling client RPC (or, for Phase 4, the new SDK
capability required) so the split is verifiable, not aspirational. Effort is a
rough T-shirt size (S / M / L).

## One gateway, N contextual surfaces

A framing that post-dates the phases below and cuts across all of them: Nimbus
is **one gateway with N contextual surfaces**. The agents are the product; a
surface is only how you reach them without leaving where you already are. Every
surface talks to the same Gateway over the same contract and runs the same
built-in agents — no surface owns an agent, and no agent is reimplemented per
surface; what differs is *context*. Today the terminal is the one first-class
surface, and the editor and the browser are treated as accessories — a
historical accident of build order, not a design decision.

The editor is the surface with the **best context and the shortest path to
action**. A browser tab offers a URL; VS Code already knows the open file, the
selection, the diff against `HEAD`, the branch, the failing test, and the stack
trace in the terminal — and it is the place where an answer becomes an edit.
That context is underused today: `#file`/selection reaches the chat participant
and the SCM trio reads the diff, but nothing in the editor *offers* an agent
based on what you are looking at.

This is a repositioning, not a new identity — the extension already ships as
**Nimbus — On-Call & Incident Agent** (`package.json` `displayName`), and
several baseline items above are already agent-surface features: the `@nimbus`
chat participant with the ops slash commands, the `nimbus_search` /
`nimbus_ask` Language Model tools, the "Preview what leaves" gate, the Index
view, and — since the built-in-briefs work — the built-in briefs themselves.
What is missing is not reach any more, but that reach is still *invoked*
rather than *offered*, exactly as above.

- The Gateway ships **eleven** agents (`packages/gateway/src/agents/`):
  catchup, conflicts, expert, ghost, glossary, huddle, impact, janitor,
  preflight, why, why-peek — and dispatches all eleven over the `agents.*` IPC
  namespace (`packages/gateway/src/ipc/agents-rpc.ts`).
- The published client (`0.16.0`) types **ten** of them — all but glossary,
  which is a client-packaging gap, not a missing Gateway method — as
  `agentsCatchup`, `agentsConflicts`, `agentsExpert`, `agentsGhost`,
  `agentsHuddle`, `agentsImpact`, `agentsJanitor`, `agentsPreflight`,
  `agentsWhy`, `agentsWhyPeek`.
- This extension now calls **all ten** of the client's typed methods (every
  `.agentsX(` shape the choke-point test discovers in `src/`, verified against
  `src/egress/gated-client.ts` — nine of the ten call sites — and
  `src/extension.ts`, which calls the tenth, `agentsWhyPeek`, directly).
  `agentsGlossary` is the one Gateway agent left unreached, and it stays
  Phase 4 until a client release types it. The Agents sidebar view shows two
  groups: the built-in briefs, populated from `BRIEF_CATALOG` and never empty,
  and the chat scopes from the `nimbus.agents` setting, which still defaults
  to an empty array and stays user-configured by design — see **Built-in
  briefs** and **Agents view shows the built-ins** in *Already shipped* above.

The reach gap above is closed; most of the near-term work below is now about
**depth and offering agents from context, not reach**. The exceptions —
resolving an arbitrary reference to an indexed item, and indexing one item on
demand when that resolution misses — are genuinely new Gateway work and sit in
Phase 4 accordingly.

**The browser surface is a sibling repo, not this one.** The recorded direction
for `nimbus-web-clipper` — a direction, not work in progress — is that it stops
being a web clipper and becomes a browser-side gateway client: an ambient panel
that resolves the page you are on (a Bitbucket PR, a Jenkins build — both
indexed connectors, and `canonical_url` is a real column on `item`) to an
indexed item and runs the same agents against it. Capture is not abolished
there; it becomes the last resort for surfaces no connector models. The
decisions taken there that bear on this file: an ambient panel rather than a
generic ask box; on a resolve miss, a targeted sync of that one item rather
than a DOM fallback; polling plus `chrome.alarms` rather than SSE, because MV3
terminates idle service workers; and the fetch-and-index route allowlisted
explicitly as an `I13` HTTP **write**, not reclassified as a read. That surface
is further from shipping than this one: the extension can only speak the
gateway's bearer-authed HTTP API, which has no agents route at all, so the
browser needs an invocation surface this extension already has for free through
the typed client. The design spec is planned in the gateway repo at
`docs/superpowers/specs/2026-08-01-browser-gateway-client-design.md`; it is not
written yet.

That direction is not a victory lap, and the same honesty applies to the
items below. The clipper being repositioned has effectively no users —
addons.mozilla.org reports an average of 0 daily users after two weeks — in a
category that is already well occupied (Obsidian Web Clipper, Karakeep), and
two open defects still block it at its current job: `Nimbus#1005` (clip bodies
truncated to 512 characters while `wordCount` reports the full length) and
`Nimbus#1006` (`web_clip` routing to OpenAI embeddings when a key is set,
contradicting the store listings' local-only claim; `#1006` resolves before or
with `#1005`). The cross-corpus idea is not unique either — SurfSense ships a
comparable architecture with overlapping connectors and an MCP server.
Execution on the surfaces is the whole difference, which is what the rows below
are for.

## Already shipped (baseline)

| Surface | Enabling RPC |
| --- | --- |
| **Ask** — streaming chat panel (+ Ask About Selection) with a **Stop** affordance that cancels an in-flight generation | `askStream`, `cancelStream` |
| **Search** — live ranked search over the local index (+ configurable limit, duplicates badge, Search Selection) | `searchRanked` |
| **Find related** — pivot from a selection or Index item to ranked local neighbors (self-excluded) | `searchRanked` |
| **Quick Ask** — one-shot editor quick-ask (preset actions + custom), reply in a read-only tab | `agentInvoke` |
| **`@nimbus` Chat participant** — native participant in VS Code's built-in Chat view, with the ops slash commands (`/incident`, `/deploys`, `/owns`, `/blast`), `#file`/selection context, streaming answers, and local-index citations | `askStream`, `searchRanked`, `agentsCatchup`, `agentsImpact`, `agentsExpert`, `metricsDora` |
| **Language Model tools** — `nimbus_search` + `nimbus_ask` registered via `contributes.languageModelTools`, so other chat extensions and agents can call Nimbus as a tool | `searchRanked`, `agentInvoke` |
| **Restricted Mode support** — runs in an untrusted workspace with the workspace-level `nimbus.socketPath` / `nimbus.autoStartGateway` settings ignored | *no RPC* |
| **Dev-workflow trio** — Generate commit message (staged diff → SCM input box), Review changes (all local changes vs `HEAD` → findings tab), Generate tests / docstrings (untitled test buffer / docstring diff) | `agentInvoke` + SCM API |
| **Sidebar** — Audit, Sessions (with chat resume), Index, Agents | `auditList`, `getSessionTranscript`, `queryItems` |
| **Egress ledger** — viewer + Verify-ledger + Prove-window, plus a status-bar badge (row count + ledger-live ✓, shown while connected, on by default) | `egressList`, `egressVerify`, `egressProveWindow`, `egressHead` |
| **"Preview what leaves" pre-flight** — a gate, not a viewer: every agent-bound call routes through one seam that renders the exact outbound context with redacted paths and can refuse to send — the five `agentInvoke`/`askStream` paths, the six brief calls, and the participant's three ops briefs. Prompts where the extension assembles the context (Quick Ask, the SCM trio, the six briefs); records without prompting where the user typed the content (Ask panel, the participant's `askStream`, and the participant's three ops briefs); per-surface, per-workspace "always send here"; plus `Show Last Outbound Payload` and `Reset Egress Preview Prompts` | *no RPC — the payload is already in hand* |
| **Built-in briefs** — `Why is this here?`, `Who knew this code?`, `Who else is touching this?` and blame-on-hover from the editor; `Team huddle`, `Is this idle?` and `Safe to deploy?` from the palette and the Agents view. All seven previously unreached briefs are wired; every model-composed call routes through the pre-flight gate, and `agentsWhyPeek` is the one documented exemption | `agentsWhy`, `agentsWhyPeek`, `agentsGhost`, `agentsConflicts`, `agentsHuddle`, `agentsJanitor`, `agentsPreflight` |
| **Agents view shows the built-ins** — two-group sidebar view: the built-in briefs, plus the chat scopes from the `nimbus.agents` setting (never empty on a fresh install) | the `agents*` family |
| **Connection troubleshooter** — state-aware "why am I disconnected / how to fix" modal | *no RPC* |
| **Get Started walkthrough** — first-run walkthrough (install → connect Gateway → try Ask/Search/Quick Ask), on the Welcome page and via `Nimbus: Open Walkthrough` | *VS Code Walkthroughs API — no RPC* |
| **HITL**, status-bar quick menu, connection plumbing | `subscribeHitl` |

---

## Phase 1 — Quick wins & onboarding — ✅ complete

All Phase 1 items have shipped: the **egress status-bar badge**, **Stop**
affordance, **connection troubleshooter**, and **Find related** in `0.3.0`, and the
first-run **Get Started walkthrough** in `0.4.0`. See **Already shipped** above.

## Phase 2 — Differentiators & reach

The features that move the extension from good to **great** — the ones that lean
into what Copilot-style tools cannot do (local-first, agent-based, egress-audited)
or that meet developers where they already work. All still on existing RPCs.

The **native VS Code Chat participant**, the **Dev-workflow trio** and the
**"Preview what leaves" pre-flight** have shipped — see **Already shipped**
above; the remaining Phase 2 items below are still open.

The pre-flight shipped as a **gate**, not the passive viewer this table
originally described, and it needed **no RPCs** at all — not the `local` +
`egressList` guessed here. A pre-flight view describes a payload the extension
is already holding.

| Feature | Value | Client RPC | Effort |
| --- | --- | --- | --- |
| **Workflow surface** — run / monitor / cancel workflows | The flagship gap (the removed `Run Workflow` stub is tracked here); unblocked by client `0.14.0` | `workflowList`, `workflowSave`, `workflowDelete`, `workflowListRuns`, `workflowRun` | L |
| **Context-grounded Ask** — `@`-mention / attach files, search results, or index items into a question | Answers cite *your* local knowledge, not the model's guess | `searchRanked` / `queryItems` + `askStream` | M |
| **Ambient context panel** — offer the agents that fit what is already on screen (file, selection, diff vs `HEAD`, branch) instead of waiting for a prompt; the editor counterpart of the browser ambient panel | The surface with the richest context stops making you retype the context | `searchRanked` / `queryItems` + the `agents*` family | L |

## Phase 3 — Deepen surfaces & trust

Depth on the surfaces that already exist, plus a fuller trust/observability
story. Still no SDK change required.

| Feature | Value | Client RPC | Effort |
| --- | --- | --- | --- |
| Search **result preview/peek** + service/type/time **filters** | Find and inspect without leaving the picker | `searchRanked` + `queryItems` | M |
| **Raw SQL query panel** (power users) | Ad-hoc queries over the local index | `querySql` | M |
| **Session browser depth** — search / rename / pin / export transcript | Manage long histories | `getSessionTranscript` | M |
| **Index browsing depth** — filter / paginate | Navigate a large index | `queryItems` | M |
| Quick-ask **code-editing actions** — offer the reply as a diff the user applies themselves (the pattern Generate Docstrings already uses); the extension never applies a `WorkspaceEdit` | Turn answers into edits without ever taking the edit out of the user's hands | `agentInvoke` | M |
| **"Ask Nimbus about this problem"** code action on a diagnostic | Editor-native debugging from a squiggle | `agentInvoke` | M |
| **Multi-agent compare** — ask N agents, diff their answers; per-action agent picker | Exploit the agent model; pick the best take | `agentInvoke` (fan-out) | M |
| **Live egress feed** panel + **HITL history/notification center** + "what has Nimbus sent about this file/session?" | A complete, glanceable trust surface | `egressList` / `subscribeHitl` | M |
| **Saved searches / history**; **CodeLens** "Ask Nimbus" over functions | Everyday ergonomics | `searchRanked` / `agentInvoke` | S |
| **Connector management** — add / configure / health | Manage sources in-editor; unblocked by client `0.14.0` | `connectorListStatus`, `connectorStatus`, `connectorHealthHistory`, `connectorPause`/`connectorResume`, `connectorSetConfig`, `connectorAuth`, `connectorAddMcp`, `connectorRemove` | L |
| **Index write ops** — trigger reindex / add sources | Control indexing without the CLI; unblocked by client `0.14.0` | `connectorReindex`, `connectorSync`, `connectorAddMcp` | M |
| **Reference-aware pivot** — spot the PR / issue / build reference the editor already holds (branch name, commit trailer, a URL in a comment or terminal) and pivot to the indexed item | Most editor context is already a reference to something indexed. Best-effort by name until the resolve RPC lands (Phase 4); ranked hits do carry `canonicalUrl` | `searchRanked` | M |
| **Failure context** — from a failing test or a stack frame to the indexed CI run and the change that touched those files | The moment you most need the index is the moment something broke | `searchRanked` / `queryItems` + `agentsImpact` | M |

## Phase 4 — Requires new nimbus SDK/Gateway development

Blocked until a published `@nimbus-dev/client` surfaces the required RPC, typed.
These are **not** deferred by choice — the non-negotiable is that the extension
never reaches past the typed client. Each item graduates upward the moment its
RPC ships.

| Feature | Value | New SDK capability required | Effort |
| --- | --- | --- | --- |
| **Share surface** — share a session or result | Collaboration | share RPCs | L |
| **Streaming + cancellable quick-ask**; true one-shot cancellation | Live replies; abort an in-flight `agentInvoke` | abort / stream on `agentInvoke` | M |
| **Egress policy management** + live egress subscription | Configure and watch egress in real time | egress-policy / subscription RPCs | M |
| **Inline completions / ghost text** | Type-ahead grounded in the local model | a completion-oriented RPC | L |
| **Agent authoring** in-editor | Create/edit agents without leaving VS Code | agent-write RPCs | L |
| **Reference → item resolution** — turn a canonical URL or a service ref into the indexed item | The shared primitive this surface and the browser client both need. `canonical_url` is a real column on `item`, but nothing reads it: the typed `queryItems` filters only by service / type / time, no IPC method keys on it (`querySql` is an escape hatch, not a contract), and the column carries no SQL index — so this is a Gateway migration plus a handler, not a client-side trick | a resolve-by-URL/ref RPC | M |
| **Targeted single-item sync** — index one item on demand when resolution misses, then answer | Removes "not indexed yet" as a dead end; `connectorSync` takes a `serviceId` and syncs the whole connector. Gateway-side this is an explicit `I13` write route, not a read | a per-item fetch-and-index RPC | L |
| **Glossary brief** | The cheapest row here: the Gateway already dispatches `agents.glossary` over IPC alongside the other ten — only the typed client method is missing, so this needs a client release, not Gateway work | an `agentsGlossary` client method | S |

---

## How items graduate

- A **Phase 4** item moves up the moment a published `@nimbus-dev/client` version
  exposes its RPC typed — at that point it is "existing SDK" and belongs in an
  earlier phase. Bumping the client and using the typed IPC client is the entire
  unblock (see [CLAUDE.md](../CLAUDE.md) → *Conventions / non-negotiables*).
- Within the existing-SDK phases, items are sequenced foundation → differentiator
  → depth, but any of them can be pulled forward independently — they share no
  ordering dependency beyond the RPCs they name.
- A **shared primitive** — an item this surface and the browser client both need
  (reference resolution, targeted single-item sync) — graduates by exactly the
  same rule: when a published client types the RPC. Being wanted by two surfaces
  raises its priority, never its phase. Where the primitive lands as a Gateway
  HTTP write it stays subject to the Gateway's own gates; this surface does not
  get a shortcut because another surface already has one.
- When an item ships, move it to **Already shipped** and record it in
  [CHANGELOG.md](../CHANGELOG.md).
