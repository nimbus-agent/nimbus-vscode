# Egress surface — design

**Date:** 2026-07-14
**Status:** Implemented (see `feat/egress-surface`)
**Branch:** `feat/egress-surface`

## Summary

Build the **Egress** surface — an activity-bar sidebar view plus two commands —
now that `@nimbus-dev/client@0.4.0` exposes the egress-ledger RPCs. Until now the
egress surface was blocked upstream: no published client surfaced these RPCs
(CLAUDE.md, checked through `0.3.0`). `0.4.0` adds them, typed, on `NimbusClient`:

- `egressHead()` → `{ head, count }`
- `egressList({ since?, until?, limit? })` → `{ rows: EgressRow[] }`
- `egressVerify()` → `{ ok, verifiedRows, brokenAt?, reason? }` (offline BLAKE3-chain verify)
- `egressProveWindow({ since?, until?, sign? })` → `{ rows, completeness, verify, receipt? }`

The egress ledger is an append-only, BLAKE3-chained record of every gated
outbound action, written before it dispatches. This surface makes it visible,
verifiable, and provable from inside the editor.

This is the next step in the sidebar series after Audit (#9), Sessions (#6/#10),
Index (#5), and Agents (#3). It follows the same pure-view pattern over the
shared `tree-view.ts` seam.

## Goals

- Surface the egress ledger in a read-only sidebar view, newest-first, mirroring
  the Audit view (list rows; click a row → read-only JSON detail).
- Let the user **verify** the whole ledger's chain integrity from a command.
- Let the user **prove** what left the machine in a time window and save a
  signed (Ed25519) proof artifact to disk.
- Update the CLAUDE.md / architecture note that egress is "blocked upstream" —
  it is now shipped for **egress** (workflow / share remain blocked).

## Non-goals (YAGNI for v1)

- Custom date-range entry for prove-window (fixed presets only).
- A receipt *verification* UI (we produce a signed proof; verifying someone
  else's receipt is a separate surface).
- Streaming / pagination / "load more" beyond a single `limit`.
- Workflow and share surfaces (still blocked upstream — no client RPCs).
- **"Inspect Row" jump from a verify-failure toast** (review #1). Deferred: the
  client has no by-id lookup (`egressList` takes `{ since?, until?, limit? }`
  only), so it needs a full-ledger scan for `brokenAt`; verify-failure is a rare
  tamper state, and a lone row's `rowHash`/`prevHash` without neighbours has
  limited diagnostic value. Clean ~15-line follow-up if wanted.
- **Auto-refresh on view visibility** (review #4). Deferred: `onDidChangeVisibility`
  lives on a `TreeView` (`createTreeView`), but all four views register via
  `registerTreeDataProvider` (`extension.ts`). Adopting it is a cross-cutting
  change to the shared registration loop for every view — its own decision, not
  part of this feature. (Note: verify/prove are read-only and don't mutate the
  ledger, so no post-command refresh is warranted regardless.)

## Decisions (from brainstorm)

- **Full surface**: viewer + verify + prove-window (all four RPCs).
- **Prove UX**: preset Quick Pick (Last hour / Last 24 hours / Last 7 days /
  All time) → **always signed** → Save dialog writes the full proof JSON.
- Row **icon** keys off `resultStatus` (`authorized`→`pass`, `blocked`→`error`)
  — the security-relevant signal — with `hitlStatus` folded into the tooltip.
  Per the `0.4.0` client types, `resultStatus` is exactly `"authorized" |
  "blocked"` and `hitlStatus` is `"approved" | "not_required" | "rejected"` —
  there is **no** `pending`/`skipped` ledger state (pending *consent* is the
  separate pre-dispatch `subscribeHitl` surface, not a ledger row), so `dash`
  serves only as a defensive fallback for an unexpected value (review #3).
- Egress view sits **immediately after Audit** in the `nimbus` container (they
  are the compliance pair).

## Client bump

`package.json`: `@nimbus-dev/client` `^0.2.4` → `^0.4.0` (published; never
`workspace:*`, per non-negotiables). The dep is build/typecheck-time only —
esbuild inlines it — so `check-bundle` must still show `vscode` as the sole
external after the bump.

## Architecture / components

The view is a thin, pure `loadData` wrapper over the shared `createDataView`,
exactly like `audit-view.ts`. Command logic lives in `extension.ts`; all pure
helpers (parsing, item mapping, detail/proof formatting, preset→bounds) live in
`egress.ts` so they are unit-testable without vscode.

### `src/sidebar/egress.ts` (pure — no vscode types)

Mirrors `audit.ts`. Defensive parsing even though `0.4.0` types the rows, for
consistency with the other views and resilience to shape drift.

- `EgressRow` (interface, mirrors the client's `EgressRow`): `id`, `timestamp`,
  `sourceType`, `sourceId: string | null`, `destination`, `method`,
  `payloadSummary`, `hitlStatus: string`, `resultStatus: string`, `rowHash`,
  `prevHash`.
- `parseEgressRow(raw: unknown): EgressRow | undefined` — returns `undefined`
  when a row lacks the minimum to render (a `destination`/`method` and a numeric
  `timestamp`); coerces missing optionals to safe defaults.
- `egressRowToItem(row: EgressRow, now: number): SidebarItem`
  - `label`: `${destination}.${method}` (e.g. `gmail.send`) — the analogue of
    audit's `actionType`.
  - `description`: `formatRelativeTime(now, row.timestamp)`.
  - `iconId`: `iconForResult(row.resultStatus)` — `authorized`→`pass`,
    `blocked`→`error`, anything else→`dash`.
  - `tooltip`: `${destination}.${method} · ${resultStatus} · consent ${hitlStatus}`.
  - `command`: `{ command: "nimbus.openEgressEntry", title: "Open Egress Entry", arguments: [row] }`.
- `formatEgressDetail(raw: unknown): { title, content } | undefined` — re-parses
  defensively; `title` = `egress-${id}.json`; `content` = pretty JSON of the full
  row **including `rowHash`/`prevHash`** plus an added `timestampIso`.
- `egressWindowPresets(now: number)` → an ordered list of
  `{ label, since?, until? }`: Last hour (`since = now - 3_600_000`), Last 24
  hours (`- 86_400_000`), Last 7 days (`- 604_800_000`), All time (no bounds).
  `until` is left open (undefined) for all presets.
- `buildProofDocument(result, now): { filename, content }` — `filename` =
  `egress-proof-${now}.json` (epoch-ms suffix; deterministic, filesystem-safe);
  `content` = `JSON.stringify(result, null, 2)` (the `egressProveWindow` result
  verbatim: `rows`, `completeness`, `verify`, and `receipt`).

### `src/sidebar/egress-view.ts`

Mirrors `audit-view.ts`.

- `EgressClientLike { egressList(params?): Promise<{ rows: unknown[] }>` } — the
  minimal client slice; the real `NimbusClient` satisfies it, tests pass a fake.
- `createEgressView({ connection, getClient, limit?, now? }): SidebarView` via
  `createDataView`:
  - client `undefined` → not-connected row (click → `nimbus.reconnect`).
  - `egressList({ limit })` → `parseEgressRow` each → empty → "No egress entries
    yet"; else map through `egressRowToItem`.
  - throw → `errorRow("Failed to load the egress ledger", err)`.

## Commands (in `extension.ts`)

Registered alongside the existing `register(...)` calls; view created next to
`auditView` and added to the `sidebarViews` array as `["nimbus.egressView", egressView]`.

- **`nimbus.refreshEgress`** ("Refresh Egress", `$(refresh)` icon) — title-bar
  button; `egressView.refresh()`. Mirrors `nimbus.refreshAudit`.
- **`nimbus.openEgressEntry`** (hidden from palette) — `formatEgressDetail(args[0])`
  → `openReadonlyJson(detail.title, detail.content)`. Mirrors `nimbus.openAuditEntry`.
- **`nimbus.verifyEgress`** ("Verify Egress Ledger"):
  - client `undefined` → `showWarningMessage("Nimbus: not connected to the Gateway.")`.
  - `await egressVerify()`; `ok` → `showInformationMessage("Egress ledger intact — ${verifiedRows} rows verified.")`.
  - `!ok` → `showErrorMessage("Egress chain broke at row ${brokenAt}${reason ? ": " + reason : ""}.")`.
  - throw → `showErrorMessage("Nimbus: egress verify failed: ${message}")` + `log.warn`.
- **`nimbus.proveEgressWindow`** ("Prove Egress Window"):
  1. client `undefined` → warning (as above).
  2. `showQuickPick(egressWindowPresets(Date.now()).map(p => p.label))`; cancel → return.
  3. `await egressProveWindow({ since, until, sign: true })` for the chosen preset
     (omit `since`/`until` when the preset leaves them open — respect
     `exactOptionalPropertyTypes`, build the params object incrementally).
  4. `buildProofDocument(result, Date.now())` → `const saved = await saveJson(filename, content)`.
  5. On a saved URI, `showInformationMessage("Egress proof saved.", "Open File")`;
     if the user clicks "Open File", `window.showTextDocument(await
     workspace.openTextDocument(saved))`. Cancelled save (`undefined`) → no-op,
     no toast (review #2).
  6. throw → `showErrorMessage(...)` + `log.warn`.

### `saveJson` opener seam

A new injected opener alongside `openReadonlyJson`, defaulting (like
`createReadonlyJsonOpener`) to a factory in `extension.ts`:

- `saveJson(defaultName: string, content: string): Promise<Uri | undefined>` —
  `window.showSaveDialog({ defaultUri: <workspace or home>/defaultName, filters: { JSON: ["json"] } })`;
  on a chosen URI, `workspace.fs.writeFile(uri, <utf8 bytes>)` then **return the
  URI**; cancel → return `undefined` (no write). Returning the URI lets the
  command show the success toast + "Open File" action (review #2). Overwrite of
  an existing same-named file is handled natively by `showSaveDialog` (review #5).

The pure filename/content generation is in `buildProofDocument` (tested); the
seam itself is thin glue exercised via the vscode stub.

## `package.json` changes

- `contributes.commands`: add `nimbus.refreshEgress` (with `$(refresh)` icon),
  `nimbus.openEgressEntry`, `nimbus.verifyEgress`, `nimbus.proveEgressWindow`,
  all `"category": "Nimbus"`.
- `contributes.views.nimbus`: add `{ "id": "nimbus.egressView", "name": "Egress" }`
  immediately after `nimbus.auditView`.
- `contributes.menus.view/title`: `nimbus.refreshEgress`, `nimbus.verifyEgress`,
  `nimbus.proveEgressWindow` gated on `view == nimbus.egressView`,
  `group: navigation` (refresh) / an overflow group for verify+prove.
- `contributes.menus.commandPalette`: hide `nimbus.openEgressEntry` (`when: false`).
- Bump `@nimbus-dev/client` to `^0.4.0`.

## Data flow

```text
egressView.getChildren()
  → connectionPlaceholder | loadData()
      → getClient().egressList({ limit })
      → parseEgressRow[] → egressRowToItem[]  → TreeItems

row click → nimbus.openEgressEntry(row)
  → formatEgressDetail → openReadonlyJson (read-only editor tab)

title-bar Verify → nimbus.verifyEgress
  → egressVerify() → info | error toast

title-bar Prove → nimbus.proveEgressWindow
  → preset Quick Pick → egressProveWindow({since, sign:true})
  → buildProofDocument → saveJson → workspace.fs.writeFile
```

## Error handling

Every Gateway call is wrapped: disconnected → a warning/placeholder, not a throw;
RPC throw → an `errorRow` (view) or an error toast + `log.warn` (commands). No
`console` (Biome `noConsole`); log through `logging.ts`. No `any` — rows arrive
as `unknown` and are parsed. Respect `exactOptionalPropertyTypes` when building
the `egressProveWindow` params and any `SidebarItem`.

## Testing

Vitest, `vscode` aliased to the stub. Mirrors `audit.test.ts` / `audit-view.test.ts`.

- `test/unit/egress.test.ts`:
  - `parseEgressRow`: valid row; missing `destination`/`method`/`timestamp` →
    `undefined`; `sourceId: null` preserved; optional coercions.
  - `egressRowToItem`: label `destination.method`; icon per `resultStatus`
    (authorized/blocked/other); relative-time description; tooltip content.
  - `formatEgressDetail`: title, `timestampIso`, `rowHash`/`prevHash` present;
    invalid input → `undefined`.
  - `egressWindowPresets`: preset bounds relative to a fixed `now`; All time has
    no `since`/`until`.
  - `buildProofDocument`: filename shape; content round-trips the result.
- `test/unit/egress-view.test.ts`: not-connected row, empty → "No egress entries
  yet", `egressList` throw → error row, happy path via a fake `EgressClientLike`.
- Extension command coverage (extend existing `extension.test.ts` style):
  `verifyEgress` ok / broken / disconnected / throw; `proveEgressWindow`
  disconnected / **cancelled Quick Pick** (no `egressProveWindow` call) /
  **cancelled save dialog** (`saveJson`→`undefined`: no toast, no throw) /
  saved (assert `writeFile` called with the built filename+content, then the
  success toast; and "Open File" opens the saved URI) — review #5.
- `test/unit/vscode-stub.ts`: add `showSaveDialog`, `workspace.fs.writeFile`,
  and (for the "Open File" action) `workspace.openTextDocument` /
  `window.showTextDocument` stubs (and `showQuickPick` if not already present).

## Verification

`bun run typecheck && bun run lint && bun run test && bun run build && bun run
check-bundle` (the last asserts `vscode` remains the only bundle external after
the client bump). Coverage should stay at the current ~95%.

## Docs to update

- `CLAUDE.md` — the "Surface today" / blocked-upstream paragraph: egress is now
  implemented; workflow/share remain blocked.
- `docs/architecture.md` — add the Egress view + verify/prove commands to the
  surface list.
