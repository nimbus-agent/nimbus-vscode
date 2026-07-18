import { asRecord } from "./sidebar/parse-helpers.js";

// Max characters of code context attached to a quick-ask prompt. Whole-file
// context on a large/minified file is clamped to this so a one-shot agentInvoke
// call is not overloaded; selections are usually far smaller.
export const QUICK_ASK_MAX_CONTEXT_CHARS = 50_000;

// Clamp code context to `max` chars, reporting whether truncation happened so
// the caller can warn the user.
export function clampContext(code: string, max: number): { code: string; truncated: boolean } {
  if (code.length <= max) return { code, truncated: false };
  return { code: code.slice(0, max), truncated: true };
}

// Build the one-shot quick-ask prompt: the question, then — when code is present
// — a fenced block labelled with the file path and language. Blank code yields
// the question alone; `truncated` marks the header when the context was clamped.
export function buildQuickAskPrompt(input: {
  question: string;
  code: string;
  filePath: string;
  languageId: string;
  truncated?: boolean;
}): string {
  const question = input.question.trim();
  // Preserve the code verbatim (leading indentation matters for Python and
  // nested snippets); trim only to decide whether any code is present.
  const code = input.code;
  if (code.trim().length === 0) return question;
  const suffix = input.truncated === true ? " (truncated)" : "";
  const header = `File: ${input.filePath} (${input.languageId})${suffix}`;
  return `${question}\n\n${header}\n\`\`\`${input.languageId}\n${code}\n\`\`\``;
}

// Reduce a file path to its basename so a quick-ask prompt does not leak the
// absolute local path — which includes the OS username and directory layout —
// into the agent context or the egress ledger. Handles POSIX and Windows
// separators; falls back to the input if there is no separator.
export function redactPath(filePath: string): string {
  const segments = filePath.split(/[\\/]/);
  return segments.at(-1) ?? filePath;
}

// Extract the reply from an agentInvoke result ({ reply?: string } & Record<...>).
// Returns a trimmed non-empty reply, else undefined (missing/non-string/blank).
export function extractReply(result: unknown): string | undefined {
  const rec = asRecord(result);
  const reply = rec?.["reply"];
  if (typeof reply !== "string") return undefined;
  const trimmed = reply.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

// Validate a quick-ask question for the input box: an error message for a
// blank/whitespace-only question, or undefined when acceptable. Used both as the
// input box's validateInput and the handler's post-return guard.
export function validateQuestion(value: string): string | undefined {
  return value.trim().length === 0 ? "Please enter a question" : undefined;
}
