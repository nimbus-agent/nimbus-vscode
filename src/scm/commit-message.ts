// How many log entries to fetch, and how many survivors to actually use. We over-
// fetch because the filter below can discard most of a bot-heavy log.
export const COMMIT_LOG_FETCH = 30;
export const COMMIT_STYLE_EXAMPLES = 10;

// Merges, release automation, and dependency bumps are not the human commit
// style we want the agent to imitate. In a Release-Please repo, unfiltered
// examples are mostly automation and the agent dutifully writes like a bot.
const EXCLUDED_SUBJECTS: readonly RegExp[] = [
  /^Merge (branch|pull request|remote|tag)\b/i,
  /^chore\(release\):/i,
  /^chore: release\b/i,
  /^Release v?\d/i,
  /^Bump\b/i,
  /^build\(deps\):/i,
  /^chore\(deps\):/i,
];

// Subject lines only (first line of each message), newest first, automation
// removed, capped at `limit`.
export function filterStyleExamples(messages: readonly string[], limit: number): string[] {
  const out: string[] = [];
  for (const message of messages) {
    const subject = (message.split("\n")[0] ?? "").trim();
    if (subject.length === 0) continue;
    if (EXCLUDED_SUBJECTS.some((re) => re.test(subject))) continue;
    out.push(subject);
    if (out.length === limit) break;
  }
  return out;
}

export function buildCommitPrompt(input: {
  diffBlock: string;
  examples: readonly string[];
}): string {
  // With examples the agent matches the repo's real style, whatever it is; with
  // none (a fresh repo, or an all-automation log) we fall back to a convention.
  const style =
    input.examples.length > 0
      ? `Match the style of these recent commit messages from this repository:\n${input.examples
          .map((e) => `- ${e}`)
          .join("\n")}`
      : "Follow the Conventional Commits format (e.g. `feat(scope): summary`).";
  return [
    "Write a commit message for the following staged changes.",
    style,
    "Keep the subject line under 72 characters. Add a short body only if the change needs explaining.",
    "Reply with the commit message only — no commentary, no code fences.",
    "",
    input.diffBlock,
  ].join("\n");
}

// Agents like to wrap the answer in a fence and introduce it — sometimes both
// at once ("Here's a commit message:\n\n```\n...\n```"), sometimes with
// commentary trailing the closing fence. Strip a preamble and a fence
// repeatedly (order-insensitive, bounded) until nothing more comes off, then
// trim trailing whitespace per line. A fenced block that isn't anchored to
// the end of the reply drops anything after its closing fence — same as
// `extractCode` elsewhere in this codebase, on the same assumption that a
// fenced reply's fence is the message and anything past it is commentary, not
// content. Deliberately no length enforcement: truncating a message mid-word
// is worse than a long one.
export function sanitizeCommitMessage(reply: string): string {
  let text = reply.trim();
  const preambleRe = /^(here(''|'|)s|here is)[^\n:]*:\s*\n+/i;
  const fenceRe = /^```[^\n]*\n([\s\S]*?)\n?```/;
  for (let i = 0; i < 5; i++) {
    const before = text;
    text = text.replace(preambleRe, "");
    const fenced = fenceRe.exec(text);
    if (fenced?.[1] !== undefined) text = fenced[1];
    if (text === before) break;
  }
  return text
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .join("\n")
    .trim();
}

export function composeInputBoxValue(
  existing: string,
  drafted: string,
  mode: "replace" | "append",
): string {
  if (mode === "replace") return drafted;
  const base = existing.replace(/\s+$/, "");
  if (base.length === 0) return drafted;
  // Running the command twice and appending the same draft again is never what
  // anyone wants, so an append that would duplicate is a no-op.
  if (base.includes(drafted)) return base;
  return `${base}\n\n${drafted}`;
}
