# Built-in briefs, PR 3 — janitor, preflight, and one seam for every agent call

**Status:** design, approved 2026-08-11; revised the same day to absorb
[2026-08-11-built-in-briefs-pr3-design-review.md](./2026-08-11-built-in-briefs-pr3-design-review.md).
Four of its six findings changed the design (per-folder namespace memory,
`idleDays` validation, the `file`-scheme prefill guard, and prompt-before-Retry
ordering). One — the Restricted Mode and egress-policy question — changed no
behaviour but is now answered explicitly and pinned by tests. One is declined,
with its reasoning in *Out of scope*, alongside the one sub-point declined from
an otherwise accepted finding.
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

The prompting lives in `commands.ts`, over `WindowApi.showInputBox` — which the
shim already exposes with `validateInput` (`vscode-shim.ts:113-118`), so this
widens the commands' narrow `deps.window` type rather than the shim itself.

**Janitor** — two prompts:

1. `resourceRef`, prefilled with the active editor's relative ref **when that
   editor is a `file`-scheme document**. PR 2 already settled this question for
   the hover, in the same words and for the same reason
   (`real-hover.ts:10-12`): an untitled buffer has no path to blame, and a
   virtual document — our own read-only brief tabs included — is not in any
   repo. Prefilling from a settings editor or from a Nimbus result tab produces
   a ref like `Untitled-1`, which is not a resource anyone can look up. Empty or
   dismissed cancels.
2. `idleDays`, optional. Empty means omit the parameter and let the Gateway use
   its own default. When supplied it must be a **positive integer**
   (`/^[1-9]\d*$/`), rejected in `validateInput` rather than silently dropped:
   `JanitorParams.idleDays` is a `number` with no stated domain, and `-5` or
   `2.5` would be accepted by a bare `Number.isNaN` check and sent to a Gateway
   whose behaviour on them is undefined. No upper bound is imposed — see *Out of
   scope*.

The `file`-scheme test belongs at the **`deps.activeEditor()` seam**, wired in
`extension.ts` where a real `vscode.TextEditor` is in hand, rather than on
`TextEditorLike` — which carries `fileName` but no `uri`, and widening it would
touch the stub and every test that constructs an editor for a reason unrelated
to this PR.

Putting it there also corrects `why` / `ghost` / `conflicts`, which today accept
any active editor and will happily send `Untitled-1` as a ref. After this they
report *"Open a file to run …"* instead — a visible behaviour change, small and
in the direction of correctness, and called out here so it is not mistaken for
a regression during review.

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
value the user typed and confirmed **for this project**, so a second Preflight
in the same repo is one Enter. It lives in a small
`src/briefs/namespace-store.ts` mirroring `src/egress/skip-store.ts`:
`workspaceState`-backed, one getter, one setter, written only after a brief has
actually been sent.

**The memory is keyed per workspace folder, not per window.** `workspaceState`
is shared across the whole VS Code window, so in a multi-root workspace a single
key would let a Preflight in project A prefill project B's prompt — and the
parent spec's own argument then convicts it. A namespace remembered from another
project is not "a value the user confirmed here"; it is a guess wearing a
confirmation's clothes, and a wrong namespace does not error, it returns a
confidently green `PreflightBrief` computed for something the user never asked
about. That is precisely the failure the parent spec rejected branch-name
derivation to avoid, so the same standard applies to a stale prefill.

The key is `nimbus.briefs.namespace:${folder}`, where `folder` is the workspace
folder containing the active editor, or the sole root when there is exactly one.
When neither holds — no editor open and several roots — **nothing is recalled**
and the prefill falls through to the setting. Failing to the safe side costs one
typed namespace; the alternative costs a bad deploy decision.

`meta()` widens for `"prompted"`: the manifest names the ref the user typed and
keeps `BRIEF_FILE_NOTE` — the extension sends a path, and what the Gateway does
afterwards is the egress ledger's business, not a claim this surface makes.

### Prompt first, then guard — so Retry does not re-ask

`commands.ts` wraps each brief in `contain(id, body)`, which on failure offers
**Retry** and re-runs `body` verbatim. The parent spec promises Retry "re-runs
the command with the same pre-resolved args, so nothing is re-prompted for".
Putting the prompts inside `body` would break that promise the first time a
Gateway call failed: the user would answer the same two questions again to
retry a send they had already authorised.

So the prompted briefs resolve their parameters **before** entering `contain`,
and `contain` wraps only the send and the render. A dismissed prompt returns
early and silently — a user who cancelled a prompt has not failed at anything
and should not be shown an error with a Retry button.

The same reordering fixes a smaller pre-existing slip in `why` / `ghost` /
`conflicts`, which resolve `target(args)` *inside* `body` (`commands.ts:117-153`).
When they are invoked bare, that re-reads the active editor on retry, so a
cursor moved between the failure and the click silently redirects the retry to a
different line. Hoisting the resolution out of `contain` makes the existing
claim true for every brief, prompted or not.

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

### What `record` does and does not do

Raised in review, and worth stating outright because the words "gate" and
"policy" invite a stronger reading than the code supports: **the gate never
blocks anything.** `check` prompts and obeys the answer; `record` does not even
prompt. Neither consults a policy, and there is no rule set that could forbid a
send — *Egress policy management* is a Phase 4 item precisely because no
published client exposes the RPCs for it.

Two consequences follow, and the tests should pin both:

- **Restricted Mode does not change the ops three.** `deps.isTrusted()` is read
  only inside `check` (`gate.ts:109-110`), where it suppresses a stored *skip*
  and hides the *Always send here* button. `record` never reads it. An untrusted
  workspace therefore behaves identically here — which is correct, since nothing
  was being suppressed in the first place.
- **The leak check gains reach rather than losing it.** `findLeakedRoots` has
  never blocked a send; it adds a warning line to a rendered manifest
  (`preflight.ts:59-66`). Today the ops three render no manifest at all, because
  they bypass the seam entirely. After this change they are recorded, so
  *Show Last Outbound Payload* renders them — leak warning included. The
  no-prompt routing is strictly more visibility than the status quo, not less.

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

Declared at the default **window** scope, like every existing `nimbus.*` setting
— none declares a `scope` today. Marking it `"scope": "resource"` was raised in
review; see *Out of scope* for why it would not work yet.

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
  and without `idleDays`; `validateInput` rejecting `-5`, `2.5` and `abc` while
  accepting `30` and empty; preflight cancelling on an empty namespace; the
  prefill precedence (workspace memory → setting → blank); the namespace written
  to workspace memory only after a successful send; and a dismissed prompt
  returning silently rather than as an error with a Retry.
- **Retry does not re-prompt** — a failing send followed by Retry re-sends the
  *same* parameters, with `showInputBox` called exactly as many times as the
  first attempt. Extended to the editor briefs: a target resolved once is not
  re-derived when the active editor changes between the failure and the retry.
- **`namespace-store.ts`** — two folders keep two namespaces; recall returns
  nothing when there is no active editor and more than one root.
- **`activeEditor()` scheme filter** — a non-`file` document yields no editor, so
  a prompted brief gets no prefill and an editor brief reports "Open a file…".
- **Participant** — the ops three go through the injected seam and are
  **recorded, not prompted**; a test asserting `gate.check` is never called for
  kind `"participant"` is what stops a later refactor from quietly adding a
  modal to a chat turn. A second asserting the behaviour is identical when
  `isTrusted()` is false pins the Restricted Mode answer above.

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
- **`"scope": "resource"` on `nimbus.briefs.defaultNamespace`.** Raised in
  review, and right in principle — a default namespace is project-specific. It
  is declined because it would not work: `createSettings` reads every value
  through `workspace.getConfiguration("nimbus")` with **no resource argument**
  (`settings.ts:24`), and VS Code resolves a resource-scoped setting read that
  way against the workspace, ignoring folder overrides. Declaring the scope
  would let the settings UI and `.vscode/settings.json` accept a per-folder
  value that the extension then silently ignores — worse than window scope,
  because it advertises a capability that does not exist. It becomes correct the
  day `createSettings` threads a resource URI, which is a cross-cutting change
  to every `nimbus.*` setting and belongs in its own PR. Until then the
  per-folder need is met by the namespace memory, which *is* keyed per folder.
- **An upper bound on `idleDays`.** Raised in review (`> 3650`). Declined: no
  typed contract states a maximum, so any number chosen here is the extension
  inventing a Gateway limit — the same guessing the parent spec rejects
  elsewhere. An absurd value costs a "not idle" answer, not a wrong one, so the
  failure is visible and self-correcting. The positive-integer rule is kept
  because `-5` and `2.5` are *malformed*, not merely large.
