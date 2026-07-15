# Feedback on Ranked Search Design Specification

**Review Date:** 2026-07-15  
**Feedback Target:** [2026-07-15-ranked-search-design.md](file:///C:/gitrep/nimbus-vscode/docs/superpowers/specs/2026-07-15-ranked-search-design.md)

---

## 1. Dynamic / Interactive Search UX (createQuickPick) vs. Sequential Dialogs
* **Observation:** The design proposes a sequential modal prompt flow: first `window.showInputBox` to collect the query, then `window.showQuickPick` to show the results.
* **Suggestion:** While simple to implement, the double-prompt loop can feel disconnected. We should consider using `window.createQuickPick()` to provide a single, unified search interface:
  * By listening to `onDidChangeValue` with a small debounce (e.g., 150-250ms), we can dynamically invoke `searchRanked` and update the `QuickPick.items` in real-time as the user types.
  * This allows the user to see results update instantly, tweak their query if they see no results, and avoids the disjointed step of pressing Enter on an input box only to wait for a second popup to appear.

## 2. Dynamic Filtering Pitfall in QuickPick
* **Observation:** If we use `showQuickPick`, VS Code's built-in client-side fuzzy matching runs on the returned `SearchPick` items as the user types inside the Quick Pick dropdown.
* **Open Questions:**
  * In the proposed design, the user types `q` in the input box, we fetch the top 50 matches for `q`, and then show the Quick Pick. If the user then types something else inside the Quick Pick, it only filters the *fetched 50 results* client-side instead of triggering a new search on the Gateway.
  * If we stick to the two-step sequential flow, we should probably set the Quick Pick search bar to be read-only (or accept that typing filters only the active 50 results). If we want typing to fetch new results, we must use `window.createQuickPick()`.

## 3. Large / Multi-Line Selection Handling in `searchSelection`
* **Observation:** `nimbus.searchSelection` prefills the query with `selectedText(editor)` directly.
* **Suggestions:**
  * **Length Limits:** If a user accidentally selects a whole file or a large block (e.g., 5,000 characters) and triggers search, it will dump the entire block into the input box. We should trim and limit the prefilled value (e.g., to the first line or first 150 characters).
  * **Whitespace/Newline Stripping:** Multi-line text does not render well in a single-line input box. We should replace newlines and excess whitespace with a single space.

## 4. No-Op on Selecting Results without a URL
* **Observation:** If a result has no URL, the design states that selecting it is a no-op since `openSource` returns early on an empty URL.
* **Suggestion:** Clicking a search result and having nothing happen can feel like a bug or a broken UI.
  * We should visually indicate in the `SearchPick` description or detail that the item cannot be opened (e.g., adding `(No source URL available)`).
  * Alternatively, if we cannot open the source, we could fallback to showing an informational toast with the item's details, or omit items without URLs entirely if opening is the only action.

## 5. Formatting Multi-Line Snippets for `detail`
* **Observation:** `detail` is assigned to `semanticSnippet || url`.
* **Suggestion:** Semantic snippets returned by the Gateway often contain multiple lines of code or markdown with raw newlines. VS Code's QuickPick `detail` field is single-line and does not render newlines well (they are usually ignored or rendered as spaces/escaped characters depending on the OS/platform).
  * We should explicitly sanitize/normalize the snippet by replacing newlines (`\r\n` or `\n`) with spaces and collapsing consecutive spaces before setting the `detail` property.

## 6. Score Formatting & Display
* **Observation:** The design suggests formatting the score to 2 decimal places (e.g., in `description`).
* **Open Questions:**
  * What is the range and type of `score` returned by the Gateway's `searchRanked`? If it is a normalized semantic similarity score (e.g., `0.0` to `1.0`), a format like `0.85` works perfectly. If it is a raw BM25 score (which can be `10.53` or higher), it is still fine, but we should make sure the display format is clear (e.g., `Score: 0.85` or `Relevance: 12.34`) so users understand what the number represents.

## 7. Enriching Pick Description with `itemType` / `indexedType`
* **Observation:** The design proposes: `description = "service · <score>"`.
* **Suggestion:** We should also include the item type (e.g. `issue`, `message`, `file`, `merge_request`) in the description if available: `description = "service · itemType · score"`. This provides much better visual hierarchy and context, especially since a search query might return matching text across different services and item categories (e.g., a Slack message vs a GitLab issue).
* **Question:** In the data structure mapping, does `parseRankedItem` check both `item.itemType` (from `NimbusItem`) and `item.indexedType`? Which one takes precedence, and how are they mapped?

## 8. Handling Empty Result Sets Gracefully
* **Observation:** If the server returns zero results, `showQuickPick` will present a placeholder saying `No results for "q"` but with an empty list.
* **Suggestion:** Instead of leaving the Quick Pick list completely blank (which can feel broken), we can push a single, disabled dummy pick item to the list with a label such as `"No results found"` or `"No matching local index records found"` so the user sees a clear, friendly status item inside the list itself.

## 9. Duplicate Indicators & Badges
* **Observation:** `RankedSearchItem` has `duplicates?: readonly string[]`.
* **Suggestion:** If duplicates are present in the item, it is highly useful to display a badge or text indicating this in the detail or description (e.g., `description = "service · score (+3 duplicates)"`). This prevents the user from feeling confused if identical content appears across multiple locations or indicates that the index contains duplicate copies of the item.

## 10. Search Result Limit Config
* **Observation:** `SEARCH_LIMIT` is a hardcoded constant set to `50`.
* **Suggestion:** Since the Gateway's `searchRanked` is fast and supports limits up to 500, we should consider reading the limit from a VS Code configuration setting (e.g., `nimbus.search.limit`), falling back to `50` if not set. This gives power-users the flexibility to request more results.

