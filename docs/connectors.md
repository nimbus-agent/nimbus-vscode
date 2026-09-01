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

`nimbus.connectorsView` is the eighth and newest of the Nimbus activity-bar
container's views. In the manifest it sits sixth, directly after Index: "what is
indexed" then "where it comes from" — the eight views are Context, Audit,
Egress, Agents, Index, Connectors, Sessions, Workflows, in that order.
Rows come from `connectorListStatus()` and sort **unhealthy first** — `error`,
then `backoff`, `paused`, `syncing`, `ok`, then everything unconfigured, ties
broken by `serviceId` — so a health surface puts the connector that needs
attention on top rather than burying it alphabetically. A disabled connector
(`enabled: false`) always shows a slashed-circle icon and reads *disabled*
regardless of its underlying `status`.

### `connectorListStatus` returns every service, not just yours

This is the single most surprising thing about the payload, and the extension
was blind to it until an F5 pass against a real Gateway 7.1.0 on 2026-09-01:
**`connectorListStatus` returns every service the Gateway knows about**, not
the ones you set up. That install returned **97 rows**, of which 74 had never
been configured.

An unconfigured row does not look unconfigured. It reports `status: "ok"`, a
`lastSyncAt` a few minutes old — the scheduler ticking over a connector with
nothing to do — and `itemCount: 0`. Rendered off `status` alone it drew a green
tick that was byte-identical to `github`, which was genuinely syncing 336
items. The distinction lives in **`healthState`**, which carries
`"healthy" | "error" | "not_configured"` and which nothing in this repo read
before that pass. `nimbus doctor` has always shown the same split
(`[ok] healthy`, `[warn] not_configured`, `[fail] error`), so the CLI and this
view were disagreeing about the same field.

Today `isUnconfigured()` in `rows.ts` keys on it. Such rows are **hidden by
default** (`nimbus.connectors.showUnconfigured`, default `false`), because none
of them can be acted on from the editor anyway — registering a built-in
connector is a CLI job, see *Built-in connector onboarding is absent* below.
Turned on, they sort below every configured row and are labelled
`not configured` with a hollow icon, and their sync date is dropped rather than
dating a sync that never happened. `healthState` is typed `?: string` in the
client, so an **absent** value must keep a row rendering exactly as it did —
never treat a missing field as evidence of anything.

Note what `healthState` does *not* solve: it reports `"error"` both for `gmail`
(299 indexed items, a token that expired) and for `bigeye` (never set up, "no
server spawned"). Telling those apart needs a different question — see *Sources
row in the context panel*.

**And this view deliberately does not ask it.** A never-configured connector
reporting `error` still appears here, at the top, in red — on the real install
that was ten of the first twelve rows. The Sources row in the context panel
suppresses exactly those, and the asymmetry is the point: the ambient panel
interrupts you while you are doing something else, so it should only speak up
about data that *was* flowing and stopped. This view is where you come
deliberately to fix a connector, and the case it must never hide is the one
that looks identical to a never-configured one — a connector you just set up
whose credentials are failing, which has no successful sync and no items
either. Filtering on `hasEverWorked` here would hide precisely the row someone
opened the view to find.

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
| rejects with an IPC timeout | the three gated calls **only** | `unreachable` — see *Consent that never arrives* |
| the user cancels the wait | the three gated calls **only** | `abandoned` |

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

`connectorAddMcp` and `connectorRemove` are the two HITL-gated calls (a
full-depth `connectorReindex` is the third): the returned promise does not
settle until the owner answers the consent request the Gateway raises. **The
extension adds no timeout of its own.** None of the connector methods accepts
a `timeoutMs` (unlike the `agents*` family, which all do), so the wait is
bounded by the Gateway and the client's transport alone. A defensive
extension-side timer would be actively wrong: it would close the notification
and report a timeout while the Gateway call is still live, so a consent
answered a minute later would land against a UI that had already told the user
it hadn't.

The progress notification **is** cancellable, which is a different thing from a
timeout. Cancelling abandons the *wait*, not the request: there is no cancel
RPC, so the Gateway's consent request stays open and the change still applies
if it is answered elsewhere. The `abandoned` wording says exactly that instead
of implying the action was called off.

### Consent that never arrives

Against **Gateway 7.1.0 with `@nimbus-dev/client` 0.17.0, the consent request
never reaches the editor at all**, so none of the three gated calls can be
approved or denied from VS Code. Established on the wire during the F5 pass of
2026-09-01:

- The Gateway emits the consent request as a `consent.request` notification.
- The client's `subscribeHitl` registers its handler on `agent.hitlBatch`.
- `agent.hitlBatch` does not appear **anywhere** in the Gateway 7.1.0 binary;
  `consent.request` appears four times.

The payload shape is otherwise exactly what `subscribeHitl` validates
(`{requestId, prompt, details}`) — it is purely the method name. The respond
side is fine: the client sends `consent.respond`, which is what the Gateway
expects. `src/extension.ts` has exactly one HITL wiring point
(`c.subscribeHitl(...)` → `hitlRouter.handle`), so this silences the modal, the
toast and the details webview for **every** gated action, not only connectors.

What the user saw before this was handled: the progress notification sat there
until the client's `requestTimeoutMs` elapsed, then reported
`failed: IPC request timed out after 30000ms` — which reads as a broken
Gateway. The Gateway meanwhile logged the request as
`rejected — client disconnected`.

`fromThrownGated` now maps that timeout to `unreachable` and says what is true:
the approval request never reached the editor, and it can be answered with the
Nimbus CLI. This is deliberately kept **out of `fromThrown`** — on the nine
ungated calls a timeout means exactly what it says, and reading consent into it
there would be an invention. A genuine denial is still checked first, because
an expired consent request arrives with "timed out" in its text and that *is*
an answer.

**This is an upstream client bug, not something this repo can fix** — the
non-negotiable is that the extension never reaches past the typed client, and
`subscribeHitl` is the client's. It resolves when a published
`@nimbus-dev/client` listens on the notification the Gateway actually sends.

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
shown only when at least one connector is in `error` or `backoff` **and was
working before** — a connector the user deliberately paused or disabled raises
no row here, since that is a state the user chose, and it is already visible in
the Connectors view. The row names the failing connector and when it last
synced successfully.

The "was working before" half was added after the F5 pass of 2026-09-01 found
this row permanently on and mostly noise. On a real install it named **12**
connectors, of which seven — `bigeye`, `looker`, `montecarlo`, `powerbi`,
`snowflake`, `tableau`, `google_meet` — reported `status: "error"` only because
they had never been set up ("connector-session: no server spawned for service
X"). A conditional signal that never turns off is the exact outcome
`suppressWhenEmpty` exists to prevent.

`healthState` cannot make this distinction: it reads `"error"` for `gmail` and
`bigeye` alike. What does is `hasEverWorked()` — `lastSyncAt !== null ||
itemCount > 0`. A connector that has never completed a sync and holds nothing
in the index has nothing to have degraded *from*; `bigeye`'s error means "you
never set me up", while `gmail`'s means "your 299 indexed emails are going
stale", and only the second is worth interrupting someone about. Item count
alone is sufficient evidence — items are proof it once worked, whatever the
sync cursor currently says. On that same install the row went from 12 names to
two: `gmail` and `google_drive`. It is informational only: `SignalRow` has no `command` field and
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
