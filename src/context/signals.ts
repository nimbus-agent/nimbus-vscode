import type { RankedSearchItem, WhyPeek } from "@nimbus-dev/client";

import { peekFields } from "../briefs/peek.js";
import { errMsg } from "../logging.js";
import type { ContextSnapshot } from "./snapshot.js";

// The signals the panel reads, as DATA — the same shape BRIEF_CATALOG uses, so
// adding a fifth signal is one entry rather than an edit in four files. Both
// entries here are local reads; the two Gateway-backed signals arrive in PR 2.

export type SignalId = "problems" | "git" | "blame";

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
}

// Errors and warnings only. Information and Hint are excluded for the same
// reason the lightbulb never offers them: they are not problems the user asked
// for help with.
const WARNING = 1;

export async function problemsSection(
  snapshot: ContextSnapshot,
  _deps: SignalDeps,
): Promise<SignalSection> {
  const base = { id: "problems" as const, title: "Problems" };
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
  const base = { id: "git" as const, title: "Git" };
  const git = snapshot.git;
  if (git === undefined) return { ...base, rows: [], empty: "No git repository here." };
  const rows: SignalRow[] = [{ label: git.branch ?? "Detached HEAD", iconId: "git-branch" }];
  // Only when the collector actually looked. An unread changedPaths renders no
  // row at all: "0 changed files" beside a correct branch name is a statement
  // the panel has not earned, and it would be wrong for most users.
  const changed = git.changedPaths;
  if (changed !== undefined) {
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
  const base = { id: "blame" as const, title: "History" };
  if (snapshot.path === undefined || snapshot.line === undefined) {
    return { ...base, rows: [], empty: "No file open." };
  }
  const client = deps.client();
  if (client === undefined) return { ...base, rows: [], empty: "Needs the Nimbus Gateway." };
  try {
    const peek = await client.agentsWhyPeek({ ref: snapshot.path, line: snapshot.line });
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
    return { ...base, rows: [{ label: `Blame unavailable: ${errMsg(e)}`, iconId: "error" }] };
  }
}

// No title here on purpose: the rendered heading comes from the section each
// collector returns, so a title on the spec would be a second copy nothing reads.
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
];
