import type { RankedSearchItem, WhyPeek } from "@nimbus-dev/client";

import { whyParams } from "../briefs/params.js";
import { peekFields } from "../briefs/peek.js";
import { errMsg } from "../logging.js";
import type { ContextSnapshot } from "./snapshot.js";

// The signals the panel reads, as DATA — the same shape BRIEF_CATALOG uses, so
// adding a fifth signal is one entry rather than an edit in four files. Four
// signals here: two local reads (problems, git) and two Gateway-backed (blame, related).

export type SignalId = "problems" | "git" | "blame" | "related";

// The heading a section carries, keyed by id. Read by every collector below
// AND by the controller's own loading/disconnected/error placeholders, so a
// renamed signal cannot leave one place saying "History" and another saying
// something else — there is exactly one copy, and both sides read it.
export const SECTION_TITLES: Record<SignalId, string> = {
  problems: "Problems",
  git: "Git",
  blame: "History",
  related: "Related",
};

// Likewise for the message shown when a Gateway-backed signal has no client
// to call: the two collectors below and the controller's own disconnected
// placeholder must agree on the exact wording, since a test on either side
// asserts it verbatim.
export const NEEDS_GATEWAY = "Needs the Nimbus Gateway.";

/**
 * The two Gateway calls this panel makes, and nothing else. A narrow structural
 * seam rather than the whole client: these modules stay pure and unit-testable,
 * and the surface a collector can reach is visible in one place. Both calls
 * reach no model — see the plan's Global Constraints.
 */
export interface ContextClientLike {
  agentsWhyPeek(p: { ref: string; line?: number }): Promise<WhyPeek>;
  searchRanked(params?: { name?: string; limit?: number }): Promise<readonly RankedSearchItem[]>;
}

export interface SignalDeps {
  /** Undefined while disconnected; Gateway-backed collectors then sit out. */
  readonly client: () => ContextClientLike | undefined;
  readonly now: () => number;
  readonly searchLimit: () => number;
}

export interface SignalRow {
  readonly label: string;
  readonly detail?: string;
  readonly iconId?: string;
}

export interface SignalSection {
  readonly id: SignalId;
  readonly title: string;
  readonly rows: readonly SignalRow[];
  /** Shown instead of rows when there are none. Absent when rows is non-empty. */
  readonly empty?: string;
  /** True while a Gateway-backed collector is still in flight. */
  readonly loading?: boolean;
  /**
   * True when this section is an error the collector recovered from rather
   * than a real answer — e.g. a dropped RPC. The controller must not cache a
   * transient section: a caught Gateway hiccup would otherwise pin itself
   * into that key forever, since the collectors resolve rather than reject.
   */
  readonly transient?: boolean;
}

// Errors and warnings only. Information and Hint are excluded for the same
// reason the lightbulb never offers them: they are not problems the user asked
// for help with.
const WARNING = 1;

export async function problemsSection(
  snapshot: ContextSnapshot,
  _deps: SignalDeps,
): Promise<SignalSection> {
  const base = { id: "problems" as const, title: SECTION_TITLES.problems };
  if (snapshot.path === undefined) return { ...base, rows: [], empty: "No file open." };
  const rows = snapshot.diagnostics
    .filter((d) => d.severity <= WARNING)
    .slice()
    .sort((a, b) => a.line - b.line)
    // Lines are zero-based inside the extension and one-based everywhere a
    // human reads them, gutters included.
    .map((d) => ({
      label: `Line ${d.line + 1}: ${d.message}`,
      iconId: d.severity === 0 ? "error" : "warning",
    }));
  if (rows.length === 0) return { ...base, rows, empty: "No errors or warnings in this file." };
  return { ...base, rows };
}

export async function gitSection(
  snapshot: ContextSnapshot,
  _deps: SignalDeps,
): Promise<SignalSection> {
  const base = { id: "git" as const, title: SECTION_TITLES.git };
  const git = snapshot.git;
  if (git === undefined) return { ...base, rows: [], empty: "No git repository here." };
  const rows: SignalRow[] = [{ label: git.branch ?? "Detached HEAD", iconId: "git-branch" }];
  // Only when the collector actually looked AND has something to report. An
  // unread changedPaths renders no row: "0 changed files" beside a correct
  // branch name is a statement the panel has not earned. A read that found
  // nothing renders no row either — the branch row already shows the section
  // looked, and a zero is noise on the majority of ticks.
  const changed = git.changedPaths;
  if (changed !== undefined && changed.length > 0) {
    rows.push({
      label: `${changed.length} changed ${changed.length === 1 ? "file" : "files"}`,
      iconId: "diff",
    });
  }
  return { ...base, rows };
}

// Blame for the cursor line. This call reaches no model — it is a synchronous
// git-and-index lookup — which is why it is safe on every cursor rest and why
// it is the documented exemption from the egress gate.
export async function blameSection(
  snapshot: ContextSnapshot,
  deps: SignalDeps,
): Promise<SignalSection> {
  const base = { id: "blame" as const, title: SECTION_TITLES.blame };
  if (snapshot.path === undefined || snapshot.line === undefined) {
    return { ...base, rows: [], empty: "No file open." };
  }
  const client = deps.client();
  // transient: "no Gateway" is a fact about right now, not about this line.
  // The controller normally short-circuits a Gateway-backed signal while
  // disconnected, so this branch is the race — the socket dropping between
  // that check and this call — and caching it would pin the placeholder to
  // this key.
  if (client === undefined) return { ...base, rows: [], empty: NEEDS_GATEWAY, transient: true };
  try {
    // Through whyParams — NOT the raw snapshot line. snapshot.line is
    // zero-based (VS Code's convention) and this parameter is one-based,
    // verified against a live Gateway; see toOneBased in ../briefs/params.ts.
    // Passing the snapshot value straight through describes the line ABOVE the
    // cursor, and would put this section at odds with both the hover and the
    // panel's own offers.
    const peek = await client.agentsWhyPeek(whyParams({ ref: snapshot.path, line: snapshot.line }));
    const fields = peekFields(peek, deps.now());
    if (fields === undefined) {
      return {
        ...base,
        rows: [],
        empty: "No history for this line yet — has `nimbus init` indexed this repo?",
      };
    }
    const head = [fields.author, fields.relativeTime, fields.shortSha].filter(
      (part): part is string => part !== undefined,
    );
    const rows: SignalRow[] = [];
    if (head.length > 0) rows.push({ label: head.join(" · "), iconId: "person" });
    if (fields.commitSubject !== undefined) {
      rows.push({ label: fields.commitSubject, iconId: "git-commit" });
    }
    // Labels only, no links: this panel's renderer emits text nodes, and adding
    // anchors would widen what the webview may contain for one row.
    if (fields.pr !== undefined) rows.push({ label: fields.pr.label, iconId: "git-pull-request" });
    if (fields.ticket !== undefined) rows.push({ label: fields.ticket.label, iconId: "tag" });
    return { ...base, rows };
  } catch (e: unknown) {
    // transient: a dropped RPC is worth retrying on the next visit to this
    // line, not pinning into the cache as if it were a real answer.
    return {
      ...base,
      rows: [{ label: `Blame unavailable: ${errMsg(e)}`, iconId: "error" }],
      transient: true,
    };
  }
}

// Ranked neighbours from the LOCAL index. Reaches no model, exactly as Find
// related and the diagnostics' prior-occurrences search do; it still needs the
// Gateway socket, and is only ever as good as what has been indexed.
export async function relatedSection(
  snapshot: ContextSnapshot,
  deps: SignalDeps,
): Promise<SignalSection> {
  const base = { id: "related" as const, title: SECTION_TITLES.related };
  const query = snapshot.selection ?? snapshot.path;
  if (query === undefined) return { ...base, rows: [], empty: "No file open." };
  const client = deps.client();
  // transient: see blameSection's — a dropped socket is not this file's answer.
  if (client === undefined) return { ...base, rows: [], empty: NEEDS_GATEWAY, transient: true };
  try {
    const items = await client.searchRanked({ name: query, limit: deps.searchLimit() });
    // The file an item came from, when the Gateway recorded one. Typed as
    // unknown because rawMeta is Record<string, unknown> — an index that
    // stores something other than a string here must not throw.
    const fileOf = (i: (typeof items)[number]): string | undefined => {
      const raw = i.rawMeta?.["file"];
      return typeof raw === "string" ? raw : undefined;
    };
    // rawMeta.file is REPO-root-relative; snapshot.path is WORKSPACE-root-
    // relative. They coincide when the workspace is the repo root and diverge
    // otherwise (a git worktree, a monorepo package opened as a subfolder).
    // Comparing both exactly — rather than suffix-matching one against the
    // other — is the whole fix: a suffix match also matches two genuinely
    // different files that merely share a directory-boundary-aligned tail
    // (e.g. "src/index.ts" against "packages/service-b/src/index.ts" in a
    // monorepo with parallel package layouts), wrongly dropping an unrelated
    // result. snapshot.repoPath is the file's path under the SAME root
    // rawMeta.file uses, computed once at snapshot-build time from the
    // repository that contains the file — see real-context-view.ts.
    const seen = new Set<string>();
    const rows: SignalRow[] = [];
    for (const i of items) {
      const file = fileOf(i);
      // Self-exclusion, the version that actually fires. An item's `name` is a
      // SYMBOL name ("runOpsCommand (function)"), never a repo-relative path,
      // so the old `i.name !== snapshot.path` rule never matched anything and
      // the panel filled with the open file's own symbols. rawMeta.file is the
      // field that carries the path, compared against both projections of the
      // open file since either can be the one the index used. The name
      // comparison stays as a second rule for services that key an item by
      // its path.
      if (file !== undefined && (file === snapshot.repoPath || file === snapshot.path)) continue;
      if (i.name === snapshot.path) continue;
      // The index can hold several rows for one symbol (a re-index that did not
      // supersede the old row, a duplicate chunk). Three identical rows waste
      // the section; one row per (name, file) does not.
      //
      // The fallback for an item with no file is its SERVICE, not "". The index
      // really does return same-named rows with no file — five github_actions
      // rows for one commit's re-runs, differing only by run id — and
      // collapsing those is the point. An empty fallback would also collapse a
      // Jira ticket and a Slack message that happen to share a title, which are
      // different things the user needs to see separately.
      //
      // "\u0000" as the separator, written as an escape and never as a raw
      // byte: a name containing the separator must not be able to collide with
      // a different (name, file) pair.
      const key = `${i.name}\u0000${file ?? i.service}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({
        label: i.name,
        ...(i.service.length > 0 ? { detail: i.service } : {}),
        iconId: "file",
      });
    }
    if (rows.length === 0) {
      // Says what is true after the exclusion above: the index may well hold
      // this file, just nothing ELSE that ranks against it.
      return { ...base, rows, empty: "Nothing else in the local index looks related." };
    }
    return { ...base, rows };
  } catch (e: unknown) {
    // transient: see blameSection's catch — a dropped RPC should be retried,
    // not remembered as this line's answer.
    return {
      ...base,
      rows: [{ label: `Search unavailable: ${errMsg(e)}`, iconId: "error" }],
      transient: true,
    };
  }
}

// No title here on purpose: both the collector's own section and the
// controller's loading/disconnected/error placeholders read the same
// SECTION_TITLES entry above, so a title on the spec would be a third copy
// nothing reads.
export interface SignalSpec {
  readonly id: SignalId;
  /** Whether collecting this signal needs the Gateway socket. */
  readonly needsGateway: boolean;
  readonly collect: (snapshot: ContextSnapshot, deps: SignalDeps) => Promise<SignalSection>;
  /**
   * What a cached result for this snapshot would be keyed on, or undefined when
   * the signal is not worth caching. Local reads return undefined: they cost
   * nothing, and a cache would only add a way to be stale.
   */
  readonly cacheKey: (snapshot: ContextSnapshot) => string | undefined;
}

export const SIGNAL_CATALOG: readonly SignalSpec[] = [
  { id: "problems", needsGateway: false, collect: problemsSection, cacheKey: () => undefined },
  { id: "git", needsGateway: false, collect: gitSection, cacheKey: () => undefined },
  {
    id: "blame",
    needsGateway: true,
    collect: blameSection,
    // Keyed on the line, so moving WITHIN a line — or scrolling, which fires no
    // cursor event at all — costs nothing.
    cacheKey: (s) =>
      s.path === undefined || s.line === undefined ? undefined : `${s.path}:${s.line}`,
  },
  {
    id: "related",
    needsGateway: true,
    collect: relatedSection,
    // Keyed on the path AND the query, so it is one call per (file, selection)
    // pair rather than one per keystroke — and so two different files with the
    // same selected text never share a cache entry, which would leave the
    // wrong file un-excluded from its own results (relatedSection excludes a
    // row by comparing it to snapshot.path). The selection is already clamped
    // to 300 chars in the snapshot, so this key is bounded. No path at all
    // (no file open) leaves this uncached: cheap, and there is nothing to key
    // it on.
    cacheKey: (s) => (s.path === undefined ? undefined : `${s.path}:${s.selection ?? ""}`),
  },
];
