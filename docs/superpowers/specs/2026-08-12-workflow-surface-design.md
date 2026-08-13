# Workflow surface — design

**Date:** 2026-08-12
**Status:** approved, not yet implemented
**Repos:** `nimbus-vscode`, `Nimbus` (gateway), `nimbus-client`

## Problem

The roadmap calls the workflow surface "the flagship gap": the Gateway runs
workflows, `@nimbus-dev/client` `0.16.0` types the whole family, and the
extension has no presence for any of it.

Reading the client's types closely shows the gap is not one feature but two
problems with different owners:

1. **Observability is buildable today.** `workflowList` and `workflowListRuns`
   are read-only, reach no model, and need nothing new from anyone.
2. **Running a workflow is not honestly buildable today.** Two shipped
   protocol limitations block it, and both live in the Gateway:
   - `workflow.run` chunks ride the **untagged** `agent.chunk` notification
     (`ipc/server/inline-handlers.ts:50` emits `params: { text }`), so a live
     run cannot be told apart from a concurrent `agent.invoke` stream or from
     another run. The client documents this as "ONE AT A TIME PER CONNECTION".
   - There is no `workflow.cancel` anywhere in the Gateway, so
     `WorkflowRunStreamHandle` deliberately ships **no `cancel()`** — its own
     comment says offering one "would be a lie."

The roadmap row reads "run / monitor / **cancel** workflows". The third verb is
not deferred by choice; it does not exist. This spec corrects that row.

## Scope

**In scope:** a read-only Workflows view in the extension; the Gateway protocol
work that makes a future run surface honest; the client release that types it.

**Out of scope:** running workflows from the extension, authoring
(`workflowSave`), and deletion (`workflowDelete`). Authoring in particular is
deferred on purpose — `steps_json` is an opaque string the Gateway does not
parse at save time, so a malformed DAG saves cleanly and fails only at run
time. Offering an editor for it needs its own validation design.

## Guiding constraint

`nimbus-vscode` never reaches past the typed client (CLAUDE.md,
*Conventions / non-negotiables*). So the dependency chain is strict and
one-directional:

```
Gateway RPC  →  nimbus-client types + release  →  extension bumps the pin
```

The Gateway work in this spec therefore ships **no user-visible value on its
own**. It pays off only when a later extension PR — explicitly out of scope
here — builds the run surface on top of it. The extension work that lands this
round is the viewer, which depends on none of it.

---

## Part 1 — Extension: the Workflows view

Lands first and independently; it is the only part with user-visible value in
this round.

### Components

**`src/sidebar/workflows.ts`** (pure, no `vscode`). Takes a narrow client slice
— `workflowList`, `workflowListRuns` — and returns `SidebarItem[]`, following
`audit.ts` / `index.ts`.

- **Top-level row per saved workflow.** `name` as label; `updated_at` rendered
  through `relative-time.ts` as the description; `description` in the tooltip
  (workflows with a `null` description get the name).
- **Child row per run**, from `workflowListRuns({ workflowName, limit })`,
  most recent first.
  - `iconId` from `status`: `pass` for `done`, `error` for `error`, `dash`
    for `running`, `circle-slash` for `cancelled`.
  - description: `durationMs` humanised, plus `triggeredBy`.
  - a dry-run badge when `dryRun` is true.
  - `errorMsg` in the tooltip when present.

`status` is typed `string`, not a union, so the mapping must have a default
branch rather than assume the four values above. Note the view renders
`cancelled` even though nothing produces that status until Part 2 ships — this
is deliberate, so the viewer needs no change when cancellation lands.

**`src/sidebar/workflows-view.ts`** — the thin `createDataView` wrapper,
mirroring `audit-view.ts`.

**Registration** — `nimbus.workflowsView` added to `contributes.views.nimbus`
in `package.json` (the sixth view, after Audit, Egress, Agents, Index,
Sessions), its `viewsWelcome` entry for the disconnected case, a
`nimbus.refreshWorkflows` command, and wiring in `extension.ts`.

### One targeted repair to the shared seam

`createDataView` today resolves children synchronously from precomputed data:

```ts
getChildren: async (element) =>
  element === undefined ? await loadRows() : (element.children ?? [])
```

Populating this view under that contract means calling `workflowListRuns` for
every saved workflow when the view opens — N+1 round trips for rows nobody
expanded.

`tree-view.ts` gains an optional `loadChildren?: (item: SidebarItem) =>
Promise<SidebarItem[]>` on `createDataView`. When supplied, `getChildren`
delegates to it for a non-root element; when omitted, behaviour is exactly
today's, so the other five views are untouched. A row opts in by declaring
`children: []`… which the current `toTreeItem` would render as a leaf, so
`toTreeItem` also gains an explicit `collapsible?: boolean` on `SidebarItem`
for rows whose children are not yet loaded.

This is in-scope repair of the code the feature sits on, not unrelated
refactoring.

### Egress

Neither RPC reaches a model, so no pre-flight gate involvement and no change to
`egress-choke-point.test.ts`. Worth stating explicitly: read-only Gateway data
is not egress, and this view must not be read as an exception to the gate.

### Testing

Vitest over the pure module with a stub client: populated tree, workflow with
zero runs, empty workflow list, `workflowListRuns` rejecting (error row),
unknown status string, `null` description, `null` `finishedAt`/`durationMs` on
a still-running row, and the disconnected placeholder. Plus a `tree-view.ts`
test that `loadChildren`'s absence preserves current behaviour.

### Documentation

CLAUDE.md surface paragraph, `docs/architecture.md`, and the roadmap: move
**Workflow surface** out of Phase 2 into *Already shipped* as the viewer only,
and correct its "cancel" verb — cancel is Gateway work tracked by Part 2, not a
shipped capability. `CHANGELOG.md` is written by Release Please and must not be
hand-edited.

---

## Part 2 — Gateway: tagged chunks and `workflow.cancel`

### The crux

`workflow.run` resolves only when the run **finishes**. A server-minted stream
id therefore cannot reach the client in time to filter chunks against or to
cancel with. Rejected alternatives: an early `workflow.started` notification
(adds a method and a startup race the client must buffer against), and
reshaping `workflow.run` to return `{ streamId }` immediately like `askStream`
(a breaking change to a shipped RPC).

**Decision: the client supplies the correlation id.** It is known before the
request is sent, so there is no race, and the change is purely additive on the
wire.

### Changes

- **`WorkflowRunContext`** (`ipc/workflow-invoke.ts`) gains `streamId?: string`
  and `signal?: AbortSignal`. This file is type-only and coverage-excluded by
  exact path — it must stay type-only.
- **`workflow.run` params** accept an optional `streamId`, parsed in
  `buildWorkflowRunContext`.
- **`sendAgentChunkIfStreaming`** (`ipc/server/inline-handlers.ts`) echoes the
  id when present, emitting `{ streamId, text }`. When absent it emits
  `{ text }` byte-for-byte as today. The same optional echo is applied to
  `dispatchAgentInvoke`, which fixes `agent.invoke`'s untagged stream for free.
- **A run registry, keyed per client.** `dispatchWorkflowRunRpc` registers an
  `AbortController` and unregisters it in a `finally`, mirroring what
  `createAskStreamHandler` already does with `deps.registry`. The key is
  `clientId` + `streamId`, **not** the bare id: the registry is created once
  per server (`server.ts:68`) and shared by every session, and the id is now
  chosen by the caller, so a bare key would let one client abort another
  client's run and let one client's cleanup unregister another's entry.
  Reusing an id already live for the *same* client is rejected with `-32602`.
  A useful consequence: `engine.cancelStream`, which passes a bare id, cannot
  reach a workflow run.
- **`workflow.cancel`** — a new RPC taking `{ streamId }`, aborting the
  registered controller and returning whether one was found. Deliberately a
  distinct method rather than an overload of `engine.cancelStream`: the client
  currently documents that no workflow cancel exists, so a distinctly named
  method makes the new capability discoverable and keeps ask-stream semantics
  unpolluted.

### Cancellation semantics — next step boundary

`runWorkflowExecution` → `executeRealRunSteps` loops steps sequentially with no
signal anywhere in `RunWorkflowExecutionParams`. Threading abort into every
step executor — including the LLM calls inside a step — is a much larger change
with its own timeout and partial-write questions.

**Decision: cancellation takes effect at the next step boundary.** The signal
is checked between steps; the in-flight step runs to completion. On abort the
run is finalised with a terminal `cancelled` status via `finalizeRun`, so run
history reflects it and the Part 1 viewer renders it.

**The terminal status also travels in the run result.** `runWorkflowExecution`
returns `status` alongside `runId` / `dryRun` / `stepResults`, taking one of
`"preview"` (dry run) / `"done"` / `"error"` / `"cancelled"`. Without it an
IPC caller — which cannot read the `workflow_run` table — could not tell a run
cancelled after one step from a one-step run that completed, which would leave
the whole cancel feature unobservable to its only consumer.

This is a real limitation and must be documented as one — in the client's
`workflow.cancel` docstring and in the eventual extension UI — rather than
presented as immediate cancellation. A workflow whose single step is a long
model call will not stop early.

### Backward compatibility

Every wire change is additive: omitting `streamId` reproduces today's exact
behaviour, and older clients ignore the extra params field. No existing client
breaks against a newer Gateway.

### Testing

Gateway suites alongside the code being changed: `inline-handlers.test.ts` for
the echo (present and absent), a registry test for register/abort/unregister,
`workflow.cancel` against both a live id and an unknown one, and a
`workflow-runner-execution.test.ts` case asserting an aborted run stops at the
next boundary and finalises as `cancelled`. A regression test asserting
`agent.chunk` is unchanged when no `streamId` is supplied guards the
compatibility claim.

---

## Part 3 — Client: type it and release

- `WorkflowRunParams.streamId?: string`.
- `WorkflowRunResult.status: string` — `"preview" | "done" | "error" |
  "cancelled"`. Additive, so it does not break existing consumers.
- `workflowCancel(params: { streamId: string }): Promise<{ cancelled: boolean }>`,
  where `false` means no live run of *this connection's* client held that id.
  Document that ids are scoped per client: two clients may use the same id,
  and one client can never cancel another's run.
- `workflowRunStream` mints its own id, passes it, and **filters incoming
  chunks by it**. Because reusing a live id is rejected `-32602`, the minted id
  must be unique per run — a UUID, not a constant.
- Consequently its documentation drops the "ONE AT A TIME PER CONNECTION"
  caveat, and `WorkflowRunStreamHandle` gains the `cancel()` its current
  comment calls a lie — with the next-step-boundary semantics stated plainly.
- Release, then bump `@nimbus-dev/client` in `nimbus-vscode` (a published
  `^x.y.z`, never `workspace:*`).

---

## Sequencing

| PR | Repo | Depends on |
| --- | --- | --- |
| 1. Workflows view | `nimbus-vscode` | nothing |
| 2. Tagged chunks + `workflow.cancel` | `Nimbus` | nothing |
| 3. Type + release | `nimbus-client` | PR 2 |
| 4. *Run surface (out of scope)* | `nimbus-vscode` | PR 3 |

PRs 1 and 2 are independent and can proceed in either order or in parallel.
Work begins on PR 2 (the Gateway), in a dedicated worktree.

## Success criteria

- A connected user sees their saved workflows and each one's recent runs in the
  sidebar, with status, duration, trigger and errors, without touching the CLI.
- Two concurrent streaming operations on one connection can be told apart by
  `streamId`.
- A running workflow can be cancelled and finalises as `cancelled` in run
  history *and* in the run result, with the boundary limitation documented
  rather than papered over.
- One client cannot cancel, or clobber the registry entry of, another client's
  run — including by reusing its `streamId`.
- No existing client behaviour changes when `streamId` is omitted.
