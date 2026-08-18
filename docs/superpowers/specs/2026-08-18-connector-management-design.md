# Connector management & index health — design

Status: approved in brainstorming 2026-08-18, not implemented.
Roadmap rows: Phase 3, *Connector management* (effort L) and *Index write ops*
(effort M) — both unblocked by the pinned `@nimbus-dev/client` (`^0.17.0`).

## The problem

Every Gateway-backed surface this extension ships is only as good as the local
index: Search, *Find related*, *Find prior occurrences*, the Index view, the
context panel's Related section, and every brief that cites indexed items.

The extension is not *silent* about this today — that framing, used in the
brainstorming that led here, was wrong and reading the code corrected it. A
timer in `extension.ts` already polls `connectorListStatus` and feeds
`summarizeConnectorHealth` (`src/status-bar/connector-health.ts`) into the
status bar, which renders `2 degraded: github, slack` in its text and tooltip.
That poll is load-bearing for another reason too: its `catch` calls
`connection.noteTransportFailure`, making it the transport-failure detection
path that runs even when the egress badge is switched off.

What is missing is everything after the count. The status bar says *that* two
connectors are unhealthy; nothing says **which error**, **since when**, **how
often it has failed**, or **what to do about it** — and there is no way to act
at all. Pausing a runaway connector, re-authenticating an expired token,
forcing a sync, re-indexing at a deeper level, or removing a source all mean
leaving the editor for the CLI.

So the gap this closes is detail and remedy, not detection. That also fixes
where the new work belongs: a surface that *explains and acts*, reusing the
health signal that already exists rather than computing a second one.

The pinned client types the whole `connector*` suite. The gap is a surface, not
a capability.

## Scope

**In:** a `nimbus.connectorsView` tree view with per-connector health, sync
telemetry and health history; the safe mutations (pause, resume, sync,
set interval/depth/enabled, re-index); the two HITL-gated ones (add MCP
connector, remove); credential entry via `connectorAuth`; and a conditional
**Sources** row in the ambient context panel when a connector is unhealthy.

**Out, because no RPC exists:** onboarding a *built-in* connector. The client
exposes `connectorAddMcp` and nothing else that registers a connector, and
`connectorListStatus` returns only **registered** connectors. The extension can
authenticate and configure what the Gateway already knows about, and register
MCP sources; standing up a new Jira or GitHub connector stays a CLI job until a
`connector.add` RPC ships. The view says this rather than implying otherwise.

**Out by choice:** editing a registered MCP connector's command line (add and
remove only), health sparklines or charts, and any automatic mutation. Nothing
here syncs, re-indexes or pauses without the user asking.

**Out, and worth wanting: showing an MCP connector's command line.** Surfacing
the command a registered `mcp_*` connector runs would fit this extension's
posture squarely — you could see what executes beside your editor without
opening the CLI. It is not deferred on taste: `commandLine` appears in the
typed client **only as an input to `connectorAddMcp`**. No status, result or
notification type carries it back, so there is nothing to render. This is a
Phase 4 row — it needs a client that returns it — not a task someone can pick
up on this branch.

## Non-negotiable posture

**No new outbound path.** The `EgressKind` count stays at eight. Nothing in
`src/connectors/` reaches a model: none of the twelve `connector*` RPCs takes a
prompt or returns a completion, so — exactly like `searchRanked` and
`agentsWhyPeek` — they sit outside the pre-flight gate.
`test/unit/egress-choke-point.test.ts` must stay green **without modification**:
`src/connectors/` never names `agentInvoke`, `askStream` or a gated `agents*`
call, and `src/connectors/` is never added to that test's `ALLOWED` list.

As in `src/context/`, comments in new files must not spell a dotted `agents*`
call followed by a paren — the discovery test scans comments. Write `agents*` in
prose.

**Secrets never rest here.** `connectorAuth` is the first call in this extension
that handles a user credential. The extension is a conduit, not a store:

- values are read from a masked input box, passed to the local Gateway, and
  dropped when the command returns;
- nothing is written to `SecretStorage`, settings, workspace state, or a file;
- nothing is logged — not the value, not its length, not a redacted preview —
  and auth payloads never appear in `Show Last Outbound Payload`, which is a
  gate artefact and this call is not gated;
- a unit test asserts no field value collected by the auth flow can reach the
  output channel.

The Gateway's Vault owns the secret. That is the whole point of writing it
through `connectorAuth` rather than into a setting.

## Architecture

`src/connectors/`, following the shape of `src/diagnostics/` and `src/scm/`: a
pure core, with `vscode` reached only through `vscode-shim.ts`.

| File | Purpose | Touches the shim |
| --- | --- | --- |
| `health.ts` | `summarizeConnectorHealth`, **moved** from `src/status-bar/`. It now has three consumers (status bar, this view, the context panel), so it belongs with the connector code rather than inside one of them. Body unchanged. | no |
| `catalog.ts` | `AUTH_CATALOG`: `serviceId` → ordered `AuthField[]`, plus display names and the generic fallback descriptor. Pure data. | no |
| `rows.ts` | `ConnectorSyncStatus[]` → `SidebarItem[]`; status→icon, description, tooltip, `contextValue`, sort order. Telemetry and health-history rows too. | no |
| `outcome.ts` | The `ConnectorOutcome` union and the wording for each variant. Pure. | no |
| `connector-client.ts` | The adapter over a narrow structural `ConnectorClientLike` seam: every mutation normalised to a `ConnectorOutcome`. No `vscode`. | no |
| `connectors-view.ts` | `createDataView` wrapper plus `loadChildren` for on-expand detail. | no |
| `commands.ts` | Confirmations, input boxes, quick picks, progress, refresh — over injected deps, mirroring `src/scm/commands.ts`. | yes (typed shim interfaces only) |

Wired in `extension.ts`, the composition root, exactly as the other six sidebar
views are. The client is resolved **per call** (`getClient: () => nimbus()`),
never captured — the reconnect-stranding fix from #103 applies here too, and a
connector command is precisely the kind of long-lived surface that would strand
a captured client across a Gateway restart.

Six of the seven files are pure and unit-testable with no `vscode` stub.

## The view

`nimbus.connectorsView`, an **eighth** view in the `nimbus` container (Context,
Audit, Egress, Agents, Index, Sessions, Workflows are the seven), placed after
`nimbus.indexView` — "what is indexed" then "where it comes from".

### Rows

One row per connector from `connectorListStatus()`, sorted by **status severity
then `serviceId`**: a health surface puts the broken one on top, and a total
order keeps the rendering deterministic and testable.

| Field | Rendering |
| --- | --- |
| `status` | icon — `error` → `error`, `backoff` → `warning`, `paused` → `debug-pause`, `syncing` → `sync`, `ok` → `pass` |
| `enabled: false` | overrides the icon with `circle-slash`; the row reads *disabled* regardless of `status` |
| `itemCount`, `lastSyncAt` | description: `1,204 items · synced 3m ago`, via the existing `formatRelativeTime(now, ts)` |
| `lastSyncAt: null` | description: `never synced` — not `synced 56 years ago` |
| `lastError`, `consecutiveFailures`, `intervalMs`, `depth`, `nextSyncAt` | tooltip |
| `status` + `enabled` | `contextValue`: `nimbus.connector.active` / `.paused` / `.disabled` / `.syncing`, so Pause and Resume never both appear and the sync family is hidden mid-sync (see *Concurrency*) |

Empty result: a single `No connectors registered` row, plus an *Add MCP
connector* row — the one kind of source the extension can actually register.

### On expand

`loadChildren`, the pattern the Workflows view established, for the same reason:
detail costs a round trip per row, and eager children would spend one RPC per
connector on every open.

- **Recent syncs** — `connectorStatus({serviceId, includeStats: true})`, up to
  the 15 telemetry rows the Gateway returns: started-at, duration, items
  upserted/deleted, and `errorMsg` when present.
- **Health history** — `connectorHealthHistory({service, limit})`, rendered as
  `from → to · reason`.

**Error text from the Gateway is shown verbatim, and never logged.** A
connector's `lastError` and a telemetry row's `errorMsg` can carry hosts,
paths, usernames or connection-string fragments, and that is precisely what
makes them actionable — a redacted "connection failed" leaves the user exactly
where they started, and the pre-flight gate redacts paths because they *leave
the machine*, which nothing here does. The information is the user's own,
about their own connector, displayed to them alone.

The one rule that follows from that: this text is **not** written to the output
channel. The log is the artefact people paste into issues and screenshots, so
the copy that could travel is the copy we do not create.

**`connectorHealthHistory` accepts built-in connector ids only** — the client
states this explicitly, and a user MCP id is rejected. For a `serviceId`
matching `mcp_*` the call is **skipped, not attempted**: the expand renders the
telemetry group and omits the history group rather than showing an error the
user cannot act on.

### Liveness

**No second timer.** A connector poll already runs — `pollConnectorHealth` in
`extension.ts`, on `settings.statusBarPollMs()` — and it already fetches the
full `ConnectorSyncStatus[]`, summarising it for the status bar and throwing
the rest away. This surface hangs off that existing poll instead of starting
its own: the poll keeps the last statuses it read, and a change in the
*degraded summary* refreshes the view. Adding a second interval over the same
RPC would double the traffic to say the same thing.

The view still fetches on open and on explicit refresh, because a tree that
renders whatever the last poll happened to see is stale by up to one poll
interval at the moment you look at it.

Beyond that, the view refreshes on:

1. **`subscribeConnectorConfigChanged`** — the Gateway emits one after every
   `setConfig` / `pause` / `resume` / `setInterval`. Treat it as an
   **invalidation signal, not a row patch**: its payload carries `service`,
   `intervalMs`, `depth` and `enabled`, but none of `status`, `itemCount` or
   `lastSyncAt`, which is most of what a row shows. Refresh, don't reconcile.
2. **any mutation this extension issues** — including `sync`, `reindex`,
   `auth`, `addMcp` and `remove`, none of which emit that notification.
3. **the connection state changing** — already free from `createDataView`.
4. **an explicit `view/title` refresh command.**

**Notifications are debounced before they invalidate anything.** The Gateway
emits one `configChanged` per mutation, so a multi-field `setConfig` — or a
script pausing every connector in a loop — arrives as a burst. The view takes
the notification through `createDebouncer(250, …)`, the seam
`src/context/debounce.ts` already provides for editor events, so a burst costs
one `connectorListStatus` rather than one per notification. Debouncing matters
here specifically because each refresh is an RPC; the controller's in-flight
coalescing does not help, since it merges *concurrent* collections and a burst
landing after each refresh completes would refetch every time.

The context panel needs none of this: its Sources row reads an in-memory
summary, so a burst costs a re-render, not a round trip.

## Write operations

Nine commands, every one routed through `connector-client.ts`:

| Command | RPC | Confirmation |
| --- | --- | --- |
| Sync now | `connectorSync({serviceId})` | none |
| Full re-sync | `connectorSync({serviceId, full: true})` | modal — it clears the cursor |
| Pause / Resume | `connectorPause` / `connectorResume` | none |
| Configure | `connectorSetConfig` (interval, depth, enabled in one call) | none |
| Re-index | `connectorReindex({service, depth})` | modal at `depth: "full"` only |
| Authenticate | `connectorAuth` | none (the input boxes are the confirmation) |
| Add MCP connector | `connectorAddMcp` | none — HITL consent is the confirmation |
| Remove | `connectorRemove` | modal, naming the item count |

### Concurrency

Two guards, at two different levels, because they catch different mistakes.

**Menu-level, from `contextValue`.** A connector whose last-read `status` is
`syncing` carries `nimbus.connector.syncing`, and the `when` clauses omit
**Sync now**, **Full re-sync** and **Re-index** for it — asking for a sync
during a sync is at best redundant.

**Pause and Remove stay available while syncing, deliberately.** A runaway or
wedged sync is exactly when a user reaches for Pause, and hiding it would leave
the one useful action behind the one state that needs it. Remove already
confirms modally, which is guard enough.

That guard is best-effort by construction: `status` is as fresh as the last
`connectorListStatus`, so a sync started elsewhere leaves the menu briefly
wrong. It suppresses the common mistake; it is not a lock, and the spec should
not pretend otherwise.

**Command-level, in `commands.ts`.** A `Set` of in-flight `serviceId:command`
keys, so a double-click (or a click on a stale menu) cannot issue the same
mutation twice. A second invocation while the first is in flight is a no-op,
not a queued call. This is the guard that actually holds, since it does not
depend on row freshness.

### One outcome type, four wire shapes

This is the reason the adapter exists. The suite reports failure in four
different ways, and two of them mean *denied* rather than *broken*:

| Wire shape | Calls | Normalised to |
| --- | --- | --- |
| resolves `{ok: false}` | pause, resume, setInterval, setConfig, sync | `failed` |
| resolves `{status: "rejected", reason}` (**never throws**) | addMcp, remove | `denied` |
| **rejects** on denial | reindex at `depth: "full"` | `denied`, distinguished from a genuine error by inspecting the rejection |
| rejects | any of them, on a real error | `failed` |

```ts
type ConnectorOutcome =
  | { kind: "applied"; detail?: string }
  | { kind: "denied"; reason: string }
  | { kind: "failed"; message: string };
```

`denied` is worded as a decision, never as a breakage — *"Removing github was
not approved."* A denial is the consent system working. Collapsing it into an
error message is the specific bug this table exists to prevent — and with three
separate calls able to be denied, in two different shapes, a per-command
implementation only has to get one of them wrong.

`connectorSetConfig` resolves a result whose fields read `null` for anything not
requested — *not* "the value was cleared". The adapter reports only what it
asked to change.

### The two blocking calls

`connectorAddMcp` and `connectorRemove` are HITL-gated (I2): the promise does
not settle until the owner answers the consent request the Gateway raises.

No new consent machinery is needed. `subscribeHitl` is already bound globally
and `createHitlRouter` is generic over `HitlRequest`, so the prompt surfaces
through the existing toast/modal path on its own. The command's own job is
narrower:

- show a **non-cancellable** `withProgress` notification — *"Waiting for your
  consent…"*. The RPC has no cancel; the workflow surface already set the rule
  that this extension does not offer a stop that does not stop.
- call `withProgress(options, (progress, token) => …)` with the **reporter
  first** — the argument order that broke every workflow run in #100, and the
  reason the shim carries a comment about it.
- render the resolved outcome, remembering that a denial **resolves**.

**The extension adds no timeout of its own.** The wait is bounded by the
Gateway, not by us: `GatedRejection` is documented as the shape a HITL-gated
`connector.*` call resolves with when it is *"denied / timed-out /
consent-disconnected"*, and none of the connector methods accepts a `timeoutMs`
(unlike the `agents*` family, which all do). An ignored consent request
therefore settles on its own.

A defensive extension-side timer would be actively wrong here: it would close
the notification and report a timeout while the Gateway call is still live, so
a consent answered a minute later would take effect against a UI that already
said it hadn't. The only two states are "still waiting" and "the Gateway
settled it".

Because all three of those endings arrive as the same shape, the `denied`
message shows the Gateway's `reason` **verbatim** rather than asserting a
person declined — a request that expired unanswered and one someone actively
rejected must not read identically.

Removal confirms modally and names what goes:

> Remove `github`? This deletes its 1,204 indexed items and clears its stored
> credentials.

The item count comes from the row's `itemCount`. If it is unavailable the
sentence drops the number rather than guessing at one.

## Credentials

`AUTH_CATALOG` maps a `serviceId` to an ordered list of fields:

```ts
type AuthField = {
  name: string;            // the wire field, e.g. "personalAccessToken"
  label: string;           // "GitHub personal access token"
  secret: boolean;         // masked input, never logged
  required: boolean;
  placeholder?: string;
};
```

**Sourcing.** `ConnectorAuthParams` is `{serviceId} & Record<string, unknown>`
and the client deliberately declines to type the rest, pointing at the
Gateway's `ipc/connector-rpc-handlers/auth.ts`. We cannot read that file — the
non-negotiable forbids reaching past the client — so catalog entries are seeded
**only from field names the pinned client's own JSDoc states**: PAT-style
`personalAccessToken`/`token`, OAuth `scopes`/`port`, `atlassianEmail` and
`apiBaseUrl` for Jira/Confluence, `awsAccessKeyId`, `azureTenantId`,
`gcpCredentialsJsonPath`. Sourced, not guessed.

**Drift is real and is handled, not hidden.** A Gateway that renames a field or
adds a provider will out-run this catalog. Two mitigations:

1. An unknown `serviceId` falls back to a **generic flow**: one credential
   prompt, then a repeating *Add another field* step (field name, value, is it
   secret). Anything the Gateway wants can still be sent.
2. A rejected call reports the Gateway's own message verbatim, which is what
   names the missing or misspelled field.

The drift risk is recorded in a new `docs/connectors.md`, not buried in a
source comment.

**OAuth providers** carry a catalog entry with no required fields: the command
calls `connectorAuth({serviceId})` and tells the user the Gateway will open a
browser and listen on a local port. The extension neither opens nor brokers it.

**Input handling.** Each field is one `showInputBox`, `secret` fields with
`password: true` and every field with `ignoreFocusOut: true` — losing a
half-entered credential to a stray click is a bad enough experience to be worth
the option. Cancelling any prompt abandons the whole flow; nothing partial is
sent.

**Validation stops at emptiness.** `validateInput` (already on the shim's
`showInputBox`) rejects a blank or whitespace-only value for a `required: true`
field, and values are trimmed. That much is the extension's own contract: it
declared the field required, so it can enforce it without knowing anything
about the Gateway.

**Format validation is deliberately absent.** We do not check that
`apiBaseUrl` parses as a URL or that `gcpCredentialsJsonPath` exists on disk.
The catalog's field *names* are sourced from the client's JSDoc; its field
*formats* are not documented anywhere we are allowed to read, so a format rule
would be invention — and an invented rule that is stricter than the Gateway's
blocks a credential that would have worked, which is worse than the round trip
it saves. A path is also resolved by the Gateway's process, not ours, so
`existsSync` here would be checking the wrong filesystem in any remote or
container setup. The Gateway's own rejection message, shown verbatim, is the
feedback.

## The Sources row in the context panel

A fifth `SignalId`, `"connectors"`, titled **Sources**, shown **only when at
least one connector is in `error` or `backoff`**. A connector that is `paused`
or `enabled: false` is a state the user chose, so it raises no row here — it is
visible in the Connectors view, which is where a deliberate choice belongs:

> **Sources** — `github` sync failing · last ok 3d ago

The row's command opens the Connectors view. `signals.ts` is already data-driven
("adding a fifth signal is one entry rather than an edit in four files"), so
this is one catalog-shaped entry plus a collector.

**It makes no Gateway call.** The collector reads the summary the existing
status-bar poll already produced, injected as a `() => ConnectorHealthSummary`
getter. So `ContextClientLike` gains **no** third method, the panel's RPC count
per tick is unchanged, and the "unhealthy" rule cannot drift from the status
bar's, because it is `summarizeConnectorHealth` — the same function, not a
second copy of the same predicate. Its existing rule (`enabled &&
(error || backoff)`) is already exactly the one this design wants: a `paused`
or disabled connector is a state the user chose and raises no row.

Two things it changes:

**1. Sections must be able to render nothing.** `renderSections` today emits a
`<section>` for every section, falling back to `section.empty` (or
`"Nothing to show."`) when there are no rows. A healthy setup must show *no
Sources heading at all* — an always-present "All sources healthy" line is noise
on the majority of ticks, the same judgement that already omits the git row on a
clean tree. `SignalSection` gains an optional `suppressWhenEmpty?: true`, and
`renderSections` filters those sections when `rows` is empty. Renderer-side, so
it is testable purely and no controller state changes.

**2. It is the panel's first global signal.** Every existing signal varies with
the file; this one does not. It is a **local** collector in the controller's
sense — the same class as `problems` and `git`, riding the first render with no
round trip — because the value it reads is already in memory. No cache key, no
TTL, no in-flight coalescing needed. Collection still stops entirely when the
view is hidden or `nimbus.context.enabled` is off.

Nothing in `src/context/` names a `connector*` RPC, so the choke-point test is
untouched and the panel's Gateway surface stays exactly the two model-free
calls it has today.

## Edits outside `src/connectors/`

| File | Edit |
| --- | --- |
| `src/vscode-shim.ts` | `showInputBox` gains `password?: boolean` and `ignoreFocusOut?: boolean`. **The shim declares neither today** — without this the masked prompt is not expressible. |
| `src/status-bar/connector-health.ts` | **Moved** to `src/connectors/health.ts`, body unchanged; `src/extension.ts` and `test/unit/connector-health.test.ts` update their import path. Three consumers now, so it stops living inside one of them. |
| `src/context/signals.ts` | `SignalId` gains `"connectors"`; `SECTION_TITLES` gains `Sources`; `SignalDeps` gains a `connectorHealth: () => ConnectorHealthSummary` getter; the collector. No new client method. |
| `src/context/webview/render.ts` | `suppressWhenEmpty` filtering. |
| `src/extension.ts` | Register the view, the nine commands, and the config-changed subscription (bound beside the HITL subscription so a reconnect re-binds it); keep the last statuses from the existing `pollConnectorHealth` and refresh the view when the degraded summary changes; pass the summary getter to the context panel. |
| `package.json` | One view, nine commands, `view/title` refresh, `view/item/context` menus keyed on the three `contextValue`s. |
| `docs/` | `docs/connectors.md` (what the surface does, the catalog's drift risk, why built-in onboarding is absent); `docs/architecture.md` and `CLAUDE.md` gain the surface; `docs/ROADMAP.md` moves both rows to *Already shipped*. |

No new setting. `nimbus.context.enabled` already governs the Sources row, and a
second toggle for one conditional row is a setting nobody would find. This keeps
`check-settings-docs` untouched.

No new bundle, no new media file: the view is a tree, so `check-vsix-contents`
and `check-bundle` are unaffected.

## Degraded states

| State | Behaviour |
| --- | --- |
| Disconnected | `connectionPlaceholder` handles it, as for every other view — empty tree, so the `viewsWelcome` Start Gateway / Troubleshoot buttons still render |
| `connectorListStatus` throws | `errorRow("Failed to load connectors", err)` |
| Zero connectors | `No connectors registered` + *Add MCP connector* |
| Health history on an `mcp_*` id | group omitted; telemetry still shown |
| Gateway without the connector RPCs | the call rejects "Method not found"; the error row shows it verbatim rather than asserting the user's Gateway is broken |
| Consent denied, or the request expired unanswered | both arrive as `GatedRejection`; `denied` wording showing the Gateway's `reason` verbatim, so the two do not read alike. The row is refreshed anyway — Gateway state is unchanged, but the view may be stale for other reasons |
| Gateway dies while a consent-gated call is blocked | the transport rejects, so the outcome is `failed`, not `denied`: we do not know what the owner would have answered, and reporting a decision nobody made is worse than reporting a lost connection |

## Testing

Unit (`test/unit/`), all pure except where noted:

- **`outcome.ts`** — every one of the four wire shapes maps to the right
  variant, and `denied` never renders as an error string. This is the test that
  earns the adapter.
- **`rows.ts`** — icon per status, `enabled: false` overriding, `never synced`
  for a null `lastSyncAt`, severity-then-id sort, the three `contextValue`s.
- **`catalog.ts`** — known provider yields its fields in order; unknown
  `serviceId` yields the generic descriptor.
- **`connector-client.ts`** — `mcp_*` ids skip `connectorHealthHistory`;
  `setConfig` reports only requested fields.
- **secret hygiene** — a fake logger sees nothing from an auth flow whose field
  values are distinctive sentinels. Asserted on the sentinel, so a redacted
  preview fails it too.
- **context panel** — `suppressWhenEmpty` renders nothing for a zero-row
  section and still renders `empty` text for sections without the flag; the
  Sources collector emits rows only for unhealthy connectors, and makes no
  Gateway call (asserted against a client stub that throws if touched).
- **`health.ts`** — the existing `connector-health.test.ts` keeps passing at
  its new import path, unmodified otherwise. If that file needs an assertion
  changed, the move was not a move.
- **`commands.ts`** — over stubbed shim deps: remove confirms before calling,
  a cancelled confirmation calls nothing, the HITL progress is created
  non-cancellable, and `withProgress` is invoked with the reporter first.
- **concurrency** — a second invocation of the same `serviceId:command` while
  the first is in flight issues no RPC, and the key is released on both the
  resolve and the reject path (a guard that leaks on failure would wedge the
  command until reload); a `syncing` row carries the `.syncing` `contextValue`,
  and Pause and Remove are still offered on it.
- **debounce** — a burst of `configChanged` notifications produces one refresh,
  asserted on a fake clock the way the panel's existing debounce tests are.
- **credential validation** — a blank required field is rejected before any
  call; a value with surrounding whitespace is trimmed; no format rule fires on
  a syntactically odd `apiBaseUrl`.
- **error text is never logged** — a fake logger sees nothing after a load
  whose `lastError` and telemetry `errorMsg` carry sentinels, while the rows
  built from that same load still contain them verbatim.

Guards that must stay green **unmodified**: `egress-choke-point.test.ts`,
`check-settings-docs`, `check-bundle`, `check-vsix-contents`.

## Verification

The unit suite cannot prove this works — it proves the pure core is right. The
believable pass is the Extension Development Host one, per the
`verify-extension` skill, against a live Gateway with **at least one healthy
connector, one deliberately broken one, and one `mcp_*` connector**, covering:

1. rows, icons and relative times against the CLI's own connector status;
2. expand → telemetry and health history; expand on the MCP id → no history
   group, no error;
3. pause → resume → the config-changed notification refreshing the view;
4. sync, and full re-sync from its confirmation;
5. re-index at `metadata_only`, then at `full` — approve once, **deny once**,
   and confirm the denial reads as a decision and the rejection path is taken;
6. add MCP connector and remove, each approved once and denied once — the
   resolve-with-rejection path;
7. an auth flow against a PAT provider, plus one unknown `serviceId` through
   the generic flow;
8. the Sources row appearing in the context panel when a connector breaks and
   **disappearing entirely** when it recovers;
9. a Gateway restart mid-surface, to confirm nothing captured a stale client;
10. a consent request **left unanswered** until the Gateway's own timeout — the
    one claim here that rests on a JSDoc sentence rather than on observed
    behaviour. It must settle without an extension-side timer, and its `reason`
    must read differently from an active denial. If it never settles, this
    design is wrong and a defensive timeout goes back on the table;
11. **Sync now** on a connector that is already `syncing`, to confirm the menu
    omits it, and a double-click on **Sync now** elsewhere, to confirm one RPC.

Findings are written up as a dated file in `docs/superpowers/plans/`, the way
the context panel's pass was. **A defect found there is fixed on this branch
before the PR is claimed done.**

## Delivery

One worktree, `worktree-connector-management`, staged as reviewable commits:

1. `feat(connectors): read-only Connectors view with health and telemetry`
2. `feat(connectors): safe mutations behind one outcome adapter`
3. `feat(connectors): credentials, add-MCP and remove, with their consent paths`
4. `feat(context): show unhealthy sources in the context panel`
5. `docs: record the connector surface`

Steps 1–3 each land their own tests. Step 4 is the only one touching
`src/context/`, so a regression there is bisectable to one commit.

## Open questions

1. **Sort stability.** Severity-first sort means a row moves when a connector
   recovers mid-view. Accepted: a health surface should reorder. Revisit if the
   F5 pass finds it disorienting.
2. **Interval entry.** `setConfig` takes milliseconds and the Gateway enforces a
   60s minimum. The prompt should take a human interval (`15m`, `2h`) and
   validate against that minimum client-side, so the rejection is not the first
   feedback. Parsing lives in its own tiny pure module.
3. **`connectorSetInterval` is redundant** with `setConfig`. The design uses
   `setConfig` only; the adapter still wraps `setInterval` so the seam covers
   the suite, but no command calls it. If that proves pointless, drop it.
