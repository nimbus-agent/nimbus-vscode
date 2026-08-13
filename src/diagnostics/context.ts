import { clampContext, QUICK_ASK_MAX_CONTEXT_CHARS, redactPath } from "../quick-ask.js";

// Lines of surrounding code sent either side of the diagnostic. Enough for an
// agent to see the enclosing function in ordinary code; the character clamp
// below is what protects us from a minified file where that is the whole bundle.
export const DIAGNOSTIC_CONTEXT_LINES = 20;

export interface PositionLike {
  line: number;
  character: number;
}

// The subset of vscode.Diagnostic this feature reads. Declared structurally so
// every pure module here stays free of `vscode`. `severity` is VS Code's
// numbering: 0 Error, 1 Warning, 2 Information, 3 Hint.
export interface DiagnosticLike {
  message: string;
  severity: number;
  source?: string;
  code?: string | number;
  range: { start: PositionLike; end: PositionLike };
}

export interface DiagnosticContext {
  /** Redacted to a basename — never the directory. */
  fileName: string;
  languageId: string;
  message: string;
  severityLabel: "error" | "warning";
  /** "" when the diagnostic carries none. */
  source: string;
  /** "" when the diagnostic carries none. */
  code: string;
  /** 1-based, for display and for the egress manifest. */
  startLine: number;
  endLine: number;
  snippet: string;
  truncated: boolean;
  /** Character offsets into the FULL document, for splicing a fix back in. */
  offsets: { start: number; end: number };
}

// Offset each line starts at. Built by scanning for "\n", so a "\r" belongs to
// the end of its line and CRLF documents line up with vscode's offsetAt.
export function lineStartOffsets(text: string): readonly number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") starts.push(i + 1);
  }
  return starts;
}

function offsetOf(starts: readonly number[], pos: PositionLike, textLength: number): number {
  const line = Math.min(Math.max(pos.line, 0), starts.length - 1);
  const start = starts[line] ?? 0;
  return Math.min(start + Math.max(pos.character, 0), textLength);
}

export function buildDiagnosticContext(input: {
  fullText: string;
  fileName: string;
  languageId: string;
  diagnostic: DiagnosticLike;
}): DiagnosticContext {
  const { fullText, diagnostic } = input;
  const starts = lineStartOffsets(fullText);
  const lastLine = starts.length - 1;

  const first = Math.max(diagnostic.range.start.line - DIAGNOSTIC_CONTEXT_LINES, 0);
  const last = Math.min(diagnostic.range.end.line + DIAGNOSTIC_CONTEXT_LINES, lastLine);
  const from = starts[first] ?? 0;
  // Everything up to the start of the line after `last` — minus its newline.
  const to = last >= lastLine ? fullText.length : (starts[last + 1] ?? fullText.length) - 1;

  // The same helper and the same budget the SCM trio uses, rather than a second
  // differently-tuned number. At 41 lines this effectively never fires; it is a
  // backstop for a minified file, and reusing it keeps the wording uniform.
  const { code: snippet, truncated } = clampContext(
    fullText.slice(from, Math.max(to, from)),
    QUICK_ASK_MAX_CONTEXT_CHARS,
  );

  return {
    fileName: redactPath(input.fileName),
    languageId: input.languageId,
    message: diagnostic.message,
    severityLabel: diagnostic.severity === 0 ? "error" : "warning",
    source: diagnostic.source ?? "",
    code: diagnostic.code === undefined ? "" : String(diagnostic.code),
    startLine: diagnostic.range.start.line + 1,
    endLine: diagnostic.range.end.line + 1,
    snippet,
    truncated,
    offsets: {
      start: offsetOf(starts, diagnostic.range.start, fullText.length),
      end: offsetOf(starts, diagnostic.range.end, fullText.length),
    },
  };
}
