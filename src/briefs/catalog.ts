// The built-in briefs this extension surfaces, as data. One source of truth for
// the label, icon and command id, so the sidebar row, the editor menu entry and
// the egress manifest can never disagree about what a brief is called.
//
// PR 1 carried four; PR 3 adds `janitor`/`preflight`. `whyPeek` is a hover, not
// a row, and stays out of this catalog — see
// `git show edc2c81:docs/superpowers/specs/2026-08-10-built-in-briefs-design.md`.

export type BriefId = "why" | "ghost" | "conflicts" | "huddle" | "janitor" | "preflight";

/** What the caller must supply before the brief can run. */
export type BriefContext =
  /** agentsWhy — needs the file and the cursor line. */
  | "fileAndLine"
  /** agentsGhost / agentsConflicts — need the file only. */
  | "file"
  /** agentsHuddle — every parameter is optional. */
  | "none"
  /**
   * agentsJanitor / agentsPreflight — the caller supplies a resource ref or a
   * git ref plus a namespace. Neither is an editor path, so these prompt.
   */
  | "prompted";

export interface BriefSpec {
  readonly id: BriefId;
  /** Shown in the sidebar row, the editor menu, and the egress manifest action. */
  readonly label: string;
  /** A vscode ThemeIcon (codicon) id. */
  readonly iconId: string;
  readonly command: string;
  readonly context: BriefContext;
  /**
   * Whether this call routes through the egress gate. True for every entry: the
   * one ungated brief call, `whyPeek`, is synchronous, takes no timeoutMs, and
   * carries no `brief` string or AgentBriefBase, so it never reaches a model —
   * and it is a hover, not a row, so it is not in this catalog at all.
   */
  readonly gated: boolean;
}

// Builds one catalog row. The two fields every row shares are derived rather
// than spelled out six times, where one row could drift from the rest: the
// command is always `nimbus.brief.<id>` (the form briefs/commands.ts already
// uses in its log lines), and every catalog brief is gated (see `gated`).
function gatedBrief(id: BriefId, label: string, iconId: string, context: BriefContext): BriefSpec {
  return { id, label, iconId, command: `nimbus.brief.${id}`, context, gated: true };
}

export const BRIEF_CATALOG: readonly BriefSpec[] = [
  gatedBrief("why", "Why is this here?", "history", "fileAndLine"),
  gatedBrief("ghost", "Who knew this code?", "person", "file"),
  gatedBrief("conflicts", "Who else is touching this?", "git-merge", "file"),
  gatedBrief("huddle", "Team huddle", "organization", "none"),
  gatedBrief("janitor", "Is this idle?", "trash", "prompted"),
  gatedBrief("preflight", "Safe to deploy?", "rocket", "prompted"),
];

// Throws rather than returning undefined: every caller has a compile-time
// BriefId, so a miss here is a catalog bug, not a runtime condition to handle.
export function briefSpec(id: BriefId): BriefSpec {
  const spec = BRIEF_CATALOG.find((b) => b.id === id);
  if (spec === undefined) throw new Error(`unknown brief: ${id}`);
  return spec;
}

// Briefs whose parameters come from the editor, and which therefore belong in
// the editor context menu and are palette-gated on an open editor. The prompted
// briefs ask for everything they need, so gating them on an editor would hide
// them exactly when the sidebar or the palette is the entry point.
export function needsEditor(spec: BriefSpec): boolean {
  return spec.context === "file" || spec.context === "fileAndLine";
}
