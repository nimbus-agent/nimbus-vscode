# Connectors

The **Connectors** view (`nimbus.connectorsView`, `src/connectors/`) is the
in-editor counterpart to `nimbus connector status` on the CLI: one row per
connector the Gateway already knows about, with the health detail the
status-bar badge only summarizes, and the day-to-day mutations (sync, pause,
re-index, remove) that today mean leaving the editor. It reaches no model —
every RPC it calls is one of the twelve `connector*` methods, none of which
takes a prompt or returns a completion — so it sits outside the "Preview what
leaves" pre-flight gate exactly as `searchRanked` and the blame hover do.

## The view

`nimbus.connectorsView` is the eighth view in the Nimbus activity-bar
container, placed after Index: "what is indexed" then "where it comes from".
Rows come from `connectorListStatus()` and sort **unhealthy first** — `error`,
then `backoff`, `paused`, `syncing`, `ok`, ties broken by `serviceId` — so a
health surface puts the connector that needs attention on top rather than
burying it alphabetically. A disabled connector (`enabled: false`) always
shows a slashed-circle icon and reads *disabled* regardless of its underlying
`status`.

Each row's description is its sync telemetry at a glance —
`1,204 items · synced 3m ago`, or `never synced` when `lastSyncAt` is `null`
rather than a nonsensical "56 years ago". The tooltip carries depth, interval,
next-sync time, consecutive-failure count and, when present, the connector's
`lastError` — shown **verbatim**. That error can carry a host, a path, a
username or a connection-string fragment, and that is exactly what makes it
actionable: a redacted "connection failed" would leave the user exactly where
they started. This is the user's own information about their own connector,
displayed to them alone, which is why the pre-flight gate's path-redaction
rule does not apply here — that rule exists because a gated payload *leaves
the machine*, and nothing in this view does. The one rule that follows is that
this text is never written to the output channel: the log is the artifact
people paste into issues and screenshots, so the copy that could travel is the
copy this view does not create.

Expanding a row fetches two groups, on expand rather than eagerly — the same
`loadChildren` pattern the Workflows view established, because eager children
would cost one RPC per connector on every open:

- **Recent syncs** — `connectorStatus({serviceId, includeStats: true})`, up to
  the 15 telemetry rows the Gateway returns: started-at, duration, items
  upserted/deleted, and the sync's own `errorMsg` when one failed.
- **Health history** — `connectorHealthHistory({service, limit})`, rendered as
  `from → to · reason`.

`connectorHealthHistory` accepts **built-in connector ids only** — the pinned
client says so, and the Gateway rejects a user-defined MCP id. For a
`serviceId` matching `mcp_*` the extension skips the call rather than making
it and showing the rejection: an `mcp_*` row's expansion renders the telemetry
group and simply omits the health-history group.

An empty result renders a single `No connectors registered` row plus an *Add
MCP connector* row — see *Built-in onboarding is absent*, below.

### Liveness

The view starts no timer of its own. `extension.ts` already polls
`connectorListStatus` on `nimbus.statusBarPollMs` to feed the status-bar badge
(`summarizeConnectorHealth`, `src/connectors/health.ts`), and the Connectors
view hangs off that same poll rather than starting a second one — doubling the
traffic to say the same thing would buy nothing. On top of that shared poll,
the view also refreshes on: `subscribeConnectorConfigChanged` (debounced, so a
burst of notifications from one multi-field `setConfig` costs one refresh, not
one per notification), any mutation this extension itself issues, a
connection-state change, and the `view/title` refresh command.

## Row commands

Ten commands, all palette-visible; nine of them routed through the one
adapter, `src/connectors/connector-client.ts` — Refresh Connectors is the
exception, since it makes no RPC of its own and simply re-reads the last poll
or re-fetches. A command run from the palette — or from a keybinding, or
another extension's `executeCommand` — carries no row, so each one falls back
to a `QuickPick` over `connectorListStatus()` rather than silently doing
nothing.

| Command | RPC | Confirmation |
| --- | --- | --- |
| Sync now | `connectorSync({serviceId})` | none |
| Full re-sync | `connectorSync({serviceId, full: true})` | modal — it clears the sync cursor |
| Pause / Resume | `connectorPause` / `connectorResume` | none |
| Configure | `connectorSetConfig` (interval, depth, or enabled — one field per call) | none |
| Re-index | `connectorReindex({service, depth})` | modal, only at `depth: "full"` |
| Authenticate | `connectorAuth` | none — the input boxes are the confirmation |
| Add MCP connector | `connectorAddMcp` | none — HITL consent is the confirmation |
| Remove | `connectorRemove` | modal, naming the connector's item count |
| Refresh Connectors | — (re-reads the last poll / re-fetches) | none |

Sync interval is entered as a human string (`15m`, `2h`), parsed and validated
client-side by `src/connectors/interval.ts` against the Gateway's 60-second
floor before the call, so a too-short interval is rejected in the input box
rather than by a round trip.

### Two concurrency guards

**The context menu**, keyed off each row's `contextValue`
(`nimbus.connector.active` / `.paused` / `.disabled` / `.syncing`): a
connector whose last-read status is `syncing` hides **Sync now**, **Full
re-sync** and **Re-index**, because asking for a sync mid-sync is redundant at
best. **Pause** and **Remove** stay available while syncing on purpose — a
runaway or wedged sync is exactly when a user reaches for Pause, and Remove
already confirms modally. This guard is best-effort by construction: it is
only as fresh as the last `connectorListStatus`, so a sync started elsewhere
can leave the menu briefly wrong.

**The command handler**, which is the guard that actually holds regardless of
row freshness: a `Set` of in-flight `serviceId:command` keys makes a
double-click, or a click on a stale menu, a no-op rather than a second RPC.
The key is released on both the resolve and the reject path, so a failure
cannot wedge a connector's commands until the window reloads.

## One outcome type for four wire shapes

The connector RPC suite reports failure four different ways, and two of them
mean *denied* rather than *broken* — the entire reason
`src/connectors/connector-client.ts` and `outcome.ts` exist:

| Wire shape | Calls | Normalised to |
| --- | --- | --- |
| resolves `{ok: false}` | pause, resume, sync, setConfig | `failed` |
| resolves `{status: "rejected", reason}` (never throws) | addMcp, remove | `denied` |
| **rejects** on denial | reindex at `depth: "full"` | `denied`, distinguished from a genuine error by inspecting the rejection message |
| rejects | any of them, on a real fault | `failed` |

`denied` is worded as a decision, never as a breakage — *"Removing github was
not approved."* A denial is the consent system working, and collapsing it
into an error message is the specific bug this adapter exists to prevent.

**A consent denial and a consent request that simply expired unanswered
arrive as the exact same shape.** The extension has no way to tell "someone
clicked Deny" apart from "nobody answered in time" — both are a
`GatedRejection` with a `reason` string — so the wording never claims a person
declined. It shows the Gateway's own `reason` **verbatim**, which is what lets
the two actually read differently to the user (an expiry message from the
Gateway does not say the same thing an active rejection does).

`connectorAddMcp` and `connectorRemove` are the two HITL-gated calls: the
returned promise does not settle until the owner answers the consent request
the Gateway raises, and there is no cancel — it is a genuine wait, shown as a
non-cancellable progress notification ("Waiting for your consent…"). **The
extension adds no timeout of its own.** None of the connector methods accepts
a `timeoutMs` (unlike the `agents*` family, which all do), so the wait is
bounded by the Gateway alone. A defensive extension-side timer here would be
actively wrong: it would close the notification and report a timeout while
the Gateway call is still live, so a consent answered a minute later would
land against a UI that had already told the user it hadn't. The only two
states that exist are "still waiting" and "the Gateway settled it."

## Credentials

Authenticate collects credentials as one masked `showInputBox` per field
(`secret` fields set `password: true`; every field sets `ignoreFocusOut: true`
so a stray click does not discard a half-typed value), then passes them
straight to `connectorAuth({serviceId, ...fields})`. **The extension never
stores, caches or logs a credential value** — not the value, not its length,
not a redacted preview. Only field *names* are logged (never values), and
auth payloads never appear in `Show Last Outbound Payload`, which is a gate
artifact and this call is not gated. `test/unit/connectors-commands.test.ts`
asserts this with a sentinel value: a fake logger must see nothing derived
from it, so a redacted preview would fail the assertion too, not just a raw
value. Values are trimmed; a blank `required` field is rejected in the input
box before any call is made. The Gateway's own Vault owns the secret — that is
the point of writing it through `connectorAuth` rather than into a VS Code
setting.

`src/connectors/catalog.ts` maps a known `serviceId` to its ordered field
list — `github`, `gitlab`, `bitbucket` (a PAT-style token), `jira` /
`confluence` (Atlassian email, site URL, API token), `azure` (tenant id plus
access token), `gcp` (a credentials JSON path), `slack` (a token), and
`google_drive` (an empty field list — an OAuth provider, where
`connectorAuth({serviceId})` alone is enough and the Gateway opens a browser
and listens on a local port). An unrecognised `serviceId` falls back to the
**generic flow**: one masked credential prompt named simply "Credential" (wire
name `token`), followed by an **add-another-field loop** — after that prompt,
Authenticate keeps asking "Add another field to send?" for a field name, then
its value (masked), for as long as the user keeps naming fields. Dismissing
the name prompt (not submitting it blank — that is rejected and re-prompts)
ends the loop and sends what was collected so far; cancelling a *value* prompt
abandons the whole flow, the same rule every other field in this command
follows. This loop is offered only when the catalog has no entry for the
`serviceId` at all — a known provider's fixed field list is never followed by
it.

**This catalog will drift, and that is expected, not a bug to eliminate.**
Its field names come from exactly one source: the pinned `@nimbus-dev/client`
package's JSDoc for `ConnectorAuthParams`. This extension may not read the
Gateway's own `auth.ts` handler — the IPC-only non-negotiable forbids reaching
past the typed client — so the catalog is seeded from what the client's
comments say and nothing else. When the Gateway adds a provider, renames a
field, or changes what it requires, this catalog goes stale until someone
updates it by hand. The generic fallback above is the deliberate escape
hatch: between the initial "Credential" prompt and the add-another-field
loop, it can send any field the Gateway wants, under any name, even for a
`serviceId` the catalog has never heard of.

**AWS is deliberately absent from the catalog for exactly this reason.** The
client's JSDoc names `awsAccessKeyId` but never documents its secret
counterpart. Rather than invent a field name for the secret half of a
credential pair, AWS uses the generic flow: the "Credential" prompt fills
`token`, and the add-another-field loop is where a user supplies
`awsAccessKeyId`, its secret counterpart, or anything else the Gateway asks
for by name — a prompt this extension is allowed to build, versus a field
name this extension is not allowed to guess.

Format validation is deliberately absent too: nothing here checks that
`apiBaseUrl` parses as a URL, or that `gcpCredentialsJsonPath` exists on disk
(disk existence would also be checked against the *wrong* filesystem in any
remote or containerized setup — the path is resolved by the Gateway's
process, not this one). The catalog's field *names* are sourced; their
*formats* are not documented anywhere this extension may read, so a format
rule would be an invention that could reject a credential the Gateway would
have accepted. The Gateway's own rejection message, shown verbatim, is the
feedback loop instead.

## Built-in connector onboarding is absent

There is no command to stand up a new Jira, GitHub, or Slack connector from
inside the editor, and that is not an oversight — **no RPC in the pinned
client registers one.** `connectorAddMcp` is the only registration path the
client exposes, and `connectorListStatus` returns only connectors the Gateway
already knows about. What this view can do is authenticate and configure a
connector the Gateway has already registered, and register a new **MCP**
source through *Add MCP connector*. Standing up a built-in connector for the
first time stays a CLI job (`nimbus connector add …`) until a Gateway RPC for
it ships in a future client release.

## Sources row in the context panel

The ambient context panel (`src/context/`) gains a fifth signal, **Sources**,
shown only when at least one connector is in `error` or `backoff` — a
connector the user deliberately paused or disabled raises no row here, since
that is a state the user chose, and it is already visible in the Connectors
view. The row names the failing connector and when it last synced
successfully. It is informational only: `SignalRow` has no `command` field and
no row in the context panel is clickable yet, so — unlike what an earlier
draft of the design spec claimed — this row does not open the Connectors view
by itself; opening it still means using the Connectors view directly until the
panel gains clickable rows.

This signal makes **no Gateway call of its own**: it reads the
`ConnectorHealthSummary` the existing status-bar poll already computed,
injected as a getter. The panel's Gateway-backed RPC count per tick is
unchanged, and the "unhealthy" rule cannot drift from the status bar's,
because it is the same `summarizeConnectorHealth` function — not a second
copy of the same predicate. A healthy setup shows no Sources heading at all
(`SignalSection.suppressWhenEmpty`), the same judgement that already omits the
context panel's git row on a clean working tree.

## What is not here yet

- **Onboarding a built-in connector** — see above; blocked on a Gateway RPC,
  not deferred by choice.
- **Editing a registered MCP connector's command line.** Add and remove are
  the only two MCP operations this view offers.
- **Showing an MCP connector's command line at all.** `commandLine` is an
  input to `connectorAddMcp` and appears in no status, result, or
  notification type the pinned client returns — there is nothing to render
  until a client release sends it back. See `docs/ROADMAP.md`, Phase 4.
- Health sparklines or charts, and any automatic mutation. Nothing in this
  surface syncs, re-indexes, or pauses without the user asking.
