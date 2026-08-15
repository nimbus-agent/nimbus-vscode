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
  {
    id: "janitor",
    label: "Is this idle?",
    iconId: "trash",
    command: "nimbus.brief.janitor",
    context: "prompted",
    gated: true,
  },
  {
    id: "preflight",
    label: "Safe to deploy?",
    iconId: "rocket",
    command: "nimbus.brief.preflight",
    context: "prompted",
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

// Briefs whose parameters come from the editor, and which therefore belong in
// the editor context menu and are palette-gated on an open editor. The prompted
// briefs ask for everything they need, so gating them on an editor would hide
// them exactly when the sidebar or the palette is the entry point.
export function needsEditor(spec: BriefSpec): boolean {
  return spec.context === "file" || spec.context === "fileAndLine";
}
