# Ranked-Search: Configurable Limit + Duplicates Badge — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the ranked-search result limit configurable via `nimbus.search.limit`, and surface a `(+N duplicates)` badge on results the Gateway reports as having duplicates.

**Architecture:** Two small, independent changes to the existing search surface. A pure `clampSearchLimit` helper sanitizes the config value in `settings.ts`; `extension.ts` reads the sanitized limit at query time instead of a hardcoded constant. Duplicate handling extends the existing pure `parseRankedItem` / `rankedResultToPick` pipeline in `search.ts` — no new files.

**Tech Stack:** TypeScript (strict), Vitest, Biome, esbuild. Package manager: `bun`.

## Global Constraints

- TypeScript **strict**; **no `any`** — use `unknown` for external data (Biome `noExplicitAny`).
- No `console` in `src/` — log via the output channel (Biome `noConsole`). No non-null assertions (`noNonNullAssertion`).
- The `vscode` API is only touched through `src/vscode-shim.ts`; tests use `test/unit/vscode-stub.ts`.
- `@nimbus-dev/client` stays a **published** `^x.y.z` dependency — do not change it. Do not import from Gateway source.
- The Gateway clamps `searchRanked` `limit` to **1..500** (default 20). Our setting default is **50** (unchanged from today's hardcoded value).

---

### Task 1: Configurable search limit (`nimbus.search.limit`)

**Files:**
- Modify: `src/search.ts` (add `clampSearchLimit`)
- Modify: `src/settings.ts` (add `searchLimit()`)
- Modify: `src/extension.ts` (replace `SEARCH_LIMIT` constant with `settings.searchLimit()`)
- Modify: `package.json` (add `nimbus.search.limit` configuration property)
- Test: `test/unit/search.test.ts` (clamp helper), `test/unit/extension.test.ts` (limit passed to `searchRanked`)

**Interfaces:**
- Produces: `clampSearchLimit(raw: unknown): number` — exported from `src/search.ts`. Non-number / non-finite → `50`; otherwise `Math.floor` clamped to `1..500`.
- Produces: `Settings.searchLimit(): number` — returns the clamped configured limit.
- Consumes: nothing from other tasks.

- [ ] **Step 1: Write the failing test for `clampSearchLimit`**

Add to `test/unit/search.test.ts`. Extend the import from `../../src/search.js` to include `clampSearchLimit`, then append this block:

```ts
describe("clampSearchLimit", () => {
  test("passes valid in-range integers through", () => {
    expect(clampSearchLimit(50)).toBe(50);
    expect(clampSearchLimit(1)).toBe(1);
    expect(clampSearchLimit(500)).toBe(500);
  });
  test("clamps out-of-range values to 1..500", () => {
    expect(clampSearchLimit(0)).toBe(1);
    expect(clampSearchLimit(-10)).toBe(1);
    expect(clampSearchLimit(10000)).toBe(500);
  });
  test("floors fractional values", () => {
    expect(clampSearchLimit(49.9)).toBe(49);
    expect(clampSearchLimit(1.5)).toBe(1);
  });
  test("floors before clamping at the boundaries", () => {
    expect(clampSearchLimit(0.9)).toBe(1);
    expect(clampSearchLimit(500.1)).toBe(500);
    expect(clampSearchLimit(-0.5)).toBe(1);
  });
  test("falls back to 50 for non-finite / non-number input", () => {
    expect(clampSearchLimit(Number.NaN)).toBe(50);
    expect(clampSearchLimit(Number.POSITIVE_INFINITY)).toBe(50);
    expect(clampSearchLimit("200")).toBe(50);
    expect(clampSearchLimit(undefined)).toBe(50);
    expect(clampSearchLimit(null)).toBe(50);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bunx vitest run test/unit/search.test.ts`
Expected: FAIL — `clampSearchLimit is not a function` / import has no such export.

- [ ] **Step 3: Implement `clampSearchLimit` in `src/search.ts`**

Add near the top of `src/search.ts`, after the `normalizeInline` function:

```ts
// Clamp a configured search limit to the Gateway's accepted 1..500 range,
// flooring fractional values and falling back to 50 for non-numeric/NaN input.
// settings.json is hand-editable and bypasses the settings UI's min/max.
export function clampSearchLimit(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return 50;
  return Math.min(500, Math.max(1, Math.floor(raw)));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bunx vitest run test/unit/search.test.ts`
Expected: PASS (all `clampSearchLimit` cases green, existing cases still green).

- [ ] **Step 5: Write the failing extension tests for the configured limit**

Add to `test/unit/extension.test.ts`, next to the existing `"typing runs a ranked search and lists results with alwaysShow"` test (~line 868):

```ts
test("uses the configured search.limit setting", async () => {
  const calls: Array<{ name?: string; limit?: number }> = [];
  const f = makeFixture({
    cfg: { "search.limit": 200 },
    searchDebounceMs: 0,
    openClient: makeFakeClient({
      searchRanked: async (p: { name?: string; limit?: number }) => {
        calls.push(p);
        return [];
      },
    } as never),
  });
  activateWithDeps(f.ctx, f.deps);
  await waitForConnect();
  cmd(f, "nimbus.search")();
  const qp = f.quickPicks[0] as FakeQuickPick;
  qp.setValueAndFire("report");
  await flush();
  expect(calls).toEqual([{ name: "report", limit: 200 }]);
});

test("clamps a malformed search.limit back to the default", async () => {
  const calls: Array<{ limit?: number }> = [];
  const f = makeFixture({
    cfg: { "search.limit": "lots" },
    searchDebounceMs: 0,
    openClient: makeFakeClient({
      searchRanked: async (p: { limit?: number }) => {
        calls.push(p);
        return [];
      },
    } as never),
  });
  activateWithDeps(f.ctx, f.deps);
  await waitForConnect();
  cmd(f, "nimbus.search")();
  const qp = f.quickPicks[0] as FakeQuickPick;
  qp.setValueAndFire("report");
  await flush();
  expect(calls[0]?.limit).toBe(50);
});
```

- [ ] **Step 6: Run the extension tests to verify they fail**

Run: `bunx vitest run test/unit/extension.test.ts`
Expected: FAIL — the `search.limit: 200` case gets `limit: 50` (still hardcoded); assertion mismatch.

- [ ] **Step 7: Add `searchLimit()` to `src/settings.ts`**

Add the import at the top (after the existing `vscode-shim` import):

```ts
import { clampSearchLimit } from "./search.js";
```

Add to the `Settings` interface (after `transcriptHistoryLimit(): number;`):

```ts
  searchLimit(): number;
```

Add to the returned object in `createSettings` (after the `transcriptHistoryLimit` line):

```ts
    searchLimit: () => clampSearchLimit(cfg().get<number>("search.limit", 50)),
```

- [ ] **Step 8: Read the configured limit in `src/extension.ts`**

Delete the constant (line ~51):

```ts
const SEARCH_LIMIT = 50;
```

In `runQuery` (inside `runSearch`), change the `searchRanked` call from:

```ts
        const rows = await client.searchRanked({ name: q, limit: SEARCH_LIMIT });
```

to:

```ts
        const rows = await client.searchRanked({ name: q, limit: settings.searchLimit() });
```

(`settings` is already in scope — it is created at the top of `activateWithDeps`.)

- [ ] **Step 9: Add the `nimbus.search.limit` configuration property to `package.json`**

In `contributes.configuration.properties`, insert this entry immediately after the `nimbus.transcriptHistoryLimit` block:

```json
        "nimbus.search.limit": {
          "type": "number",
          "default": 50,
          "minimum": 1,
          "maximum": 500,
          "description": "Maximum results requested from the local index per search. The Gateway clamps to 1..500."
        },
```

- [ ] **Step 10: Run the full unit suite + typecheck + lint**

Run: `bun run test && bun run typecheck && bun run lint`
Expected: PASS. The existing `"typing runs a ranked search…"` test still asserts `limit: 50` (default path through clamp → 50). No import cycle: `settings.ts` → `search.ts` → `sidebar/parse-helpers.ts` (pure); if `typecheck`/`test` reports a cycle or the alias fails to resolve, stop and report — do not paper over it.

- [ ] **Step 11: Commit**

```bash
git add src/search.ts src/settings.ts src/extension.ts package.json test/unit/search.test.ts test/unit/extension.test.ts
git commit -m "feat(search): configurable nimbus.search.limit (clamped 1..500)"
```

---

### Task 2: Duplicates badge

**Files:**
- Modify: `src/search.ts` (`RankedResult`, `parseRankedItem`, `rankedResultToPick`)
- Test: `test/unit/search.test.ts`

**Interfaces:**
- Consumes: `RankedResult`, `parseRankedItem`, `rankedResultToPick` from `src/search.ts` (existing).
- Produces: `RankedResult.duplicateCount?: number` — count of valid duplicate entries, set only when `> 0`. The pick description gains a trailing `· (+N duplicate)` / `· (+N duplicates)` segment when set.

- [ ] **Step 1: Write the failing `parseRankedItem` duplicate tests**

Add inside the existing `describe("parseRankedItem", …)` block in `test/unit/search.test.ts`:

```ts
  test("counts non-empty string duplicates", () => {
    expect(parseRankedItem(row({ duplicates: ["a", "b", "c"] }))?.duplicateCount).toBe(3);
  });
  test("counts only valid string entries in a mixed array", () => {
    expect(parseRankedItem(row({ duplicates: ["a", "", 5, null, "b"] }))?.duplicateCount).toBe(2);
  });
  test("excludes the item's own url from the duplicate count", () => {
    // row() resolves url to canonicalUrl ("https://canonical/x"); only the
    // other entry should be counted even if the Gateway includes self.
    const r = parseRankedItem(row({ duplicates: ["https://canonical/x", "https://other/y"] }));
    expect(r?.duplicateCount).toBe(1);
  });
  test("omits duplicateCount when missing, empty, non-array, or all-invalid", () => {
    expect("duplicateCount" in (parseRankedItem(row()) as object)).toBe(false);
    expect("duplicateCount" in (parseRankedItem(row({ duplicates: [] })) as object)).toBe(false);
    expect("duplicateCount" in (parseRankedItem(row({ duplicates: "nope" })) as object)).toBe(false);
    expect("duplicateCount" in (parseRankedItem(row({ duplicates: ["", 7] })) as object)).toBe(false);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bunx vitest run test/unit/search.test.ts`
Expected: FAIL — `duplicateCount` is `undefined` (field not implemented).

- [ ] **Step 3: Implement duplicate parsing in `src/search.ts`**

Add the optional field to the `RankedResult` interface (after `snippet?: string;`):

```ts
  duplicateCount?: number;
```

In `parseRankedItem`, insert this block after the `snippet` handling and before `return result;`:

```ts
  const duplicates = rec["duplicates"];
  if (Array.isArray(duplicates)) {
    // Count only non-empty strings, and never the item's own url — a
    // conservative guard so the badge reflects *other* copies even if the
    // Gateway includes the primary in the array. (`url` is undefined-safe:
    // when absent, no entry equals it, so nothing is over-filtered.)
    const count = duplicates.filter(
      (d): d is string => typeof d === "string" && d.length > 0 && d !== url,
    ).length;
    if (count > 0) result.duplicateCount = count;
  }
```

`url` here is the local `const url` computed earlier in `parseRankedItem` (the `canonicalUrl ?? url` resolution) — it is in scope at this point. Insert this block after that `url`/`snippet` handling and before `return result;`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bunx vitest run test/unit/search.test.ts`
Expected: PASS (new `parseRankedItem` cases green; existing exact-equal "full row" test still green because `row()` has no `duplicates`).

- [ ] **Step 5: Write the failing `rankedResultToPick` badge tests**

Add inside the existing `describe("rankedResultToPick", …)` block:

```ts
  test("appends a parenthesized duplicates badge (plural)", () => {
    const pick = rankedResultToPick({ name: "n", service: "s", score: 0.5, duplicateCount: 3 });
    expect(pick.description).toBe("s · score 0.50 · (+3 duplicates)");
  });
  test("uses the singular form at one duplicate", () => {
    const pick = rankedResultToPick({ name: "n", service: "s", score: 0.5, duplicateCount: 1 });
    expect(pick.description).toBe("s · score 0.50 · (+1 duplicate)");
  });
  test("omits the badge when duplicateCount is unset", () => {
    const pick = rankedResultToPick({ name: "n", service: "s", score: 0.5 });
    expect(pick.description).toBe("s · score 0.50");
  });
```

- [ ] **Step 6: Run the tests to verify they fail**

Run: `bunx vitest run test/unit/search.test.ts`
Expected: FAIL — description lacks the `· (+N duplicate(s))` segment.

- [ ] **Step 7: Implement the badge in `rankedResultToPick`**

In `src/search.ts`, in `rankedResultToPick`, after `parts.push(\`score ${r.score.toFixed(2)}\`);` and before `const canOpen = …`, add:

```ts
  if (r.duplicateCount !== undefined && r.duplicateCount > 0) {
    const n = r.duplicateCount;
    parts.push(`(+${n} duplicate${n === 1 ? "" : "s"})`);
  }
```

- [ ] **Step 8: Run the full suite + typecheck + lint**

Run: `bunx vitest run test/unit/search.test.ts && bun run test && bun run typecheck && bun run lint`
Expected: PASS across the board.

- [ ] **Step 9: Commit**

```bash
git add src/search.ts test/unit/search.test.ts
git commit -m "feat(search): show a (+N duplicates) badge on ranked results"
```

---

## Verification & Open Item

- [ ] **Build sanity:** `bun run build && bun run check-bundle` — confirms the bundle still has `vscode` as its only external (this change adds only an internal `settings.ts` → `search.ts` import, no new runtime dep).
- [ ] **Drive the change (verify skill):** open the search Quick Pick against a running Gateway, type a query, and confirm (a) results honor a changed `nimbus.search.limit`, and (b) a result with duplicates shows the `(+N duplicates)` badge.
- [ ] **OPEN ITEM — duplicate self-inclusion (from spec):** the client types `duplicates` only as `readonly string[]` with no contract doc, and Gateway source is off-limits. Task 2 already applies a conservative guard (`d !== url`) that neutralizes self-inclusion **if entries are canonical URLs**. This still needs a live-Gateway confirmation, because the guard does *not* cover the case where entries are keyed by something else (e.g. `indexPrimaryKey`). Against the live Gateway, inspect one item known to have duplicates and confirm (a) what the entries actually are (URL vs key), and (b) the badge count matches the number of **other** locations. If entries are keyed and self is included, switch the guard to filter on that key (or subtract 1) and update the `parseRankedItem` count tests accordingly.

## Spec Coverage

- Spec §"Item #10" → Task 1 (clamp helper, `searchLimit()`, `extension.ts` wiring, `package.json` property, tests).
- Spec §"Item #9" → Task 2 (`duplicateCount` parsing with string-entry validation, parenthesized badge, tests).
- Spec §"Item #9 → Self-inclusion open item" → Verification & Open Item.
- Spec §"Out of scope" (detail-location listing, `transcriptHistoryLimit` back-fix) → not implemented, by design.
