# Built-in briefs, PR 3 — janitor, preflight, and one seam for every agent call

**Status:** design, approved 2026-08-11.
**Parent:** [2026-08-10-built-in-briefs-design.md](./2026-08-10-built-in-briefs-design.md)
— read it first. This document is a delta, not a replacement: everything the
parent settles (error handling, the read-only-tab result surface, the egress
manifest's file note, 1-based line numbers, what is out of scope) still holds.
Where the two disagree, this one wins, and the parent is corrected in the same
PR.

## What PR 3 is for

The parent spec's delivery table promised three PRs. PR 1 (#84) landed the
`src/briefs/` core, the `"brief"` egress kind, and four briefs; PR 2 (#87)
landed the `whyPeek` hover and its documented gate exemption. PR 3 is the last
one, and it exists for two reasons that happen to be one change:

1. **Reach the last two unreached briefs.** `agentsJanitor` and
   `agentsPreflight` are typed by the published client and called by nothing.
2. **Make the extension's central claim true.** `CLAUDE.md` says the egress
   gate is the one seam every agent-bound call passes through, then admits in
   the same paragraph that "the three remaining `agents*` calls in
   `ops-commands.ts` are still raw pending PR 3". `egress-choke-point.test.ts`
   carries a matching `UNGATED_PENDING_PR3` list. Both are IOUs written by PR 1
   against this PR.

After PR 3, every `agents*` call in `src/` reaches the client through
`src/egress/gated-client.ts`, and `whyPeek` is the sole exemption — which is
already what the test asserts, minus the pending list.

## Two decisions taken at design time

### Scope: six brief rows, not nine

The parent spec's sidebar mockup (its lines 238–253) shows **nine** built-in
rows, including *Catch me up*, *Who owns…* and *Blast radius…*. Those three —
`catchup`, `expert`, `impact` — exist today only as chat-participant slash
commands: no command id, no catalog entry, and renderers private to
`ops-commands.ts`. Promoting them to first-class briefs means three commands,
three catalog entries, three sets of prompts, and lifting three renderers into
`render.ts`, which roughly doubles this PR and returns it to the unreviewable
size the three-PR split existed to avoid.

**Decision:** PR 3 adds `janitor` and `preflight` as full briefs (six rows), and
routes the ops three through the seam **without** giving them their own entry
points. The nine-row mockup is corrected to six in the parent spec. Promoting
the ops three stays available as its own later change; nothing here forecloses
it, because the renderers stay where they are and the catalog is the only thing
a new row needs.

### Gate behaviour: the ops three record, they do not prompt

`gate.ts:29-32` splits `EgressKind` into prompting kinds (`quickAsk`, `scm`,
`brief`) and pass-through kinds, on a stated principle: only the surfaces where
**the extension** decides what is sent prompt; the participant sends "text the
user just typed".

The three ops briefs are invoked inside a chat turn, and their argument is what
the user typed after the slash command (`/blast src/foo.ts`). They fall back to
`req.selection?.path` only when called bare — the same editor context the
participant's `#file` handling already sends record-only. Routing them under
kind `"brief"` would drop a workbench-blocking modal into the middle of a chat
turn, and would do it on the strength of an argument the user had just typed.

**Decision:** route them under kind **`"participant"`**, via `gate.record`.
They stop being raw-client calls, they land in `lastPayload()` and therefore in
*Show Last Outbound Payload*, and the chat UX does not change. A per-call
variant — prompt only on the selection fallback, record otherwise — was
considered and rejected: two behaviours for one command is hard to explain to a
user and hard to test.

## Catalog and entry points

`BriefId` gains `"janitor" | "preflight"`.

`BriefContext` gains a fourth value, **`"prompted"`**. The three existing values
describe editor context (`fileAndLine`, `file`, `none`); neither new brief takes
an editor path. Janitor wants a *resource* ref and preflight wants a git ref plus
a namespace — both supplied by the user, so `"prompted"` is what the catalog
should say rather than mislabelling them `"none"`.

| id | label | icon | command | context | gated |
|---|---|---|---|---|---|
| `janitor` | Is this idle? | `trash` | `nimbus.brief.janitor` | `prompted` | ✅ |
| `preflight` | Safe to deploy? | `rocket` | `nimbus.brief.preflight` | `prompted` | ✅ |

Both rows appear in the sidebar for free — `sidebar/agents.ts:67` maps
`BRIEF_CATALOG` — and both get a command-palette entry. **Neither gets an editor
context-menu entry**: the context menu is `when`-clamped to `editorTextFocus`
and exists to pass the cursor's location, which neither brief accepts.

**A parent-spec correction, not a change of plan.** The parent's testing section
asks for a catalog invariant of "exactly one ungated entry, and it is
`whyPeek`". PR 2 correctly kept `whyPeek` **out** of the catalog — it is a hover
provider, not a row, and a catalog entry would have put a dead row in the
sidebar. The exemption is enforced instead by
`egress-choke-point.test.ts:132`, which discovers `agents*` call shapes across
`src/` rather than trusting a hand-kept list. So the catalog stays **entirely
`gated: true`**, and the invariant test asserts exactly that. The parent's line
is corrected.

## Parameters and prompting

`params.ts` stays pure and gains two builders:

```ts
janitorParams({ resourceRef, idleDays? }) → JanitorParams
preflightParams({ ref, namespace })       → PreflightParams
```

The prompting lives in `commands.ts`, behind a new `deps.window.showInputBox`
seam (stubbed in `test/unit/vscode-stub.ts` like every other `vscode` touch).

**Janitor** — two prompts:

1. `resourceRef`, prefilled with the active editor's relative ref when there is
   one, since a file is a plausible resource and a prefill the user can
   overwrite costs nothing. Empty or dismissed cancels.
2. `idleDays`, optional. Empty means omit the parameter and let the Gateway use
   its own default; a non-numeric answer is rejected by the input box's
   `validateInput` rather than silently dropped.

**Preflight** — two prompts:

1. `ref`. Empty or dismissed cancels.
2. `namespace`. **Required**, and an empty answer cancels rather than sending.
   Prefill order: the workspace-remembered last value → the
   `nimbus.briefs.defaultNamespace` setting → blank.

The parent spec's rejection of *deriving* the namespace from the branch name or
`package.json` stands unchanged, and is the reason the prompt is required rather
than inferred: a wrong namespace does not error, it returns a confidently green
`PreflightBrief` computed for something the user never asked about.

Remembering the namespace is a different thing from guessing it — it prefills a
value the user typed and confirmed in this workspace, so a second Preflight in
the same repo is one Enter. It lives in a small `src/briefs/namespace-store.ts`
mirroring `src/egress/skip-store.ts`: `workspaceState`-backed, one getter, one
setter, written only after a brief has actually been sent.

`meta()` widens for `"prompted"`: the manifest names the ref the user typed and
keeps `BRIEF_FILE_NOTE` — the extension sends a path, and what the Gateway does
afterwards is the egress ledger's business, not a claim this surface makes.

## Renderers

Both follow the existing `render.ts` shape: markdown, a "nothing found" line
rather than an empty section, and `gapsFooter(brief)` on every result whether
populated or not.

**`renderJanitor(brief: JanitorBrief)`** — an idle/not-idle verdict over
`query.resourceRef` and `query.idleDays`; the `peersClear` count and the
`peersTouched` rows (`who`, `lastSeenDaysAgo`); `proposalSuppressed` stated
plainly when true rather than hidden; and `cleanupAction` rendered as a
**suggestion the user performs themselves**. The parent spec's out-of-scope list
already fixes this: output is a suggestion, never an applied edit — the rule the
SCM trio follows.

**`renderPreflight(brief: PreflightBrief)`** — a headline computed from
`anyFailed` / `anyIncomplete`, then one row per `PreflightDownstream`
(`pass | fail | declined | not_configured` plus its summary). `not_configured`
and `declined` must read as *unknown*, not as *pass*; this brief informs deploy
decisions and a silent absence of failure is not a green light.

Tests: populated, empty, and with gap notes, against the published client's mock
fixtures rather than hand-rolled fakes, so a brief-shape change surfaces as a
test failure instead of drift.

## Routing the ops three

`RawBriefClient` grows `agentsCatchup` / `agentsExpert` / `agentsImpact`. They
need the *other* gate behaviour, so rather than a boolean flag on
`gateRawBriefs`, the seam gains a second constructor beside it:

```ts
gateRawBriefs(client, gate, withProgress?)      // prompts: gate.check("brief", …)
gateRawParticipantBriefs(client, gate)          // records: gate.record("participant", …)
```

One function per gate behaviour, each named for what it does, and neither
reachable by passing the wrong argument to the other. The participant variant
takes no `progressTitle` — the chat turn already renders its own progress, and a
notification over it would be noise.

`ParticipantClientLike` then drops its three `agents*` methods and takes the
injected seam; `ops-commands.ts` calls `briefs.impact(...)` and friends. Its
renderers and its degrade-honestly contract are untouched.

The guard closes cleanly. Because the call shapes **move into**
`gated-client.ts`, `egress-choke-point.test.ts` deletes `UNGATED_PENDING_PR3`
and moves those three shapes into `GATED_BRIEF_CALLS` — no new `ALLOWED` entry
is needed, because `ops-commands.ts` ends up holding only an injected seam. That
matters: an `ALLOWED` entry would be a guard passing for the wrong reason, which
is the failure mode the test's own comment warns about.

## Settings

One new setting, which must land in `package.json`, `src/settings.ts`,
`docs/settings.md` (or `check-settings-docs` fails) and `test/unit/settings.test.ts`:

| Setting | Type | Default | Why |
|---|---|---|---|
| `nimbus.briefs.defaultNamespace` | string | `""` | `agentsPreflight` requires `namespace` and the extension has no such concept. Prefills the prompt; never substitutes for it. |

## Documentation the PR must correct

These are deliverables, not follow-ups — PR 3 is the PR that makes the prose
true, so leaving the prose stale would defeat its purpose.

- **`CLAUDE.md`** — delete "the three remaining `agents*` calls in
  `ops-commands.ts` are still raw pending PR 3", and correct "all five
  agent-bound paths" to describe what the seam actually covers once the ops
  three route through it.
- **`docs/architecture.md`** — the same seam description.
- **`docs/ROADMAP.md`** — the Phase 2 row *The seven unreached briefs* is
  complete; move it to **Already shipped** with its enabling RPCs.
- **The parent spec** — correct the nine-row sidebar mockup to six, and the
  catalog-invariant line to match how the `whyPeek` exemption is actually
  enforced.
- **`CHANGELOG.md`** — untouched by hand. Release Please writes it from the
  Conventional-Commit PR title.

## Testing

Beyond the renderer and choke-point tests named above:

- **`params.ts`** — the standing invariant holds for the new builders: an
  absolute path never survives into parameters.
- **Catalog** — six entries, all `gated: true`; every `command` unique and
  matching a `contributes.commands` id.
- **`commands.ts`** — driven through `test/unit/vscode-stub.ts`: janitor with
  and without `idleDays`; preflight cancelling on an empty namespace; the
  prefill precedence (workspace memory → setting → blank); and the namespace
  written to workspace memory only after a successful send.
- **Participant** — the ops three go through the injected seam and are
  **recorded, not prompted**; a test asserting `gate.check` is never called for
  kind `"participant"` is what stops a later refactor from quietly adding a
  modal to a chat turn.

All pure modules stay free of `vscode`, per the standing convention.

## Out of scope

Everything in the parent spec's out-of-scope list still applies —
`agentsGlossary`, streaming or cancelling a brief run, acting on a brief, the
sidebar gear icon, and fix-it links keyed on Gateway error prose. Plus, from the
decisions above:

- **Promoting `catchup` / `expert` / `impact` to first-class briefs** with their
  own commands and sidebar rows. Deferred, not rejected; PR 3 leaves the path
  open.
- **A prompting gate on the participant's briefs.** Rejected on the gate's own
  stated principle, not deferred for effort.
