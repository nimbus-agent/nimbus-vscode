import { clampOnWord, NORMALIZED_QUERY_MAX_CHARS } from "../diagnostics/normalize.js";

// What is on screen, as plain data. No I/O and no vscode types: the caller
// reads the editor, this module decides what the context IS.

/**
 * Selection is bound for the LOCAL INDEX, not for a model, so it takes the
 * index-query limit rather than the 50 000-char model-context one. Reusing the
 * diagnostics limit keeps one number for "text we turn into a search".
 */
export const SELECTION_MAX_CHARS = NORMALIZED_QUERY_MAX_CHARS;

export interface DiagnosticSummary {
  readonly message: string;
  /** vscode.DiagnosticSeverity: Error=0, Warning=1, Information=2, Hint=3. */
  readonly severity: number;
  /** Zero-based, as VS Code reports it. */
  readonly line: number;
}

export interface GitSummary {
  /** Undefined on a detached HEAD, or before the git extension resolves state. */
  readonly branch: string | undefined;
  /**
   * Repo-relative, as git reports them — safe to display. Undefined when the
   * collector did not look: the panel then says nothing about changed files
   * rather than claiming there are none. PR 1's collector never looks; PR 2's
   * async collection path fills this in.
   */
  readonly changedPaths: readonly string[] | undefined;
}

export interface EditorInput {
  /** Already relative — the output of toRelativeRef. Never absolute. */
  readonly path: string;
  readonly scheme: string;
  readonly languageId: string;
  /** Zero-based cursor line. */
  readonly line: number;
  readonly selection: string;
  readonly isDirty: boolean;
}

export interface SnapshotInput {
  readonly generation: number;
  readonly editor?: EditorInput;
  readonly git?: GitSummary;
  readonly diagnostics?: readonly DiagnosticSummary[];
}

export interface ContextSnapshot {
  /**
   * Vestigial as of PR 2: the controller (controller.ts) now owns the
   * generation counter and stamps it itself once a snapshot reaches
   * controller.collect(), so this field is never read for fencing — see
   * real-context-view.ts's collect(), which always passes 0 here.
   */
  readonly generation: number;
  readonly path: string | undefined;
  readonly languageId: string | undefined;
  readonly line: number | undefined;
  /** Already clamped to SELECTION_MAX_CHARS. Undefined when nothing is selected. */
  readonly selection: string | undefined;
  readonly isDirty: boolean;
  readonly git: GitSummary | undefined;
  readonly diagnostics: readonly DiagnosticSummary[];
}

export function buildSnapshot(input: SnapshotInput): ContextSnapshot {
  // Non-file schemes — output panes, settings, untitled buffers, our own
  // read-only reply tabs — carry no repo-grounded context, so they are treated
  // as no editor at all. Mirrors the `{ scheme: "file" }` selector the
  // diagnostic code-action provider uses.
  const editor = input.editor?.scheme === "file" ? input.editor : undefined;
  const selection =
    editor === undefined ? "" : clampOnWord(editor.selection.trim(), SELECTION_MAX_CHARS);
  return {
    generation: input.generation,
    path: editor?.path,
    languageId: editor?.languageId,
    line: editor?.line,
    selection: selection.length > 0 ? selection : undefined,
    isDirty: editor?.isDirty ?? false,
    git: input.git,
    diagnostics: input.diagnostics ?? [],
  };
}
