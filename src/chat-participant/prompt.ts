import { clampContext, QUICK_ASK_MAX_CONTEXT_CHARS, redactPath } from "../quick-ask.js";
import type { AttachedFile, ParticipantCommand, ParticipantRequest } from "./participant-types.js";

const COMMAND_TEMPLATES: Record<ParticipantCommand, string> = {
  explain: "Explain what the following code does, clearly and concisely.",
  fix: "Find and fix bugs or issues in the following code. Return the corrected code and a brief explanation of each change. Do not apply edits — just show the suggested code.",
  test: "Write focused unit tests for the following code, following the project's existing test framework and conventions.",
};

// Total code-content budget for a single turn, shared across every
// attachment/selection block — bounds the TOTAL payload regardless of how many
// files are attached (a single file is still clamped per-file below this cap).
export const PARTICIPANT_MAX_TOTAL_CONTEXT_CHARS = QUICK_ASK_MAX_CONTEXT_CHARS;

// Render fenced, path-redacted code blocks for `files` against a shared running
// budget: each file is clamped to whatever remains (never more than the
// per-file cap), and once the budget is exhausted no further blocks are added.
function budgetedBlocks(files: AttachedFile[], totalBudget: number): string[] {
  const blocks: string[] = [];
  let remaining = totalBudget;
  for (const file of files) {
    if (file.code.trim().length === 0) continue;
    if (remaining <= 0) break;
    const { code, truncated } = clampContext(
      file.code,
      Math.min(remaining, QUICK_ASK_MAX_CONTEXT_CHARS),
    );
    if (code.trim().length === 0) continue;
    remaining -= code.length;
    const suffix = truncated ? " (truncated)" : "";
    const header = `File: ${redactPath(file.path)} (${file.languageId})${suffix}`;
    blocks.push(`${header}\n\`\`\`${file.languageId}\n${code}\n\`\`\``);
  }
  return blocks;
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
    const selectionBlocks = budgetedBlocks([req.selection], PARTICIPANT_MAX_TOTAL_CONTEXT_CHARS);
    if (selectionBlocks.length === 0) return head;
    return `${head}\n\n${selectionBlocks[0]}`;
  }

  const blocks = budgetedBlocks(req.attachments, PARTICIPANT_MAX_TOTAL_CONTEXT_CHARS);
  if (blocks.length === 0) return userText;
  return [userText, ...blocks].filter((s) => s.length > 0).join("\n\n");
}
