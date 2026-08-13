// A diagnostic message mixes INVARIANT PROSE (which another occurrence of the
// same problem shares) with CALL-SITE TOKENS (paths, positions, local
// identifiers) that are unique to this line and poison a semantic query. This
// module keeps the first and drops the second.

export type QuotedTokenPolicy = "keep" | "drop";

// Keyed on `diagnostic.source`. DEFAULT IS "keep": compilers quote types, which
// is the useful half of their message. Only linters that quote the offending
// identifier are listed. Sources whose messages quote BOTH (rustc, pyright) are
// deliberately absent — a single per-source verdict is the wrong shape for
// them, and guessing would make their queries worse. See the spec, Part 9.
export const QUOTED_TOKEN_POLICY: Record<string, QuotedTokenPolicy> = {
  eslint: "drop",
  biome: "drop",
};

// searchRanked's `name` is a free-text query; past a few hundred characters the
// call-site noise outweighs the signal.
export const NORMALIZED_QUERY_MAX_CHARS = 300;

// Below this a query is a bare code or an empty husk — it would return noise, so
// actions.ts withholds the action entirely rather than offering a dud.
export const NORMALIZED_QUERY_MIN_CHARS = 12;

// A path token: contains a separator AND a dot-extension. The conjunction is the
// point — it drops `src/widgets/thing.ts` while keeping `Array<string>`.
//
// The optional quote group + backreference matters: messages quote their paths
// ("Cannot find module './widgets/thing.ts'"), and the character class stops at
// the quote, so without this the removal would leave an empty '' behind. A
// separate empty-quote cleanup pass would be worse — it matches the closing and
// opening quotes of two ADJACENT quoted tokens ("'a' 'b'"). A backreference to a
// group that did not participate matches the empty string, so the unquoted
// Windows-path case still works.
const PATH_TOKEN = /(['"`])?(?:[A-Za-z]:)?[^\s'"`()]*[\\/][^\s'"`()]*\.[A-Za-z0-9]+\1?/g;

// `line 42`, `:17:9`, `(12,4)`.
const POSITION = /\bline \d+\b|:\d+:\d+|\(\d+,\s*\d+\)/g;

// Single quotes, double quotes and backticks — the three conventions in use.
const QUOTED = /(['"`])(?:(?!\1).)*\1/g;

function policyFor(source: string | undefined): QuotedTokenPolicy {
  if (source === undefined) return "keep";
  return QUOTED_TOKEN_POLICY[source.toLowerCase()] ?? "keep";
}

// Cut on a word boundary so the tail of the query is never half a token.
function clampOnWord(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trimEnd();
}

export function normalizeDiagnosticMessage(input: {
  message: string;
  source?: string;
  code?: string | number;
}): string {
  let text = input.message;
  // Paths first: a path can contain digits that POSITION would otherwise eat,
  // leaving a fragment behind instead of removing the whole token.
  text = text.replace(PATH_TOKEN, " ");
  text = text.replace(POSITION, " ");
  if (policyFor(input.source) === "drop") text = text.replace(QUOTED, " ");
  // Collapse last: every rule above leaves gaps behind.
  text = text.replace(/\s+/g, " ").trim();
  // Tidy the space a removed token leaves in front of its punctuation.
  text = text.replace(/\s+([.,;:])/g, "$1");

  const code = input.code === undefined ? "" : String(input.code).trim();
  const joined = code.length > 0 ? `${code} ${text}`.trim() : text;
  return clampOnWord(joined, NORMALIZED_QUERY_MAX_CHARS);
}
