import type { DiagnosticLike } from "./context.js";
import { NORMALIZED_QUERY_MIN_CHARS, normalizeDiagnosticMessage } from "./normalize.js";

export const DIAGNOSTIC_COMMANDS = {
  explain: "nimbus.diagnosticExplain",
  fix: "nimbus.diagnosticFix",
  priorOccurrences: "nimbus.diagnosticPriorOccurrences",
} as const;

export type DiagnosticActionId = "explain" | "fix" | "priorOccurrences";

export interface DiagnosticActionDescriptor {
  id: DiagnosticActionId;
  commandId: string;
  title: string;
  /** Namespaced under `quickfix` so Ctrl+. reaches it; see the spec, Part 1. */
  kind: string;
  /**
   * Always false, and typed as the literal so it cannot drift. Auto Fix
   * (Shift+Alt+.) considers ONLY preferred actions, and a keystroke pressed to
   * tidy lint must never fire a gated model call.
   */
  isPreferred: false;
}

// Errors and warnings only. Information and Hint are where formatters and
// spell-checkers live; a lightbulb on every one of them would read as spam.
function isOffered(d: DiagnosticLike): boolean {
  return d.severity === 0 || d.severity === 1;
}

function rangeSpan(d: DiagnosticLike): number {
  const lines = d.range.end.line - d.range.start.line;
  return lines > 0 ? lines * 10_000 : d.range.end.character - d.range.start.character;
}

// A line commonly carries several diagnostics. Offering three actions for each
// would put six to nine Nimbus entries in one lightbulb, which is noise rather
// than offering — so exactly one diagnostic is chosen, by a total order that is
// stable across the repeated provideCodeActions calls VS Code makes.
//
// CONTRACT: returns one of the objects it was given, BY REFERENCE, never a
// copy. real-provider.ts recovers the underlying vscode.Diagnostic with
// `likes.indexOf(chosen)`; a clone would silently break the association between
// each action and its squiggle. Pinned by "returns the SAME OBJECT it was
// given" in test/unit/diagnostics-actions.test.ts.
export function selectDiagnostic(
  diagnostics: readonly DiagnosticLike[],
): DiagnosticLike | undefined {
  const offered = diagnostics.filter(isOffered);
  if (offered.length === 0) return undefined;
  return offered.reduce((best, next) => {
    if (next.severity !== best.severity) return next.severity < best.severity ? next : best;
    // Strictly less-than keeps the earlier one on a full tie, so the supplied
    // order is the last tie-break.
    return rangeSpan(next) < rangeSpan(best) ? next : best;
  });
}

const TITLES: Record<DiagnosticActionId, string> = {
  explain: "Nimbus: Explain this problem",
  fix: "Nimbus: Suggest a fix",
  priorOccurrences: "Nimbus: Find prior occurrences",
};

const KINDS: Record<DiagnosticActionId, string> = {
  explain: "quickfix.nimbus.explain",
  fix: "quickfix.nimbus.fix",
  priorOccurrences: "quickfix.nimbus.priorOccurrences",
};

export function diagnosticActionsFor(input: {
  diagnostics: readonly DiagnosticLike[];
  /** False while the Gateway socket is down — ALL three actions need it. */
  connected: boolean;
  /** nimbus.diagnostics.showCodeActions */
  enabled: boolean;
}):
  | { diagnostic: DiagnosticLike; query: string; actions: readonly DiagnosticActionDescriptor[] }
  | undefined {
  if (!input.enabled || !input.connected) return undefined;
  const diagnostic = selectDiagnostic(input.diagnostics);
  if (diagnostic === undefined) return undefined;

  const query = normalizeDiagnosticMessage(diagnostic);
  const ids: DiagnosticActionId[] = ["explain", "fix"];
  // A query too short to be useful would return noise; withholding the entry
  // beats offering a reliable dud.
  if (query.length >= NORMALIZED_QUERY_MIN_CHARS) ids.push("priorOccurrences");

  // Only disambiguate when there was something to disambiguate from.
  const contested = input.diagnostics.filter(isOffered).length > 1;
  const code = diagnostic.code === undefined ? "" : String(diagnostic.code);
  const suffix = contested && code.length > 0 ? ` (${code})` : "";

  return {
    diagnostic,
    query,
    actions: ids.map((id) => ({
      id,
      commandId: DIAGNOSTIC_COMMANDS[id],
      title: `${TITLES[id]}${suffix}`,
      kind: KINDS[id],
      isPreferred: false,
    })),
  };
}
