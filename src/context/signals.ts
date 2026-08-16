import type { ContextSnapshot } from "./snapshot.js";

// The signals the panel reads, as DATA — the same shape BRIEF_CATALOG uses, so
// adding a fifth signal is one entry rather than an edit in four files. Both
// entries here are local reads; the two Gateway-backed signals arrive in PR 2.

export type SignalId = "problems" | "git";

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
}

// Errors and warnings only. Information and Hint are excluded for the same
// reason the lightbulb never offers them: they are not problems the user asked
// for help with.
const WARNING = 1;

export function problemsSection(snapshot: ContextSnapshot): SignalSection {
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

export function gitSection(snapshot: ContextSnapshot): SignalSection {
  const base = { id: "git" as const, title: "Git" };
  const git = snapshot.git;
  if (git === undefined) return { ...base, rows: [], empty: "No git repository here." };
  const count = git.changedPaths.length;
  return {
    ...base,
    rows: [
      { label: git.branch ?? "Detached HEAD", iconId: "git-branch" },
      { label: `${count} changed ${count === 1 ? "file" : "files"}`, iconId: "diff" },
    ],
  };
}

export interface SignalSpec {
  readonly id: SignalId;
  readonly title: string;
  /** Whether collecting this signal needs the Gateway socket. */
  readonly needsGateway: boolean;
  readonly collect: (snapshot: ContextSnapshot) => SignalSection;
}

export const SIGNAL_CATALOG: readonly SignalSpec[] = [
  { id: "problems", title: "Problems", needsGateway: false, collect: problemsSection },
  { id: "git", title: "Git", needsGateway: false, collect: gitSection },
];
