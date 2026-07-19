import { asFiniteNumber, asNonEmptyString, asRecord } from "./sidebar/parse-helpers.js";

// Clamp a configured search limit to the Gateway's accepted 1..500 range,
// flooring fractional values and falling back to 50 for non-numeric/NaN input.
// settings.json is hand-editable and bypasses the settings UI's min/max.
export function clampSearchLimit(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return 50;
  return Math.min(500, Math.max(1, Math.floor(raw)));
}

// Collapse all whitespace (incl. newlines/tabs) to single spaces and trim;
// optionally truncate to `max` chars with a trailing ellipsis. Keeps multi-line
// snippets and large selections on the single-line QuickPick surfaces.
export function normalizeInline(s: string, max?: number): string {
  const collapsed = s.replace(/\s+/g, " ").trim();
  if (max === undefined || collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, max).trimEnd()}…`;
}

export interface RankedResult {
  name: string;
  service: string;
  itemType?: string;
  score: number;
  url?: string;
  snippet?: string;
  duplicateCount?: number;
}

// Coerce one searchRanked row (typed by the client, parsed defensively like the
// Audit/Egress views). Requires a name; drops rows without one. itemType prefers
// the user-facing NimbusItem.itemType and falls back to the index's indexedType.
export function parseRankedItem(raw: unknown): RankedResult | undefined {
  const rec = asRecord(raw);
  if (rec === undefined) return undefined;
  const name = asNonEmptyString(rec["name"]);
  if (name === undefined) return undefined;
  const result: RankedResult = {
    name,
    service: asNonEmptyString(rec["service"]) ?? "",
    score: asFiniteNumber(rec["score"]) ?? 0,
  };
  const itemType = asNonEmptyString(rec["itemType"]) ?? asNonEmptyString(rec["indexedType"]);
  if (itemType !== undefined) result.itemType = itemType;
  const url = asNonEmptyString(rec["canonicalUrl"]) ?? asNonEmptyString(rec["url"]);
  if (url !== undefined) result.url = url;
  const snippet = asNonEmptyString(rec["semanticSnippet"]);
  if (snippet !== undefined) {
    const normalized = normalizeInline(snippet);
    if (normalized.length > 0) result.snippet = normalized;
  }
  const duplicates = rec["duplicates"];
  if (Array.isArray(duplicates)) {
    // Count only non-empty strings, and never the item's own url — a
    // conservative guard so the badge reflects *other* copies even if the
    // Gateway includes the primary in the array. (`url` is undefined-safe:
    // when absent, no entry equals it, so nothing is over-filtered.)
    //
    // The client types this as a bare `readonly string[]` with no documented
    // contract, so whether entries are canonical URLs or index primary keys —
    // and whether the item itself is included — is still unconfirmed against a
    // live Gateway. Tracked in issue #19. If entries turn out to be primary
    // keys, this under-counts by at most one; it never over-counts.
    const count = duplicates.filter(
      (d): d is string => typeof d === "string" && d.length > 0 && d !== url,
    ).length;
    if (count > 0) result.duplicateCount = count;
  }
  return result;
}

export interface SearchPick {
  label: string;
  description: string;
  detail: string;
  alwaysShow: true;
  url?: string;
  canOpen: boolean;
  isStatus?: boolean;
}

// Build the QuickPick view-model for one result. alwaysShow keeps the Gateway
// ranking authoritative (VS Code cannot disable its own label filtering).
export function rankedResultToPick(r: RankedResult): SearchPick {
  const parts = [r.service, r.itemType].filter(
    (x): x is string => typeof x === "string" && x.length > 0,
  );
  parts.push(`score ${r.score.toFixed(2)}`);
  if (r.duplicateCount !== undefined && r.duplicateCount > 0) {
    const n = r.duplicateCount;
    parts.push(`(+${n} duplicate${n === 1 ? "" : "s"})`);
  }
  const canOpen = r.url !== undefined && r.url.length > 0;
  const pick: SearchPick = {
    label: r.name,
    description: parts.join(" · "),
    detail: r.snippet ?? r.url ?? "No source URL available",
    alwaysShow: true,
    canOpen,
  };
  if (r.url !== undefined) pick.url = r.url;
  return pick;
}

// Map rows to picks, dropping malformed rows and any the optional `exclude`
// predicate rejects (used by Find related to drop the item itself). Order preserved.
export function buildPicks(
  rawRows: unknown[],
  exclude?: (r: RankedResult) => boolean,
): SearchPick[] {
  const picks: SearchPick[] = [];
  for (const raw of rawRows) {
    const r = parseRankedItem(raw);
    if (r === undefined) continue;
    if (exclude?.(r)) continue;
    picks.push(rankedResultToPick(r));
  }
  return picks;
}

// A trimmed, case-insensitive name-equality predicate. Deliberately no
// delimiter/quote stripping — that normalization is unpredictable and risks
// excluding legitimately distinct items. Used by Find related.
export function sameName(query: string): (r: RankedResult) => boolean {
  const q = query.trim().toLowerCase();
  return (r) => r.name.trim().toLowerCase() === q;
}

// A non-selectable status row shown instead of a blank list (e.g. "No results").
export function statusPick(label: string): SearchPick {
  return { label, description: "", detail: "", alwaysShow: true, canOpen: false, isStatus: true };
}
