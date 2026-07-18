import { clampContext, QUICK_ASK_MAX_CONTEXT_CHARS, redactPath } from "../quick-ask.js";
import type { AttachedFile, ParticipantCommand, ParticipantRequest } from "./participant-types.js";

const COMMAND_TEMPLATES: Record<ParticipantCommand, string> = {
  explain: "Explain what the following code does, clearly and concisely.",
  fix: "Find and fix bugs or issues in the following code. Return the corrected code and a brief explanation of each change. Do not apply edits — just show the suggested code.",
  test: "Write focused unit tests for the following code, following the project's existing test framework and conventions.",
};

// A fenced code block headed by the redacted file path + language, clamped to the
// shared quick-ask size cap so a single turn can't ship an unbounded payload.
function codeBlock(file: AttachedFile): string {
  const { code, truncated } = clampContext(file.code, QUICK_ASK_MAX_CONTEXT_CHARS);
  const suffix = truncated ? " (truncated)" : "";
  const header = `File: ${redactPath(file.path)} (${file.languageId})${suffix}`;
  return `${header}\n\`\`\`${file.languageId}\n${code}\n\`\`\``;
}

// Build the agent prompt. Slash commands wrap the active selection in a
// command-specific instruction; free-form turns append only explicitly attached
// #file references. Paths are always redacted and code is always clamped.
export function buildParticipantPrompt(req: ParticipantRequest): string {
  const userText = req.prompt.trim();

  if (req.command !== undefined) {
    const instruction = COMMAND_TEMPLATES[req.command];
    const head = userText.length > 0 ? `${instruction}\n\n${userText}` : instruction;
    if (req.selection === undefined || req.selection.code.trim().length === 0) return head;
    return `${head}\n\n${codeBlock(req.selection)}`;
  }

  const blocks = req.attachments.filter((a) => a.code.trim().length > 0).map(codeBlock);
  if (blocks.length === 0) return userText;
  return [userText, ...blocks].filter((s) => s.length > 0).join("\n\n");
}
