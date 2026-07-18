# Nimbus VS Code — Roadmap

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
  RPCs that a published client already exposes (through `0.4.0`).
- **Phase 4** is blocked until a published `@nimbus-dev/client` surfaces the
  required RPC, typed. An item graduates out of Phase 4 the moment its RPC ships.

The columns below name the enabling client RPC (or, for Phase 4, the new SDK
capability required) so the split is verifiable, not aspirational. Effort is a
rough T-shirt size (S / M / L).

## Already shipped (baseline)

| Surface | Enabling RPC |
| --- | --- |
| **Ask** — streaming chat panel (+ Ask About Selection) with a **Stop** affordance that cancels an in-flight generation | `askStream`, `cancelStream` |
| **Search** — live ranked search over the local index (+ configurable limit, duplicates badge, Search Selection) | `searchRanked` |
| **Find related** — pivot from a selection or Index item to ranked local neighbors (self-excluded) | `searchRanked` |
| **Quick Ask** — one-shot editor quick-ask (preset actions + custom), reply in a read-only tab | `agentInvoke` |
| **`@nimbus` Chat participant** — native participant in VS Code's built-in Chat view, with slash commands (`/explain`, `/fix`, `/test`), `#file`/selection context, streaming answers, and local-index citations | `askStream`, `searchRanked` |
| **Sidebar** — Audit, Sessions (with chat resume), Index, Agents | `auditList`, `getSessionTranscript`, `queryItems` |
| **Egress ledger** — viewer + Verify-ledger + Prove-window, plus a status-bar badge (row count + ledger-live ✓, shown while connected, on by default) | `egressList`, `egressVerify`, `egressProveWindow`, `egressHead` |
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

The **native VS Code Chat participant** has shipped — see **Already shipped**
above; the remaining Phase 2 items below are still open.

| Feature | Value | Client RPC | Effort |
| --- | --- | --- | --- |
| **Dev-workflow trio** — Generate commit message (staged diff), "Review my changes" (working diff), Generate tests / docstrings | The features touched every single day | `agentInvoke` + SCM API | M |
| **"Preview what leaves" pre-flight** — before an agent action, show the exact context that will be sent, with redacted paths | The privacy moat made visible; extends the `redactPath` work | local + `egressList` | M |
| **Context-grounded Ask** — `@`-mention / attach files, search results, or index items into a question | Answers cite *your* local knowledge, not the model's guess | `searchRanked` / `queryItems` + `askStream` | M |

## Phase 3 — Deepen surfaces & trust

Depth on the surfaces that already exist, plus a fuller trust/observability
story. Still no SDK change required.

| Feature | Value | Client RPC | Effort |
| --- | --- | --- | --- |
| Search **result preview/peek** + service/type/time **filters** | Find and inspect without leaving the picker | `searchRanked` + `queryItems` | M |
| **Raw SQL query panel** (power users) | Ad-hoc queries over the local index | `querySql` | M |
| **Session browser depth** — search / rename / pin / export transcript | Manage long histories | `getSessionTranscript` | M |
| **Index browsing depth** — filter / paginate | Navigate a large index | `queryItems` | M |
| Quick-ask **code-editing actions** — apply the reply as a `WorkspaceEdit` with diff + undo | Turn answers into edits, safely | `agentInvoke` | M |
| **"Ask Nimbus about this problem"** code action on a diagnostic | Editor-native debugging from a squiggle | `agentInvoke` | M |
| **Multi-agent compare** — ask N agents, diff their answers; per-action agent picker | Exploit the agent model; pick the best take | `agentInvoke` (fan-out) | M |
| **Live egress feed** panel + **HITL history/notification center** + "what has Nimbus sent about this file/session?" | A complete, glanceable trust surface | `egressList` / `subscribeHitl` | M |
| **Saved searches / history**; **CodeLens** "Ask Nimbus" over functions | Everyday ergonomics | `searchRanked` / `agentInvoke` | S |

## Phase 4 — Requires new nimbus SDK/Gateway development

Blocked until a published `@nimbus-dev/client` surfaces the required RPC, typed.
These are **not** deferred by choice — the non-negotiable is that the extension
never reaches past the typed client. Each item graduates upward the moment its
RPC ships.

| Feature | Value | New SDK capability required | Effort |
| --- | --- | --- | --- |
| **Workflow surface** — run / monitor / cancel workflows | The flagship gap (the removed `Run Workflow` stub is tracked here) | workflow RPCs | L |
| **Share surface** — share a session or result | Collaboration | share RPCs | L |
| **Streaming + cancellable quick-ask**; true one-shot cancellation | Live replies; abort an in-flight `agentInvoke` | abort / stream on `agentInvoke` | M |
| **Connector management** — add / configure / health | Manage sources in-editor | connector RPCs | L |
| **Index write ops** — trigger reindex / add sources | Control indexing without the CLI | index-write RPCs | M |
| **Egress policy management** + live egress subscription | Configure and watch egress in real time | egress-policy / subscription RPCs | M |
| **Inline completions / ghost text** | Type-ahead grounded in the local model | a completion-oriented RPC | L |
| **Agent authoring** in-editor | Create/edit agents without leaving VS Code | agent-write RPCs | L |

---

## How items graduate

- A **Phase 4** item moves up the moment a published `@nimbus-dev/client` version
  exposes its RPC typed — at that point it is "existing SDK" and belongs in an
  earlier phase. Bumping the client and using the typed IPC client is the entire
  unblock (see [CLAUDE.md](../CLAUDE.md) → *Conventions / non-negotiables*).
- Within the existing-SDK phases, items are sequenced foundation → differentiator
  → depth, but any of them can be pulled forward independently — they share no
  ordering dependency beyond the RPCs they name.
- When an item ships, move it to **Already shipped** and record it in
  [CHANGELOG.md](../CHANGELOG.md).
