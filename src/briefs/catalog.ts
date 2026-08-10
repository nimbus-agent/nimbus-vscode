// The built-in briefs this extension surfaces, as data. One source of truth for
// the label, icon and command id, so the sidebar row, the editor menu entry and
// the egress manifest can never disagree about what a brief is called.
//
// PR 1 carries four. `whyPeek` (PR 2) and `janitor`/`preflight` (PR 3) join
// later; see docs/superpowers/specs/2026-08-10-built-in-briefs-design.md.

export type BriefId = "why" | "ghost" | "conflicts" | "huddle";

/** What the caller must supply before the brief can run. */
export type BriefContext =
  /** agentsWhy — needs the file and the cursor line. */
  | "fileAndLine"
  /** agentsGhost / agentsConflicts — need the file only. */
  | "file"
  /** agentsHuddle — every parameter is optional. */
  | "none";

export interface BriefSpec {
  readonly id: BriefId;
  /** Shown in the sidebar row, the editor menu, and the egress manifest action. */
  readonly label: string;
  /** A vscode ThemeIcon (codicon) id. */
  readonly iconId: string;
  readonly command: string;
  readonly context: BriefContext;
  /**
   * Whether this call routes through the egress gate. True for every
   * model-composed brief. The one false entry will be `whyPeek` in PR 2: it is
   * synchronous, takes no timeoutMs, and carries no `brief` string or
   * AgentBriefBase, so it never reaches a model.
   */
  readonly gated: boolean;
}

export const BRIEF_CATALOG: readonly BriefSpec[] = [
  {
    id: "why",
    label: "Why is this here?",
    iconId: "history",
    command: "nimbus.brief.why",
    context: "fileAndLine",
    gated: true,
  },
  {
    id: "ghost",
    label: "Who knew this code?",
    iconId: "person",
    command: "nimbus.brief.ghost",
    context: "file",
    gated: true,
  },
  {
    id: "conflicts",
    label: "Who else is touching this?",
    iconId: "git-merge",
    command: "nimbus.brief.conflicts",
    context: "file",
    gated: true,
  },
  {
    id: "huddle",
    label: "Team huddle",
    iconId: "organization",
    command: "nimbus.brief.huddle",
    context: "none",
    gated: true,
  },
];

// Throws rather than returning undefined: every caller has a compile-time
// BriefId, so a miss here is a catalog bug, not a runtime condition to handle.
export function briefSpec(id: BriefId): BriefSpec {
  const spec = BRIEF_CATALOG.find((b) => b.id === id);
  if (spec === undefined) throw new Error(`unknown brief: ${id}`);
  return spec;
}
