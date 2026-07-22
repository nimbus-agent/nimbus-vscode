export interface ReviewCoverage {
  // Basename only — the absolute repo root is never displayed or sent.
  repoLabel: string;
  reviewed: readonly string[];
  omittedTooLarge: readonly string[];
  skippedSecret: readonly string[];
  // Binary files, pure renames, mode changes — nothing textual to review.
  nonTextual: readonly string[];
  // Content is never sent; named here so the user knows they were not reviewed.
  untracked: readonly string[];
}

export function buildReviewPrompt(diffBlock: string): string {
  return [
    "Review the following changes and report problems you are confident about.",
    "Structure the reply as: a one-paragraph summary, then findings grouped by file.",
    "Tag each finding with a severity of high, medium, or low. If there are no problems, say so plainly.",
    "",
    diffBlock,
  ].join("\n");
}

function section(title: string, paths: readonly string[]): string {
  if (paths.length === 0) return "";
  const quoted = paths.map((p) => `\`${p}\``).join(", ");
  return `\n**${title}:** ${quoted}\n`;
}

// The reply is never parsed — the shape instruction above exists so the tab
// reads the same every time. This header is ours, and it is the mechanism that
// stops a user assuming an untracked or skipped file was covered.
export function buildReviewDocument(coverage: ReviewCoverage, findings: string): string {
  const reviewed =
    coverage.reviewed.length > 0
      ? coverage.reviewed.map((p) => `\`${p}\``).join(", ")
      : "_nothing_";
  return [
    `# Nimbus review — ${coverage.repoLabel}`,
    "",
    `**Reviewed (${coverage.reviewed.length} file${coverage.reviewed.length === 1 ? "" : "s"}):** ${reviewed}`,
    section("Not reviewed — too large", coverage.omittedTooLarge),
    section("Not reviewed — possible secrets", coverage.skippedSecret),
    section("Not reviewed — binary or non-textual changes", coverage.nonTextual),
    section("Not reviewed — untracked", coverage.untracked),
    "",
    "---",
    "",
    findings,
    "",
  ].join("\n");
}
