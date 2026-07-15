# Ranked Search — design

**Date:** 2026-07-15
**Status:** Approved (brainstorm + review feedback rounds 1–2), pending implementation plan
**Branch:** `feat/ranked-search`

## Summary

Make the **Search** surface actually search the local Nimbus index, as a live,
type-to-search experience. Today `nimbus.search` ignores the user's query: it
fetches 50 arbitrary recent items via `queryItems({ limit: 50 })` and relies on
VS Code's Quick Pick to fuzzy-filter *those 50* client-side. The typed query
never reaches the Gateway.

`@nimbus-dev/client@0.4.0` exposes `searchRanked(params?)`, a real
semantic+keyword index search. This design rebuilds Search on top of it using a
single `window.createQuickPick()` surface that re-queries the Gateway (debounced)
as the user types, fixes **Search Selection** (which currently re-prompts and
drops the selection), and gives results a purpose: selecting one **opens the
item** through the Index view's existing `openSource` seam.

No client bump is required — `searchRanked` is already in the pinned `^0.4.0`.

## Goals / non-goals

**Goals**
- Live search: each debounced keystroke runs `searchRanked({ name })` on the
  Gateway and updates the result list — no disjoint input-box → popup hop, and no
  stale client-side filtering of a pre-fetched set.
- Results shown in the Gateway's relevance order (semantic + keyword).
- **Search Selection** seeds the search box with the (normalized, truncated)
  selected text.
- Selecting a result opens it (external URL or in-editor file) via `openSource`;
  a result with no source URL is clearly marked and gives explicit feedback
  rather than silently doing nothing.

**Non-goals (YAGNI for v1; future work)**
- `service` / `itemType` filter pickers.
- A semantic on/off toggle (`semantic` defaults to `true` on the Gateway).
- `contextChunks` tuning.
- Multi-action result rows (Open + Ask buttons). v1 opens on accept.
- **Duplicate badges** (review #9): `RankedSearchItem.duplicates` could show a
  `+N duplicates` hint, but it is enrichment, not core to search working — deferred.
- **Configurable result limit** (review #10): a `nimbus.search.limit` setting.
  `SEARCH_LIMIT = 50` is a sensible *picker* cap (the Gateway's 500 ceiling is far
  more than a QuickPick should list); a knob can follow if users ask.

## Global constraints

Same non-negotiables as the rest of `src/`:
- TypeScript **strict**; **no `any`** (external data is `unknown`, then parsed).
- **No `console`** in `src/` — log via `logging.ts` (`log.error`, `errMsg`).
- `tsconfig` has **`exactOptionalPropertyTypes`** — never assign `undefined` to
  an optional field; build objects incrementally / conditional-spread.
- The `vscode` API is touched only through `vscode-shim.ts` interfaces or an
  injected seam — never imported into `src/search.ts` or the tests.
- `bun run check-bundle` must still show **`vscode` as the sole bundle external**.
- Coverage stays at ledger parity (~current levels).
- Import paths use the `.js` extension (NodeNext), even for `.ts` sources.

Verification gate (every task's final step and the whole feature):
`bun run typecheck && bun run lint && bun run test && bun run build && bun run check-bundle`

## Relevant client surface (0.4.0)

```ts
searchRanked(params?: RankedSearchParams): Promise<RankedSearchItem[]>;

type RankedSearchParams = {
  name?: string;        // free-text query; empty → top-ranked items
  service?: string;     // (unused in v1)
  itemType?: string;    // (unused in v1)
  limit?: number;       // Gateway clamps 1..500; default 20
  semantic?: boolean;   // defaults true on the Gateway (unused in v1)
  contextChunks?: number;
};

type RankedSearchItem = NimbusItem & {
  score: number;
  indexPrimaryKey: string;
  indexedType: string;
  canonicalUrl?: string;
  duplicates?: readonly string[];
  semanticSnippet?: string;
  bm25Rank?: number | null;
  vectorRank?: number | null;
};
// NimbusItem carries: name, service, url, itemType, id, … (mirrored, not imported).
```

`MockClient` supports a `rankedItems` fixture and implements `searchRanked`, so
tests need no bespoke fake for the client.

## Load-bearing VS Code constraint (review #1/#2)

`window.createQuickPick()` **always** applies built-in fuzzy filtering of its
items against the typed value (matching `label`, plus `description`/`detail` when
`matchOnDescription`/`matchOnDetail` are set). There is **no** public toggle to
disable it (`QuickPick` has no `matchOnLabel`/`sortByLabel`/`filterText`).

For a *semantic* search this would hide good results whose label does not contain
the query substring. The supported escape hatch is per item:
**`QuickPickItem.alwaysShow = true`** forces VS Code to display the item
regardless of the filter. Every result pick therefore sets `alwaysShow: true`, so
the **Gateway's ranking is authoritative** and VS Code never re-filters our
results. This is not optional polish — without it live semantic search silently
drops matches.

## Architecture

A pure logic module parses/normalizes/formats results; the extension command
layer owns the live `QuickPick` orchestration and the client calls; a lightly
widened `openSource` seam opens the chosen result; the `vscode-shim` gains a
`createQuickPick` seam.

### Component 1 — `src/search.ts` (new, pure, `vscode`-free)

Mirrors the sidebar parse modules; reuses `src/sidebar/parse-helpers.ts`.

```ts
// Collapse all whitespace (incl. newlines) to single spaces, trim, and truncate
// to `max` chars with an ellipsis. Used for single-line QuickPick detail and for
// the Search-Selection prefill (review #3, #5).
export function normalizeInline(s: string, max?: number): string;

export interface RankedResult {
  name: string;
  service: string;
  itemType?: string;   // NimbusItem.itemType, else indexedType (review #7)
  score: number;
  url?: string;        // canonicalUrl ?? url
  snippet?: string;    // semanticSnippet, normalized
}

// Defensively coerce one searchRanked row (typed by the client, parsed here for
// resilience, consistent with the Audit/Egress views). Requires a name; drops
// rows without one. itemType prefers the user-facing NimbusItem.itemType and
// falls back to the index's indexedType (review #7).
export function parseRankedItem(raw: unknown): RankedResult | undefined;

// QuickPick view-model. Structurally a QuickPickItem (+ carried fields).
//   label       = name
//   description = "<service>[ · <itemType>] · score <score.toFixed(2)>"  (#6/#7)
//   detail      = normalized snippet, else url, else "No source URL available"
//   alwaysShow  = true                                     (review #1/#2)
//   url         = RankedResult.url (may be undefined)
//   canOpen     = url is a non-empty string                (review #4)
export interface SearchPick {
  label: string;
  description: string;
  detail: string;
  alwaysShow: true;
  url?: string;
  canOpen: boolean;
  isStatus?: boolean;  // a non-selectable status row (e.g. "No results") — #8
}
export function rankedResultToPick(r: RankedResult): SearchPick;

// Map + drop-malformed, for the command layer and direct unit tests.
export function buildPicks(rawRows: unknown[]): SearchPick[];

// A non-selectable status row (alwaysShow, canOpen:false, isStatus:true) used to
// show "No matching index records" instead of a blank list (review #8).
export function statusPick(label: string): SearchPick;
```

Notes:
- `url` prefers `canonicalUrl`, then `url`; may be absent.
- Respect `exactOptionalPropertyTypes`: only set `itemType`/`url`/`snippet` when
  present.
- **Review #6 (score):** display the score labeled and 2-dp
  (`score 0.85`). The score's *range* (normalized 0–1 vs raw BM25) is **not**
  documented in the client types; the implementation plan includes a step to
  inspect a live `searchRanked` response and, if it is an unbounded BM25 value,
  adjust the label wording (e.g. `relevance 12.3`). The display is self-describing
  either way; the exact wording is the only thing deferred.

### Component 2 — `src/extension.ts` live-search orchestration

A single `runSearch(initialValue?)` builds and drives a live QuickPick; both
commands call it.

```ts
const SEARCH_LIMIT = 50;
const SEARCH_DEBOUNCE_MS = 200;
const SELECTION_PREFILL_MAX = 150;

const runSearch = (initialValue?: string): void => {
  const client = nimbus();
  if (client === undefined) {
    void deps.window.showErrorMessage("Nimbus: not connected to Gateway.");
    return;
  }
  const qp = deps.window.createQuickPick<SearchPick>();
  qp.placeholder = "Search the local Nimbus index";
  qp.matchOnDescription = true;           // moot given alwaysShow, set for parity
  qp.matchOnDetail = true;
  let seq = 0;                            // stale-response guard (latest wins)
  let disposed = false;                   // guard writes after the pick is hidden
  let timer: ReturnType<typeof setTimeout> | undefined;

  const runQuery = async (value: string): Promise<void> => {
    const mine = ++seq;                  // bump first: clearing the box must
    const q = value.trim();              // invalidate an in-flight non-empty query
    if (q.length === 0) { qp.items = []; qp.busy = false; return; }
    qp.busy = true;
    try {
      const rows = await client.searchRanked({ name: q, limit: SEARCH_LIMIT });
      if (disposed || mine !== seq) return;  // pick closed, or superseded
      const picks = buildPicks(rows);
      qp.items = picks.length > 0 ? picks : [statusPick("No matching index records")];
    } catch (e) {
      if (disposed || mine !== seq) return;
      log.error(`nimbus.search failed: ${errMsg(e)}`);
      qp.items = [];
      void deps.window.showErrorMessage(`Nimbus search failed: ${errMsg(e)}`);
    } finally {
      if (!disposed && mine === seq) qp.busy = false;
    }
  };

  qp.onDidChangeValue((value) => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => void runQuery(value), SEARCH_DEBOUNCE_MS);
  });

  qp.onDidAccept(() => {
    const pick = qp.selectedItems[0];
    if (pick === undefined || pick.isStatus === true) return;   // #8: ignore status rows
    if (pick.canOpen && pick.url !== undefined) {
      void openSource({ url: pick.url });
    } else {
      void deps.window.showInformationMessage(`No source to open for "${pick.label}".`);
    }
    qp.hide();
  });

  qp.onDidHide(() => {
    disposed = true;
    if (timer !== undefined) clearTimeout(timer);
    qp.dispose();
  });

  if (initialValue !== undefined) {
    const seed = normalizeInline(initialValue, SELECTION_PREFILL_MAX);
    qp.value = seed;
    void runQuery(seed);                 // seed searches immediately (no debounce)
  }
  qp.show();
};

register("nimbus.search", () => {
  runSearch();
});

register("nimbus.searchSelection", () => {
  const editor = deps.window.activeTextEditor;
  if (editor === undefined || editor.selection.isEmpty) {
    void deps.window.showErrorMessage("Nimbus: select text first.");
    return;
  }
  runSearch(editor.document.getText(editor.selection));   // prefill (review #3)
});
```

- Empty value never calls the Gateway (avoids a large top-ranked fetch on open).
- The seed (selection) is normalized+truncated (review #3) and searched once
  immediately so results are visible before the user types.
- Errors surface once per failed keystroke and never leave a stale spinner.

### Component 3 — the `createQuickPick` shim seam + widened `openSource`

`src/vscode-shim.ts`: add a minimal `QuickPickLike<T>` interface and a
`createQuickPick<T>()` method on `WindowApi`, exposing only what the
orchestration uses:

```ts
export interface QuickPickLike<T> {
  value: string;
  placeholder: string | undefined;
  items: readonly T[];
  busy: boolean;
  matchOnDescription: boolean;
  matchOnDetail: boolean;
  readonly selectedItems: readonly T[];
  onDidChangeValue(cb: (value: string) => void): DisposableLike;
  onDidAccept(cb: () => void): DisposableLike;
  onDidHide(cb: () => void): DisposableLike;
  show(): void;
  hide(): void;
  dispose(): void;
}
// WindowApi gains: createQuickPick<T extends { label: string }>(): QuickPickLike<T>;
```

The real `vscode.window.createQuickPick()` satisfies this structurally (the
extension already wires other `WindowApi` members to `vscode.window` at the
composition root). `test/unit/vscode-stub.ts` adds a controllable fake
(`value`/`items`/`busy` mutable; `onDidChangeValue`/`onDidAccept`/`onDidHide`
capture callbacks the test can fire).

**Widen `openSource`** (unchanged logic): `createSourceOpener` and
`ActivateDeps.openSource` change their parameter from `IndexItem` to a structural
`{ url?: string }`. `IndexItem` (which has `url?: string`) still satisfies it, so
the Index view is untouched; search passes `{ url }`. One open path, two callers.

## Data flow

```text
nimbus.search           → runSearch()
nimbus.searchSelection  → runSearch(selectionText)   // empty selection → error toast

runSearch(initial?):
  nimbus() undefined → "not connected" toast, return
  qp = createQuickPick()
  onDidChangeValue → debounce(200ms) → runQuery(value)
      runQuery: trim; empty → clear; else searchRanked({ name, limit:50 })
               → buildPicks(rows) [alwaysShow:true] → qp.items   (stale seq dropped)
  onDidAccept → selected.canOpen ? openSource({url}) : info toast → hide
  onDidHide   → clear timer, dispose
  initial? → qp.value = normalizeInline(initial,150); runQuery(seed); 
  qp.show()
```

## Error handling / edge cases

- **Disconnected (at open):** existing guard → `showErrorMessage("Nimbus: not connected to Gateway.")`; the QuickPick never opens.
- **`searchRanked` throws (per keystroke):** `log.error` + `showErrorMessage` via
  `errMsg`, items cleared, spinner cleared. A later keystroke can recover.
- **Empty selection:** `"Nimbus: select text first."` (as today).
- **Empty query:** no Gateway call; empty list.
- **Stale responses:** a monotonic `seq` guard drops out-of-order results so a
  slow early query cannot overwrite a newer one (latest-wins).
- **Pick closed mid-flight:** a `disposed` flag (set in `onDidHide`) guards the
  post-`await` writes so a late `searchRanked` result never mutates a disposed
  QuickPick (which VS Code would throw on).
- **No results (review #8):** a single non-selectable status row
  ("No matching index records", `isStatus:true`, `canOpen:false`) rather than a
  blank list; accepting it does nothing.
- **Result without a URL (review #4):** `detail` reads "No source URL available"
  and `canOpen` is false; accepting it shows an explicit info toast instead of a
  silent no-op.
- **Multi-line snippet / huge selection (review #3/#5):** `normalizeInline`
  collapses whitespace/newlines and truncates, so neither the `detail` nor the
  Search-Selection prefill breaks the single-line surfaces.
- **Malformed row:** dropped by `parseRankedItem`, never thrown.

## Testing

Vitest, `vscode` aliased to the stub. `MockClient` provides `rankedItems`.

- `test/unit/search.test.ts` (pure module):
  - `normalizeInline`: collapses `\r\n`/`\n`/tabs/runs to single spaces; trims;
    truncates to `max` with ellipsis; no-op when short; `max` omitted → no trunc.
  - `parseRankedItem`: full row; `canonicalUrl` preferred over `url`; falls back
    to `url`; missing `name` → `undefined`; non-object/`null` → `undefined`;
    optional `itemType`/`snippet` coerced/omitted; **`itemType` falls back to
    `indexedType`** when the NimbusItem field is absent (review #7).
  - `rankedResultToPick`: label/description/detail composition; `alwaysShow` true;
    score labeled + 2-dp; **`itemType` segment included in description when
    present** (review #7); snippet normalized into `detail`; no-url →
    `canOpen:false` and the "No source URL available" detail.
  - `buildPicks`: maps rows, drops malformed, preserves order.
  - `statusPick`: `isStatus:true`, `canOpen:false`, `alwaysShow:true` (review #8).
- `test/unit/extension.test.ts` (orchestration; drive the stub QuickPick):
  - Typing fires `searchRanked({ name, limit: 50 })` after the debounce; items set
    with `alwaysShow`.
  - **Stale guard:** an earlier slow query resolving after a later one does not
    overwrite the newer items.
  - Accept on an openable pick calls `openSource` with the url; accept on a
    no-url pick shows the info toast and does **not** call `openSource`; accept on
    a status row (empty results) is a no-op (review #8).
  - A query returning zero rows shows the single "No matching index records"
    status row, not a blank list (review #8).
  - Search Selection prefills `qp.value` with the normalized selection and runs
    an immediate query.
  - Empty selection → "select text first"; disconnected → not-connected toast and
    no QuickPick; `searchRanked` rejects → error toast + cleared busy.
- Coverage at ledger parity; overall gate stays green.

## Files

- Create: `src/search.ts`, `test/unit/search.test.ts`
- Modify:
  - `src/extension.ts` (`runSearch` live orchestration, both command handlers,
    widen `openSource`/`ActivateDeps.openSource`, the three `SEARCH_*` consts)
  - `src/vscode-shim.ts` (`QuickPickLike`, `WindowApi.createQuickPick`)
  - `test/unit/vscode-stub.ts` (controllable `createQuickPick` fake)
  - `test/unit/extension.test.ts` (orchestration tests)
- Docs (feature commit): `CHANGELOG.md` (Unreleased); note the Search upgrade in
  `README.md` if wording warrants.

## Self-review

- **Placeholder scan:** none. The one deferred item is the score-label *wording*
  (review #6), gated on inspecting a live response — an explicit plan step, not a
  spec gap. `alwaysShow`, `createQuickPick`, and `QuickPickItem` behavior are
  verified against `@types/vscode`.
- **Consistency:** `RankedResult`/`SearchPick`/`QuickPickLike` used identically
  across module, command, shim, and tests. `openSource` widening is compatible
  with `IndexItem`. `alwaysShow: true` is specified everywhere results are built.
- **Scope:** single implementation plan; filters/toggles/multi-action deferred.
- **Ambiguity:** result action is Open-on-accept with an explicit no-source toast
  (review #4); Search Selection prefills normalized selection (review #3); live
  search with per-keystroke re-query and latest-wins guard (review #1/#2); no
  client bump.

## Review-feedback disposition

- **#1 (live createQuickPick)** — adopted. Replaces the sequential input→popup
  flow with a single live surface.
- **#2 (QuickPick local-filter pitfall)** — resolved by #1 plus `alwaysShow: true`
  so the Gateway ranking is authoritative.
- **#3 (large/multi-line selection)** — fixed via `normalizeInline(sel, 150)`.
- **#4 (no-op on URL-less results)** — fixed: marked in `detail`, `canOpen:false`,
  explicit info toast on accept.
- **#5 (multi-line snippet in detail)** — fixed via `normalizeInline(snippet)`.
- **#6 (score format/range)** — display labeled + 2-dp now; exact wording for an
  unbounded-range score deferred to a live-response check in the plan.
- **#7 (itemType in description)** — fixed: `service · itemType · score`;
  `parseRankedItem` prefers `NimbusItem.itemType`, falls back to `indexedType`.
- **#8 (empty result set)** — fixed: a non-selectable "No matching index records"
  status row instead of a blank list; accept ignores status rows.
- **#9 (duplicate badges)** — deferred (see non-goals): enrichment, not core to
  search functioning.
- **#10 (configurable limit)** — deferred (see non-goals): `SEARCH_LIMIT = 50` is
  a sensible picker cap; a `nimbus.search.limit` setting can follow on demand.
