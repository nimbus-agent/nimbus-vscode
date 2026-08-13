import type { DiagnosticContext } from "./context.js";

// "line 10" or "lines 10-14" — an agent reading the fenced snippet needs to know
// which part of it the diagnostic is actually about.
function where(ctx: DiagnosticContext): string {
  return ctx.startLine === ctx.endLine
    ? `line ${ctx.startLine}`
    : `lines ${ctx.startLine}-${ctx.endLine}`;
}

// Spells out what "the whole of line 10" / "the whole of lines 10-14" means in
// the reply, since the splice replaces those lines entirely and a reply sized to
// the flagged expression would leave the rest of the line behind.
function scope(ctx: DiagnosticContext): string {
  return ctx.startLine === ctx.endLine
    ? "the entire line, not just the flagged expression"
    : "every one of those lines in full, not just the flagged expression";
}

// "(ts 2532)" — omitted entirely when the diagnostic carries neither, so the
// prompt never contains an empty pair of brackets.
function origin(ctx: DiagnosticContext): string {
  const parts = [ctx.source, ctx.code].filter((p) => p.length > 0);
  return parts.length > 0 ? ` (${parts.join(" ")})` : "";
}

function block(ctx: DiagnosticContext): string {
  const suffix = ctx.truncated ? " (truncated)" : "";
  return `File: ${ctx.fileName} (${ctx.languageId})${suffix}\n\`\`\`${ctx.languageId}\n${ctx.snippet}\n\`\`\``;
}

export function buildExplainPrompt(ctx: DiagnosticContext): string {
  return [
    `Explain this ${ctx.severityLabel} reported at ${where(ctx)} of ${ctx.fileName}${origin(ctx)}:`,
    ctx.message,
    "",
    "Say what causes it and how it is usually resolved. Be concise.",
    "",
    block(ctx),
  ].join("\n");
}

export function buildFixPrompt(ctx: DiagnosticContext): string {
  return [
    `Fix this ${ctx.severityLabel} at ${where(ctx)} of ${ctx.fileName}${origin(ctx)}:`,
    ctx.message,
    "",
    // The reply is spliced in over WHOLE LINES (context.ts expands the
    // diagnostic's range to line boundaries for exactly this reason), so the
    // prompt has to name those lines and ask for all of them. Asking for "the
    // flagged region" instead would invite a reply sized to a sub-expression
    // while the splice consumed the whole line. "No prose" keeps extractCode's
    // job unambiguous.
    `Reply with the replacement for the whole of ${where(ctx)}, as a single fenced code block: ${scope(ctx)}, indented as it should appear in the file, and nothing outside it. No prose, no explanation.`,
    "",
    block(ctx),
  ].join("\n");
}
