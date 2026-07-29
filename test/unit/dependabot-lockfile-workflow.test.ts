import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

// `dependabot-lockfile.yml` is the only workflow in this repo that runs on
// `pull_request_target` — a write-capable GITHUB_TOKEN in a job that checks out
// a PR author's tree. Four things keep that safe, and NONE of them was asserted
// anywhere before this file existed, so an edit could drop one silently:
//
//   1. `bun install --ignore-scripts` — no lifecycle script from the PR's own
//      package.json / dependency tree executes in the privileged job.
//   2. the `github.actor == 'dependabot[bot]'` job gate — the job runs only for
//      first-party Dependabot bumps, never an arbitrary contributor's PR.
//   3. `persist-credentials: false` — the token never lands in `.git/config`,
//      where the checked-out tree could read it back out.
//   4. `ref: …head.sha` rather than `…head.ref` — the exact commit that fired
//      the event, closing the force-push TOCTOU where the branch moves between
//      trigger and checkout.
//
// Every assertion fails CLOSED: a deleted install step, a renamed job, or a
// reformatted `if:` reds this test instead of quietly passing.

const WORKFLOW_PATH = join(
  __dirname,
  "..",
  "..",
  ".github",
  "workflows",
  "dependabot-lockfile.yml",
);
const raw = readFileSync(WORKFLOW_PATH, "utf8");

// Drop whole-line comments and trailing ` # …` comments before matching, so no
// check below can be satisfied — or broken — by a comment that merely mentions
// a command. (Inline action-pin comments like `# v7.0.0` go too; a `#` inside a
// quoted shell string would be trimmed as well, which no step relies on.)
const codeLines = raw
  .split("\n")
  .filter((line) => !/^\s*#/.test(line))
  .map((line) => line.replace(/\s+#.*$/, ""));
const code = codeLines.join("\n");

/** `{ name, body }` for every entry under the top-level `jobs:` key. */
function jobBlocks(): Array<{ name: string; body: string }> {
  const start = codeLines.findIndex((line) => /^jobs:\s*$/.test(line));
  if (start === -1) return [];
  const blocks: Array<{ name: string; body: string }> = [];
  for (let i = start + 1; i < codeLines.length; i++) {
    const line = codeLines[i] ?? "";
    if (/^\S/.test(line)) break; // dedented back out of `jobs:`
    const header = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (header) {
      blocks.push({ name: header[1] ?? "", body: "" });
      continue;
    }
    const current = blocks.at(-1);
    if (current) current.body += `${line}\n`;
  }
  return blocks;
}

/**
 * Body text of every `actions/checkout` step — the `uses:` line plus everything
 * indented under it, up to the next step at the same or a shallower indent.
 */
function checkoutSteps(): string[] {
  const steps: string[] = [];
  for (let i = 0; i < codeLines.length; i++) {
    const line = codeLines[i] ?? "";
    if (!/^\s*-?\s*uses:\s*actions\/checkout@/.test(line)) continue;
    const indent = line.search(/\S/);
    const body = [line];
    for (let j = i + 1; j < codeLines.length; j++) {
      const next = codeLines[j] ?? "";
      if (next.trim() === "") continue;
      const nextIndent = next.search(/\S/);
      if (nextIndent < indent) break;
      if (nextIndent === indent && next.trimStart().startsWith("- ")) break;
      body.push(next);
    }
    steps.push(body.join("\n"));
  }
  return steps;
}

describe("dependabot-lockfile workflow: privileged-job guards", () => {
  test("still runs on pull_request_target — which is why every guard below matters", () => {
    // If this ever moves to `pull_request`, the threat model changes and the
    // guards below should be re-derived deliberately, not inherited.
    expect(code).toMatch(/^on:\n\s+pull_request_target:/m);
  });

  test("every `bun install` runs with --ignore-scripts", () => {
    const installs = codeLines.filter((line) => line.includes("bun install"));
    expect(installs.length).toBeGreaterThan(0);
    for (const line of installs) {
      expect(line, "an install in the privileged job runs lifecycle scripts").toContain(
        "--ignore-scripts",
      );
    }
  });

  test("every job is gated to the dependabot[bot] actor", () => {
    const jobs = jobBlocks();
    expect(jobs.length).toBeGreaterThan(0);
    for (const job of jobs) {
      expect(job.body, `job "${job.name}" is missing the dependabot actor gate`).toMatch(
        /^ {4}if:.*github\.actor == 'dependabot\[bot\]'/m,
      );
    }
  });

  test("every checkout sets persist-credentials: false", () => {
    const checkouts = checkoutSteps();
    expect(checkouts.length).toBeGreaterThan(0);
    for (const step of checkouts) {
      expect(step, "a checkout leaves the write token in .git/config").toContain(
        "persist-credentials: false",
      );
    }
  });

  test("every checkout pins the immutable head.sha, never the mutable head.ref", () => {
    const checkouts = checkoutSteps();
    expect(checkouts.length).toBeGreaterThan(0);
    for (const step of checkouts) {
      // A regex, not a string literal: biome's noTemplateCurlyInString flags a
      // literal `${{ … }}`, and this also tolerates GitHub's optional spacing.
      expect(step).toMatch(/ref:\s*\$\{\{\s*github\.event\.pull_request\.head\.sha\s*\}\}/);
      expect(step, "checkout resolves a branch name that can move after the trigger").not.toContain(
        "head.ref",
      );
    }
  });

  test("the job token is granted contents: write and nothing wider", () => {
    const writeGrants = codeLines.filter((line) => /^\s+[a-z-]+:\s+write$/.test(line));
    for (const grant of writeGrants) {
      expect(grant.trim(), "a permission wider than contents: write was granted").toBe(
        "contents: write",
      );
    }
    expect(code).not.toContain("write-all");
  });
});
