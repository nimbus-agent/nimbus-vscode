import { clampContext, QUICK_ASK_MAX_CONTEXT_CHARS, redactPath } from "../quick-ask.js";
import type { AttachedFile, ParticipantRequest } from "./participant-types.js";

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

// Build the agent prompt for a FREE-FORM turn: the user text plus explicitly
// attached #file references. Slash commands never come through here — they are
// structured ops calls handled by ops-commands.ts, not prompt rewrites. Paths
// are always redacted and code is always clamped.
export function buildParticipantPrompt(req: ParticipantRequest): string {
  const userText = req.prompt.trim();
  const blocks = budgetedBlocks(req.attachments, PARTICIPANT_MAX_TOTAL_CONTEXT_CHARS);
  if (blocks.length === 0) return userText;
  return [userText, ...blocks].filter((s) => s.length > 0).join("\n\n");
}
