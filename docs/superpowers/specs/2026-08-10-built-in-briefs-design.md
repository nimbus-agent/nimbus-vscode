# The built-in briefs, surfaced — design

**Date:** 2026-08-10
**Status:** approved, ready for an implementation plan
**Roadmap:** Phase 2 — `docs/ROADMAP.md:183` (the seven unreached briefs) and
`docs/ROADMAP.md:184` (Agents view shows the built-ins), merged into one piece
of work because they are the same work seen from two doorways.

## What this is

The Gateway ships eleven agents. The published client types ten of them. This
extension calls three, all of them buried inside chat-participant slash
commands, and the sidebar view named **Agents** renders "No agents configured"
on a fresh install.

This design wires the remaining seven to the surface that already holds the
context they need, and makes the Agents view show what the product actually is.

No new RPC. No client bump. Everything here is capability that shipped in
`@nimbus-dev/client 0.14.0` and has been sitting unreached.

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
not overclaim:

```
prompt:  JSON.stringify(params, null, 2)   // verbatim — what goes over IPC
action:  "Why is this here? (agents.why)"
files:   [{ name: "src/auth/session.ts:42",
            note: "path only — the Gateway reads the file locally" }]
```

Without that `note`, a modal reading "send `src/auth/session.ts`" says *we are
uploading your file*, which is false. The gate's credibility depends on it not
overstating what leaves.

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
- The choke-point test grows a `GATED_AGENT_CALLS` list of the nine `.agentsX(`
  shapes. `chat-participant/ops-commands.ts` joins `ALLOWED`; it holds an
  injected seam, never a real client.
- **The exemption guard:** assert the catalog marks exactly one entry ungated
  and that it is `whyPeek`. A tenth ungated brief must fail the build, not pass
  quietly. An undocumented gap is how this kind of invariant rots.

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
the cursor, with a `[Why? →]` command link into the full `why` brief. Debounced,
honours the `CancellationToken`, and behind `nimbus.briefs.showHoverBlame`
(default on, following the egress-badge precedent — a provider that fires an IPC
call on every mouse-rest wants an off switch).

**Editor context menu**, `when`-clamped to `editorTextFocus`:

- *Why is this here?* → `agentsWhy({ref, line})` from the cursor
- *Who knew this code?* → `agentsGhost({file})`
- *Who else is touching this?* → `agentsConflicts({file})`

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
    Catch me up              catchup
    Who owns…                expert
    Blast radius…            impact
    Is this idle?            janitor
    Safe to deploy?          preflight
▾ Configured agents
    my-reviewer   (active)
    docs-helper
```

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

## Error handling

The client's own header is explicit about the failure mode to avoid:

> Each method returns `{sessionId}` immediately, then the gateway emits EITHER
> `<agent>.briefReady` OR `<agent>.briefError` for that session. Both must be
> handled — watching only briefReady turns every agent failure into a timeout
> that hides the gateway's actual error message.

| Condition | Behaviour |
|---|---|
| `AgentBriefError` | Surface the Gateway's `detail` verbatim. Never flatten it into "something went wrong". |
| `AgentTimeoutError` | Its own message, naming the 30 s `DEFAULT_AGENT_TIMEOUT_MS`. |
| `EgressCancelled` | Silent — no error toast, matching the SCM trio. |
| Disconnected | Existing connection placeholder and troubleshooter path. |
| Empty findings | Per-brief "nothing found" line, as `renderImpact` / `renderExperts` already do. |

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
- **Catalog invariant** — exactly one ungated entry, and it is `whyPeek`.
- **Choke-point** — the nine `.agentsX(` shapes appear only in the choke point
  and its allowlisted consumers.
- **`commands.ts`** — driven through `test/unit/vscode-stub.ts`.

All pure modules stay free of `vscode`, per the standing convention.

## Delivery

Three PRs. One would be unreviewable, and the riskiest piece deserves to land
alone.

| PR | Contents |
|---|---|
| 1 | `src/briefs/` core, the `"brief"` egress kind, choke-point growth, **why / ghost / conflicts / huddle**, the two-group Agents view |
| 2 | **`whyPeek` hover** — `peek.ts`, the debounced provider, the exemption guard, `showHoverBlame` |
| 3 | **janitor + preflight** with input prompts, `defaultNamespace`, retro-routing the participant's three briefs through the seam, and correcting `CLAUDE.md`'s "all five agent-bound paths" to describe what the seam then actually covers |

PR 1 alone fixes the empty Agents view and reaches four of the seven unreached
briefs. PR 3 closes the gap `CLAUDE.md` currently overstates, by which point
every model-composed agent call in the extension does route through one seam.

## Out of scope

- **`agentsGlossary`** — the Gateway dispatches `agents.glossary`, but no
  published client types it. Phase 4 until a client release adds the method;
  reaching past the typed client is the standing non-negotiable.
- **Streaming or cancelling a brief run.** The `agents*` methods expose neither.
- **Acting on a brief.** Janitor names a `cleanupAction`; the extension renders
  it and never performs it. Output is a suggestion, never an applied edit — the
  rule the SCM trio already follows.
