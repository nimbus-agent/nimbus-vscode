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
- **`src/search.ts`** — add a pure, exported `clampSearchLimit(raw: unknown):
  number`: non-finite / non-number / `NaN` → `50`; otherwise `Math.floor`
  clamped to `1..500`. `settings.json` is hand-editable and bypasses the UI
  `min`/`max`, so a defensive clamp keeps malformed values (negatives, `10000`,
  a string) from reaching the Gateway. (`transcriptHistoryLimit` has the same
  latent gap but is out of scope here.)
- **`src/settings.ts`** — add `searchLimit(): number` to the `Settings`
  interface and `createSettings`, implemented as
  `clampSearchLimit(cfg().get<number>("search.limit", 50))` — sanitized at the
  source so every consumer gets a safe value.
- **`src/extension.ts`** — remove the hardcoded `const SEARCH_LIMIT = 50` and
  read `settings.searchLimit()` at query time inside `runSearch`, so a settings
  change applies to the next search without reloading the window.

## Item #9 — Duplicates badge

- **`src/search.ts`**
  - `RankedResult` gains an optional `duplicateCount?: number`.
  - `parseRankedItem`: read `rec["duplicates"]`; count only non-empty **string**
    entries (not merely `Array.isArray`), and set `duplicateCount` to that count
    when it is `> 0`. Missing / empty / non-array / all-invalid leave the field
    unset.
  - `rankedResultToPick`: when `duplicateCount` is set, append a parenthesized
    `(+N duplicate)` / `(+N duplicates)` segment (singular at 1) to the existing
    `·`-joined description — parentheses mark it as supplementary metadata,
    distinct from the service/type/score parts. Example:
    `gitlab · issue · score 0.85 · (+3 duplicates)`.

  **Self-inclusion — open, to confirm at verify-time.** The client types
  `duplicates` only as `readonly string[]` with no contract doc, and there is no
  fixture or Gateway source available from this repo (reaching into the Gateway
  is a non-negotiable per `CLAUDE.md`). This design assumes the array lists
  *other* copies, so `duplicateCount` is shown as-is. If a live Gateway shows
  the primary item is included, the fix is a one-line adjustment (subtract or
  filter the primary key/URL). This must be checked against a running Gateway
  during the verify step before the change is considered done.

## Testing (TDD)

Follows the existing `test/unit/search.test.ts` and
`test/unit/extension.test.ts` patterns.

- **`search.test.ts`**
  - `clampSearchLimit`: `NaN` / non-number / non-finite → `50`; `0` and
    negatives → `1`; `> 500` → `500`; floats floored; valid in-range passthrough.
  - `parseRankedItem` sets `duplicateCount` from a `duplicates` array of
    non-empty strings; leaves it unset when the field is missing, an empty array,
    not an array, or contains only empty/non-string entries; counts only the
    valid string entries in a mixed array.
  - `rankedResultToPick` renders `(+1 duplicate)` (singular), `(+N duplicates)`
    (plural), and omits the segment when `duplicateCount` is unset.
- **`extension.test.ts`**
  - The search flow passes the configured limit to `client.searchRanked` — with
    a custom `searchLimit()` on the settings stub and with the default 50.

## Out of scope

- The other 8 design-feedback items and all 3 plan-feedback items — already
  shipped in PR #16. No unrelated refactoring.
- **Listing duplicate locations in `detail`** (design-feedback-review #3): a
  separate UX feature — it needs the duplicate URLs stored, a `detail`
  rendering change, and copyable links, and its goal (opening an *alternate*
  copy) is beyond the badge's goal (making duplicate content read as
  intentional, not a rendering bug). Recorded as a future follow-up.
- Back-fixing the same NaN/clamp gap in `transcriptHistoryLimit`.
