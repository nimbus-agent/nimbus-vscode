# Design: Ranked-Search Feedback — Configurable Limit + Duplicates Badge

**Date:** 2026-07-16
**Status:** Approved (pending implementation)
**Feedback source:** [2026-07-15-ranked-search-design-feedback.md](file:///C:/gitrep/nimbus-vscode/docs/superpowers/specs/2026-07-15-ranked-search-design-feedback.md) — items #9 and #10

---

## Context

The ranked-search feature shipped in PR #16. A retrospective review of the
plan and design spec raised 13 observations; 11 were already handled by the
shipped implementation. Two remain outstanding and are both unblocked and
self-contained:

- **#10 — Search result limit config:** `SEARCH_LIMIT` is a hardcoded `50` in
  `extension.ts`. The Gateway's `searchRanked` accepts `limit` clamped to
  `1..500` (default 20). Power users should be able to raise/lower it.
- **#9 — Duplicate indicators:** `RankedSearchItem.duplicates?: readonly
  string[]` is returned by the client but ignored. When present it is useful to
  surface a `+N duplicates` badge so identical content across locations reads as
  intentional, not a rendering bug.

No other feedback item is in scope. No refactoring beyond these two changes.

## Item #10 — Configurable search limit (`nimbus.search.limit`)

Mirror the existing `nimbus.transcriptHistoryLimit` setting exactly — same
shape and bounds, which already match the Gateway's documented `1..500` clamp.

- **`package.json`** — add a `nimbus.search.limit` configuration property:
  `type: number`, `default: 50`, `minimum: 1`, `maximum: 500`, with a
  description noting the Gateway clamps to 1..500.
- **`src/settings.ts`** — add `searchLimit(): number` to the `Settings`
  interface and `createSettings`, implemented as
  `cfg().get<number>("search.limit", 50)`. No client-side clamp: consistent
  with `transcriptHistoryLimit` (the settings UI enforces `min`/`max`; the
  Gateway clamps server-side).
- **`src/extension.ts`** — remove the hardcoded `const SEARCH_LIMIT = 50` and
  read `settings.searchLimit()` at query time inside `runSearch`, so a settings
  change applies to the next search without reloading the window.

## Item #9 — Duplicates badge

- **`src/search.ts`**
  - `RankedResult` gains an optional `duplicateCount?: number`.
  - `parseRankedItem`: read `rec["duplicates"]`; when it is a non-empty array,
    set `duplicateCount = duplicates.length`. Defensive: only `Array.isArray`
    values with `length > 0` set the field; missing / empty / non-array leave it
    unset.
  - `rankedResultToPick`: when `duplicateCount` is set, append a
    `+N duplicate` / `+N duplicates` segment (singular at 1) to the existing
    `·`-joined description. Example:
    `gitlab · issue · score 0.85 · +3 duplicates`.

## Testing (TDD)

Follows the existing `test/unit/search.test.ts` and
`test/unit/extension.test.ts` patterns.

- **`search.test.ts`**
  - `parseRankedItem` sets `duplicateCount` from a non-empty `duplicates` array;
    leaves it unset when the field is missing, an empty array, or not an array.
  - `rankedResultToPick` renders `+1 duplicate` (singular), `+N duplicates`
    (plural), and omits the segment when `duplicateCount` is unset.
- **`extension.test.ts`**
  - The search flow passes the configured limit to `client.searchRanked` — with
    a custom `searchLimit()` on the settings stub and with the default 50.

## Out of scope

The other 8 design-feedback items and all 3 plan-feedback items — already
shipped in PR #16. No unrelated refactoring.
