# The built-in briefs, surfaced — design

**Date:** 2026-08-10
**Status:** approved, delivered across PRs 1–3 (see Delivery below)
**Roadmap:** originally Phase 2's *the seven unreached briefs* and *Agents view
shows the built-ins* rows — merged into one piece of work because they are the
same work seen from two doorways. Both rows are now in `docs/ROADMAP.md`'s
**Already shipped** table as **Built-in briefs** and **Agents view shows the
built-ins**; the line numbers above are deliberately omitted since the Phase 2
table reflows as items graduate out of it.

## What this is

The Gateway ships eleven agents. The published client types ten of them. Before
this design, the extension called three, all of them buried inside
chat-participant slash commands, and the sidebar view named **Agents**
rendered "No agents configured" on a fresh install.

This design wires the remaining seven to the surface that already holds the
context they need, and makes the Agents view show what the product actually
is. **Delivered:** the extension now calls all ten of the client's typed
methods, and the Agents view shows the built-in briefs as their own group —
see the Delivery table at the bottom of this document.

No new RPC. No client bump. Everything here is capability that shipped in
`@nimbus-dev/client 0.14.0`; before this design, it had been sitting unreached.

## The briefs are not uniform

The single most important finding, and the one that shapes every decision
below: the ten `agents*` methods do **not** take a common parameter shape, so
"add seven commands" is not a template job.

| Brief | Params | Context it needs |
|---|---|---|
| `agentsWhyPeek` | `{ref, line?}` → **synchronous**, no timeout option | file + cursor |
| `agentsWhy` | `{ref, line?}` → `WhyBrief` | file + cursor |
| `agentsGhost` | `{file, namespace?, namespaces?}` | file |
| `agentsConflicts` | `{file, namespace?, namespaces?}` | file |
| `agentsHuddle` | `{sinceMs?, namespace?, namespaces?}` — all optional | none |
| `agentsJanitor` | `{resourceRef, idleDays?, cleanupAction?, allowGaps?}` | a *resource*, not a file |
| `agentsPreflight` | `{ref, namespace (required), changedSurface?}` | a ref plus a concept the extension does not have |

Four are natural editor citizens. One is a zero-argument command. Two need
identifiers no editor holds. Pretending otherwise — one uniform "Run a brief…"
picker — would have been cheaper to build and would have reproduced exactly the
criticism `docs/ROADMAP.md` levels at the current surface: capability that is
*invoked* rather than *offered*.

So each brief gets the entry point its parameters actually earn, and the two
that need prompting say so plainly instead of pretending to be contextual.

## `whyPeek` is not a brief, and the type system says so

`agentsWhyPeek` is the standout, and the exemption it gets below rests on
evidence rather than convenience.

Every one of the nine real briefs:

- takes `o?: {timeoutMs?: number}` (default `DEFAULT_AGENT_TIMEOUT_MS`, 30 s),
- returns via the async `<agent>.briefReady` / `<agent>.briefError` pair,
- carries a model-composed `brief: string`,
- extends `AgentBriefBase` — `agentVersion`, `generatedAt`, `latencyMs`,
  `gaps: GapNote[]`.

`agentsWhyPeek` has **none** of those. It takes no timeout option, returns
synchronously, and its `WhyPeek` type is raw lookup output: `author`,
`authorEmail`, `commitSha`, `committedAt`, `commitSubject`, `pr`, `ticket`,
`hasMore`. The SDK says so directly:

> `agents.whyPeek` result — a synchronous one-line answer, NOT a brief.
> Deliberately not part of `AgentBrief`: it carries no `AgentBriefBase` fields
> and no gap notes.

It is a deterministic git-and-index lookup that never reaches a model. That is
what makes it safe to put behind a hover, and what makes its egress exemption a
factual distinction rather than a usability carve-out.

## Egress: the gate covers briefs

**Decision: full gate, modal and all, for the nine model-composed briefs.**

Today the three wired briefs (`ops-commands.ts:90,107,116`) call the raw client
directly. The choke-point test guards exactly two call shapes — `.agentInvoke(`
and `.askStream(` (`test/unit/egress-choke-point.test.ts:31`) — so `agents*`
has never touched the gate. Adding seven more would have taken that from three
bypassing paths to ten while `CLAUDE.md` continues to claim every agent-bound
path routes through one seam.

The counter-argument was considered and rejected: a brief does not *assemble*
context the way Quick Ask and the SCM trio do, so it arguably falls outside the
gate's stated purpose. It is rejected because gating briefs earns something
concrete beyond consistency —

**`leak-check.ts` starts covering brief params.** `gate.check()` scans the
verbatim outbound string against `roots()` — workspace folders, home directory,
temp dir. Brief params carry a `file` or a `ref`. If any call site ever passes
an absolute path where a repo-relative one belongs, that leaks the home
directory into an outbound payload. Gating briefs puts a real bug class under a
guard that already exists.

### What the manifest says

Briefs have an asymmetry the other five surfaces do not, and the manifest must
claim neither too much nor too little:

```
prompt:  JSON.stringify(params, null, 2)   // verbatim — what goes over IPC
action:  "Why is this here? (agents.why)"
files:   [{ name: "src/auth/session.ts:42",
            note: "the extension sends this path, not the file's contents" }]
```

A modal reading "send `src/auth/session.ts`" would say *we are uploading your
file*, which is false — the extension sends a path. But the obvious fix, a note
reading *"path only — the Gateway reads the file locally"*, is **also false**,
and this design carried it until review caught it.

The extension cannot see past its own boundary, and the SDK shows material
derived from file content travelling inside briefs regardless:
`FederatedItemLite` — the projection carried by `GhostFinding.context` and every
`HuddleContribution` — is `{title, snippet, service, modifiedAt}`. It carries a
**snippet**. So a brief's findings contain indexed content, and whether the
Gateway forwards any of it to a remote model while composing `brief: string` is
Gateway behaviour this extension is forbidden to reach in and check.

Hence the rule: **the gate describes the extension's boundary and stops.** It
states what this process sends, in the present tense, about itself. What happens
downstream is the **egress ledger's** job — `egressList`, `egressVerify`,
`egressProveWindow` already ship for exactly this, and the ledger is the
after-the-fact counterpart to the pre-flight gate. The modal's footer links to
it rather than paraphrasing it.

A gate that overstates its own reach is worse than no gate, because it converts
a reviewable claim into a reassuring one.

### The decision table

`EgressKind` gains `"brief"`; `SkippableKind` gains `"brief"`;
`SKIP_LABEL.brief = "Agent Briefs"`. `skippableKind()` (`src/egress/gate.ts:27`)
returns it, so the modal fires with the *Always send Agent Briefs here* button,
per surface and per workspace, and ignored in Restricted Mode. That is a
three-line table change, not new gate logic.

| Surface | Kind wired | Behaviour |
|---|---|---|
| Editor / palette / sidebar briefs | `brief` | **prompts**, skippable per workspace |
| `@nimbus` participant's three briefs | `participant` | routes and records, no modal |
| `agentsWhyPeek` (hover) | — | **exempt**, on the evidence above |

The participant staying modal-free is not an exception carved for it. It is the
rule that surface already follows for `askStream`, and it is precisely why the
kind is fixed at wiring time rather than chosen at the call site.

### Guards

- `gated-client.ts` gains one generic wrapper over `(params) => Promise<Brief>`,
  whose type requires the `EgressMeta` argument — so a raw client cannot satisfy
  the seam by accident, the same type-level guardrail `gateAgentInvoke` uses.
- The choke-point test grows a `GATED_BRIEF_CALLS` list of the nine `.agentsX(`
  shapes (six briefs plus the participant's three). `chat-participant/ops-commands.ts`
  never touches a raw `.agentsX(` shape at all — it calls the injected
  `client.briefs.*` seam (`ParticipantBriefs`), so it needs no `ALLOWED` entry;
  only `gated-client.ts` itself may contain any of the nine call shapes.
- **The exemption guard:** every catalog entry is gated — `BRIEF_CATALOG` marks
  none as ungated, and `whyPeek` is not a catalog entry at all, since it is a
  hover, not a row. The choke-point test discovers every `.agentsX(` call
  shape anywhere in `src/` and asserts `.agentsWhyPeek(` is the only one
  outside the gate. A newly-added ungated brief call must fail the build, not
  pass quietly. An undocumented gap is how this kind of invariant rots.

## Module layout

A new `src/briefs/`, following the shape of `src/scm/` and `src/lm-tools/` —
pure core, one file touching `vscode`:

| File | Purpose | Pure |
|---|---|---|
| `catalog.ts` | The ten briefs as data: id, label, codicon, required editor context, which params must be prompted, gated or not | ✅ |
| `render.ts` | `renderWhy` / `renderGhost` / `renderConflicts` / `renderHuddle` / `renderJanitor` / `renderPreflight` → markdown, plus `gapsFooter` lifted out of `ops-commands.ts` and shared | ✅ |
| `params.ts` | Editor context (`file`, `line`) → typed params; reports what is still missing | ✅ |
| `peek.ts` | `WhyPeek` → hover markdown | ✅ |
| `commands.ts` | Gathers context, prompts for gaps, calls the seam, opens the read-only tab | glue |

`extension.ts` injects a `BriefClientLike` seam, mirroring `ScmClientLike` and
`ParticipantClientLike`. `sidebar/agents.ts` gains `builtInBriefRows()`;
`agents-view.ts` composes the groups.

Rendering follows the pattern `ops-commands.ts:25-60` already set: pure
`render*(brief) → markdown string`, sink-agnostic. Editor entry points pipe to
the read-only tab that Quick Ask, Review Changes and Generate Docstrings
already use (`openReadonlyJson`); the participant pipes the same strings to
`sink.markdown`. One renderer, two sinks, no duplication.

## Surfaces

**Hover** (`whyPeek`) — author, commit subject, PR and ticket for the line under
the cursor, with a `[Why? →]` command link into the full `why` brief. Behind
`nimbus.briefs.showHoverBlame` (default on, following the egress-badge
precedent — a provider that fires an IPC call on every mouse-rest wants an off
switch).

Three concrete rules, because "debounced" on its own is not a specification:

- **150 ms settle before the call.** VS Code already waits for a mouse-rest
  before invoking a hover provider, so this is a second-stage guard against
  a cursor sweeping across a file; below ~100 ms it stops filtering anything and
  above ~250 ms the hover feels broken.
- **One in-flight call per document.** A newer hover supersedes an older one;
  the older result is discarded rather than rendered late.
- **The `CancellationToken` discards the result — it cannot abort the call.**
  `agentsWhyPeek(p: WhyParams)` takes a single argument: no options object, no
  timeout, no abort signal (`nimbus-client.d.ts:962`). So on cancellation the
  provider returns `undefined` and drops the reply on arrival. The IPC round
  trip still completes. That is a real limit, not an implementation detail to
  discover later, and it is the reason the one-in-flight rule above matters —
  it is the only backpressure available.

Note the check is Gateway-side. The extension runs no git command and reads no
index itself; a slow hover means a slow RPC, and the mitigation is the off
switch, not local caching.

**Editor context menu**, `when`-clamped to `editorTextFocus`:

- *Why is this here?* → `agentsWhy({ref, line})` from the cursor
- *Who knew this code?* → `agentsGhost({file})`
- *Who else is touching this?* → `agentsConflicts({file})`

**Every brief command takes optional pre-resolved args.** The signature is
`nimbus.brief.why(args?: {ref, line})`: given args it uses them, and only when
called bare does it fall back to the active editor and then to prompting. This
is what makes one command serve three doorways — and specifically what stops the
hover's `[Why? →]` link from re-asking for the location the user just clicked
on. The link carries the exact `{ref, line}` the peek resolved, so the full
brief answers about the same line even if the cursor has since moved. The
sidebar rows for `janitor` and `preflight` pass no args and therefore prompt,
which is correct: a tree row carries no editor context.

**Command palette:**

- *Team Huddle* → `agentsHuddle()`, zero-argument
- *Janitor…* → prompts for `resourceRef`, then optional `idleDays`
- *Preflight…* → prompts for `ref` and `namespace`

**Sidebar** — two labelled groups. `SidebarItem.children` and
`createDataView`'s `getChildren` already support nesting, so this costs no new
tree machinery:

```
NIMBUS: AGENTS
▾ Built-in briefs
    Why is this here?        why
    Who knew this code?      ghost
    Who else is touching…    conflicts
    Team huddle              huddle
    Is this idle?            janitor
    Safe to deploy?          preflight
▾ Configured agents
    my-reviewer   (active)
    docs-helper
```

`catchup` / `expert` / `impact` stay chat-participant slash commands
(`/incident`, `/owns`, `/blast`) rather than gaining a sidebar row in PR 3;
promoting them to the Agents view is deferred, not rejected — they are already
reachable and routed through the seam (§ Egress), so the sidebar row would be
a second doorway to the same call, not new coverage.

Each built-in row runs the same command as its editor or palette entry point —
one code path, three doorways. Configured agents keep their existing
`nimbus.openAgentChat` click. Grouping is what keeps two genuinely different
concepts — one-shot brief runs versus chat scopes — from sharing a flat list
while behaving differently on click.

When `nimbus.agents` is empty the second group renders a single
*Configure agents in settings…* row rather than vanishing, so the setting stays
discoverable. The view is never empty on a fresh install.

## Settings

Two new `nimbus.*` settings, both of which must land in `docs/settings.md` or
`check-settings-docs` fails:

| Setting | Default | Why |
|---|---|---|
| `nimbus.briefs.defaultNamespace` | `""` | `agentsPreflight` **requires** `namespace` and the extension has no such concept. Prefills the prompt rather than guessing. |
| `nimbus.briefs.showHoverBlame` | `true` | Off switch for the hover provider's per-mouse-rest IPC call. |

`namespace` stays optional-and-omitted for `ghost`, `conflicts` and `huddle` —
the client types it optional there, and inventing a value would narrow results
for no reason.

**The prompt also remembers the last namespace used in this workspace**
(`workspaceState`), which takes precedence over the setting when present. That
is deterministic: it prefills a value the user typed and confirmed, so a
second Preflight in the same repo is one Enter.

**Line numbers are 1-based on the wire — verified, not assumed.** VS Code counts
from 0; the Gateway counts from 1. `toOneBased` in `src/briefs/params.ts` is the
single conversion point, used by both the RPC parameter and the egress manifest.
Settled on 2026-08-10 by probing `agentsWhyPeek` (which shares `WhyParams`)
against a file whose adjacent lines carry different commits: querying line 2 of
`ops-commands.ts` returned the commit `git blame` puts on 1-based line 2, and
`subject.lineNo` echoed 2.

**Deriving the namespace from the branch name is explicitly rejected.** The
proposal — `feature/billing-setup` → `billing` — fails in a way the user cannot
see. A wrong namespace does not error; `agentsPreflight` returns a perfectly
confident `PreflightBrief` with `downstreams`, `anyFailed` and `anyIncomplete`
computed **for the wrong namespace**, and the user reads a green preflight for
something it never checked. A missing value costs one prompt; a plausible wrong
value costs a bad deploy decision, and this brief exists to inform deploy
decisions. The same objection applies to inferring it from `package.json` —
a package name is a package name, and nothing establishes that the Gateway's
namespace space is keyed on it. Guessing is only safe where being wrong is
visible, and here it is not.

## Error handling

The client's own header is explicit about the failure mode to avoid:

> Each method returns `{sessionId}` immediately, then the gateway emits EITHER
> `<agent>.briefReady` OR `<agent>.briefError` for that session. Both must be
> handled — watching only briefReady turns every agent failure into a timeout
> that hides the gateway's actual error message.

| Condition | Behaviour |
|---|---|
| `AgentBriefError` | Surface the Gateway's `detail` verbatim, with a **Retry** action. Never flatten it into "something went wrong". |
| `AgentTimeoutError` | Its own message, naming the 30 s `DEFAULT_AGENT_TIMEOUT_MS`, with a **Retry** action. |
| `EgressCancelled` | Silent — no error toast, matching the SCM trio. |
| Disconnected | Existing connection placeholder and troubleshooter path. |
| Empty findings | Per-brief "nothing found" line, as `renderImpact` / `renderExperts` already do. |

Failures surface as a **notification**, not in the read-only tab: a tab is a text
document and cannot hold an action, and the tab is for results. Retry re-runs the
command with the same pre-resolved args, so nothing is re-prompted for — and it
**goes back through the gate** like any other send. It is a new outbound call and
gets no bypass for having been attempted once; a user who ticked *Always send
Agent Briefs here* sees no modal anyway, so the consistent rule costs nothing.
Retry is safe to offer because every `agents*` call is read-only by contract
(`agents.d.ts`: *"nine read-only, never-HITL built-in agents"*).

`gaps: GapNote[]` renders as a footer on **every** brief, empty or not — the
honesty affordance `gapsFooter` already established, and the thing that keeps a
thin brief from reading as a confident one.

## Testing

The published client ships `MockNimbusClient` with a per-agent brief map and a
`WHY_BRIEF_FIXTURE` (`mock-client.d.ts:44-51,180`). Renderers test against
those, not hand-rolled fakes — the fixtures move with the SDK, so a brief shape
change surfaces as a test failure rather than as drift.

- **Renderers** — one test per brief: populated, empty, and with gap notes.
- **`params.ts`** — an absolute path never survives into params.
- **Catalog invariant** — every entry is gated; `whyPeek` is a hover, not a
  row, and its exemption is enforced by the choke-point test.
- **Choke-point** — the nine `.agentsX(` shapes appear only in `gated-client.ts`
  itself; unlike the `agentInvoke`/`askStream` shapes, no other file is
  allowlisted for the brief family, since every consumer (including
  `chat-participant/ops-commands.ts`) calls through the injected
  `client.briefs.*` seam rather than a raw `.agentsX(` shape.
- **`commands.ts`** — driven through `test/unit/vscode-stub.ts`.

All pure modules stay free of `vscode`, per the standing convention.

## Delivery

Three PRs. One would be unreviewable, and the riskiest piece deserves to land
alone.

| PR | Contents |
|---|---|
| 1 | `src/briefs/` core, the `"brief"` egress kind, choke-point growth, **why / ghost / conflicts / huddle**, the two-group Agents view |
| 2 | **`whyPeek` hover** — `peek.ts`, the debounced provider, the exemption guard, `showHoverBlame` |
| 3 | **Delivered.** **janitor + preflight** with input prompts, `defaultNamespace`, retro-routing the participant's three briefs through the seam, and correcting `CLAUDE.md`'s "all five agent-bound paths" to describe what the seam then actually covers — the six-row catalog (why, ghost, conflicts, huddle, janitor, preflight), all gated |

PR 1 alone fixed the empty Agents view and reached four of the seven unreached
briefs. PR 3 closed the gap `CLAUDE.md` had been overstating: every
model-composed agent call in the extension now routes through one seam, and
`CLAUDE.md` says so.

## Out of scope

- **`agentsGlossary`** — the Gateway dispatches `agents.glossary`, but no
  published client types it. Phase 4 until a client release adds the method;
  reaching past the typed client is the standing non-negotiable.
- **Streaming or cancelling a brief run.** The `agents*` methods expose neither.
- **Acting on a brief.** Janitor names a `cleanupAction`; the extension renders
  it and never performs it. Output is a suggestion, never an applied edit — the
  rule the SCM trio already follows.
- **An inline gear icon on the sidebar group headers.** Raised in review;
  deferred as a duplicate path. The *Configure agents in settings…* row is
  already a click target that opens the same settings, and it appears exactly
  when it is needed. A second route would cost a `contextValue` on the group
  node plus a `view/item/context` contribution to land the user in the same
  place. Worth revisiting only if the group ever grows a real per-group action.
- **Quick links to fix common prerequisites in a failed brief.** Raised in
  review alongside Retry, which is in. This half is deferred because it requires
  a taxonomy of Gateway error strings that no typed contract provides —
  `AgentBriefError` carries a free-text `detail`. Pattern-matching prose to
  decide which fix-it link to show is guesswork that breaks silently on the next
  Gateway wording change. Revisit if the errors ever gain a typed `code`; the
  `0.14.0` bump already preserved JSON-RPC `code`/`data` on rejected calls, so
  the precedent exists.
