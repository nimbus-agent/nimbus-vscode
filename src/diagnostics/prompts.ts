import type { DiagnosticContext } from "./context.js";

// "line 10" or "lines 10-14" — an agent reading the fenced snippet needs to know
// which part of it the diagnostic is actually about.
function where(ctx: DiagnosticContext): string {
  return ctx.startLine === ctx.endLine
    ? `line ${ctx.startLine}`
    : `lines ${ctx.startLine}-${ctx.endLine}`;
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
    // The reply is spliced back into the document at the diagnostic's range, so
    // it must be the replacement for THAT region and nothing else. "No prose"
    // keeps extractCode's job unambiguous.
    "Reply with the replacement for the flagged region only, as a single fenced code block. No prose, no explanation, no surrounding lines.",
    "",
    block(ctx),
  ].join("\n");
}
