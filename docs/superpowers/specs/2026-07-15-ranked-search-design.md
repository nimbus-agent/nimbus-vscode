# Ranked Search — design

**Date:** 2026-07-15
**Status:** Approved (brainstorm), pending implementation plan
**Branch:** `feat/ranked-search`

## Summary

Make the **Search** surface actually search the local Nimbus index. Today
`nimbus.search` ignores the user's query: it fetches 50 arbitrary recent items
via `queryItems({ limit: 50 })` and relies on VS Code's Quick Pick to
fuzzy-filter *those 50* client-side. The typed query never reaches the Gateway.

`@nimbus-dev/client@0.4.0` exposes `searchRanked(params?)`, a real
semantic+keyword index search. This design rewrites Search on top of it, fixes
**Search Selection** (which currently re-prompts and drops the selection), and
gives results a purpose: selecting one **opens the item** through the Index
view's existing `openSource` seam.

No client bump is required — `searchRanked` is already in the pinned `^0.4.0`.

## Goals / non-goals

**Goals**
- Send the user's query to the Gateway via `searchRanked({ name, limit })`.
- Rank/display results by the Gateway's relevance ordering.
- **Search Selection** prefills the query with the selected text (user can edit).
- Selecting a result opens it (external URL or in-editor file) via `openSource`.

**Non-goals (YAGNI for v1; future work)**
- `service` / `itemType` filter pickers.
- A semantic on/off toggle (`semantic` defaults to `true` on the Gateway).
- `contextChunks` tuning.
- Multi-action result rows (Open + Ask buttons). v1 is Open-on-select only.

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
tests need no bespoke fake.

## Architecture

A pure logic module parses and formats results; the extension command layer owns
the Quick Pick / input-box interaction and the client call; a lightly widened
`openSource` seam opens the chosen result.

### Component 1 — `src/search.ts` (new, pure, `vscode`-free)

Mirrors the sidebar parse modules; reuses `src/sidebar/parse-helpers.ts`.

```ts
export interface RankedResult {
  name: string;
  service: string;
  itemType?: string;
  score: number;
  url?: string;      // canonicalUrl ?? url
  snippet?: string;  // semanticSnippet
}

// Defensively coerce one searchRanked row (typed by the client, parsed here for
// resilience, consistent with the Audit/Egress views). Requires a name; drops
// rows without one.
export function parseRankedItem(raw: unknown): RankedResult | undefined;

// Quick Pick view-model. label = name; description = "service · <score>";
// detail = snippet || url. Carries url through for the open action.
export interface SearchPick {
  label: string;
  description: string;
  detail: string;
  url?: string;
}
export function rankedResultToPick(r: RankedResult): SearchPick;
```

Notes:
- `url` prefers `canonicalUrl`, then `url`; may be absent.
- `score` is formatted to a short fixed precision for display (e.g. 2 dp).
- Respect `exactOptionalPropertyTypes`: only set `itemType` / `url` / `snippet`
  when present.

### Component 2 — `src/extension.ts` command layer

Extract a shared `runSearch(initialValue?: string)` and have both commands call
it:

```ts
const runSearch = async (initialValue?: string): Promise<void> => {
  const client = nimbus();
  if (client === undefined) {
    void deps.window.showErrorMessage("Nimbus: not connected to Gateway.");
    return;
  }
  const inputOpts: { prompt: string; value?: string } = { prompt: "Search local index" };
  if (initialValue !== undefined && initialValue.length > 0) inputOpts.value = initialValue;
  const q = await deps.window.showInputBox(inputOpts);
  if (q === undefined || q.trim().length === 0) return;
  try {
    const rows = await client.searchRanked({ name: q.trim(), limit: SEARCH_LIMIT });
    const picks: SearchPick[] = [];
    for (const raw of rows) {
      const r = parseRankedItem(raw);
      if (r !== undefined) picks.push(rankedResultToPick(r));
    }
    const chosen = await deps.window.showQuickPick(picks, {
      placeHolder:
        picks.length > 0 ? `${picks.length} results for "${q.trim()}"` : `No results for "${q.trim()}"`,
      matchOnDescription: true,
      matchOnDetail: true,
    });
    if (chosen?.url !== undefined && chosen.url.length > 0) {
      await openSource({ url: chosen.url });
    }
  } catch (e) {
    log.error(`nimbus.search failed: ${errMsg(e)}`);
    void deps.window.showErrorMessage(`Nimbus search failed: ${errMsg(e)}`);
  }
};

register("nimbus.search", async () => {
  await runSearch();
});

register("nimbus.searchSelection", async () => {
  const editor = deps.window.activeTextEditor;
  if (editor === undefined || editor.selection.isEmpty) {
    void deps.window.showErrorMessage("Nimbus: select text first.");
    return;
  }
  await runSearch(selectedText(editor));   // prefill the input box
});
```

- `SEARCH_LIMIT = 50` (a named const, cf. `INDEX_LIMIT`).
- `selectedText(editor)` — `editor.document.getText(editor.selection)` via the
  existing `TextEditorLike` shim (`document.getText(range?)` + `selection`);
  trim before use.

### Component 3 — widen the `openSource` seam

`createSourceOpener` today is `(item: IndexItem) => Promise<void>` and reads only
`item.url`. Widen the seam's parameter to a structural `{ url?: string }`:

```ts
export function createSourceOpener(): (item: { url?: string }) => Promise<void>
// ActivateDeps.openSource?: (item: { url?: string }) => Promise<void>
```

`IndexItem` (which has `url?: string`) still satisfies it, so the Index view is
unchanged; search results pass `{ url }`. One open path, two callers. No behavior
change to the open logic (external URL vs file Uri, Windows-drive handling).

## Data flow

```text
nimbus.search           → runSearch()
nimbus.searchSelection  → runSearch(selectedText)   // empty selection → error toast

runSearch(initial?):
  nimbus() undefined → "not connected" toast, return
  showInputBox({ prompt, value: initial? })
  blank → return
  searchRanked({ name, limit: SEARCH_LIMIT })
    → parseRankedItem[]  (drop malformed)
    → rankedResultToPick[]
  showQuickPick(picks, { placeHolder: N results / No results, matchOnDescription, matchOnDetail })
  chosen?.url → openSource({ url })
  throw → log.error + error toast
```

## Error handling / edge cases

- **Disconnected:** existing guard → `showErrorMessage("Nimbus: not connected to Gateway.")`.
- **RPC throw:** `log.error` + `showErrorMessage(...)` (existing pattern, via `errMsg`).
- **Blank query / empty selection:** early return / "select text first" toast (as today).
- **No results:** Quick Pick opens with a `No results for "q"` placeholder over an
  empty list (VS Code shows its own "No results" affordance).
- **Result without a URL:** the pick still lists; selecting it is a no-op
  (`openSource` returns early on empty `url`).
- **Malformed row:** dropped by `parseRankedItem`, never thrown — matches the
  ledger views.

## Testing

Vitest, `vscode` aliased to the stub. `MockClient` provides `rankedItems`.

- `test/unit/search.test.ts` (pure module):
  - `parseRankedItem`: full row; `canonicalUrl` preferred over `url`; falls back
    to `url`; missing `name` → `undefined`; non-object/`null` → `undefined`;
    optional fields (`itemType`, `snippet`) coerced/omitted correctly.
  - `rankedResultToPick`: label/description/detail composition; score formatting;
    `url` carried through; missing snippet → detail falls back to url (or empty).
- `test/unit/extension.test.ts` (command layer):
  - Search sends the typed query: `searchRanked` receives `{ name: "<q>", limit: 50 }`.
  - Results map to Quick Pick items; selecting one calls `openSource` with the
    resolved url.
  - Search Selection prefills the input box `value` with the selection and runs.
  - Empty selection → "select text first"; disconnected → not-connected toast;
    `searchRanked` rejects → error toast (throwing-client fixture).
- Coverage at ledger parity; overall gate stays green.

## Files

- Create: `src/search.ts`, `test/unit/search.test.ts`
- Modify: `src/extension.ts` (`runSearch`, both command handlers, widen
  `openSource`/`ActivateDeps.openSource`, `SEARCH_LIMIT`), `test/unit/extension.test.ts`
- Docs (feature commit): `CHANGELOG.md` (Unreleased), and note the Search upgrade
  in `README.md` if the wording warrants.

## Self-review

- **Placeholder scan:** none. `selectedText(editor)` uses the confirmed
  `TextEditorLike` shim accessors (`document.getText(range?)` + `selection`).
- **Consistency:** `RankedResult` / `SearchPick` used identically across module,
  command, and tests. `openSource` widening is compatible with `IndexItem`.
- **Scope:** single implementation plan; filters/toggles explicitly deferred.
- **Ambiguity:** result action is Open-only (approved); Search Selection prefills
  (approved); no client bump.
