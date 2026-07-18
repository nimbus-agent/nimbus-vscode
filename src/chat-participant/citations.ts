import { redactPath } from "../quick-ask.js";
import { parseRankedItem } from "../search.js";
import type { CitationRef } from "./participant-types.js";

// Turn searchRanked rows into clickable citations. Reuses parseRankedItem (the
// same defensive parse the Search / Find-related surfaces use): it maps
// canonicalUrl -> url and drops nameless rows. A citation needs a real target to
// open; rows without one are skipped. The active file is self-excluded by
// basename. Output is capped at `limit`.
export function buildCitations(
  rows: ReadonlyArray<unknown>,
  opts: { excludeBasename?: string; limit: number },
): CitationRef[] {
  const out: CitationRef[] = [];
  for (const raw of rows) {
    if (out.length >= opts.limit) break;
    const r = parseRankedItem(raw);
    if (r === undefined) continue;
    if (r.url === undefined || r.url.length === 0) continue;
    if (opts.excludeBasename !== undefined && redactPath(r.url) === opts.excludeBasename) continue;
    out.push({ label: r.name, target: r.url });
  }
  return out;
}
