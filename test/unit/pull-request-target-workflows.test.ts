import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

// `pull_request_target` runs a workflow with a write-capable GITHUB_TOKEN and the
// repository's secrets, even for a PR opened from a fork. The danger is checking
// out — and so executing — the PR author's tree inside such a job.
//
// `cla.yml` is the only workflow here allowed to use the trigger, and it is safe
// only because it never checks out code: the CLA action reads the PR through the
// API. Both properties are asserted below, so a new privileged workflow, or a
// checkout added to the CLA job, reds this file instead of landing silently.
//
// (`dependabot-lockfile.yml`, the second such workflow, was deleted when
// Dependabot was retired; its own pinning test went with it.)

const WORKFLOWS_DIR = join(__dirname, "..", "..", ".github", "workflows");

/** Workflow source with whole-line and trailing comments removed. */
function stripComments(source: string): string {
  return source
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .map((line) => line.replace(/\s+#.*$/, ""))
    .join("\n");
}

// A bare word, not a mapping key: YAML can declare the trigger as a key
// (`pull_request_target:`), a scalar (`on: pull_request_target`) or a list item
// (`on: [push, pull_request_target]`), and all of them run with the same token.
// Any other mention outside a comment counts too, which fails closed.
function declaresPullRequestTarget(source: string): boolean {
  return /\bpull_request_target\b/.test(stripComments(source));
}

// The checkout action in any quoting, or a git / gh command that fetches a
// tree. Options can sit between the tool and its subcommand — `git -C "$dir"
// fetch`, `git -c k=v checkout`, `gh pr -R owner/repo checkout` — so anything
// on the same line is allowed there. That also counts a line that merely names
// both words, which fails closed: a false positive reds this file, a miss lets
// a checkout land. A tool and subcommand on different lines (a `\` continuation,
// a folded YAML scalar) are not seen.
function checksOutCode(source: string): boolean {
  return /actions\/checkout@|\bgit\b[^\n]*\b(?:clone|fetch|checkout|pull|worktree)\b|\bgh\b[^\n]*\b(?:checkout|clone)\b/.test(
    stripComments(source),
  );
}

const read = (file: string): string => readFileSync(join(WORKFLOWS_DIR, file), "utf8");

const workflowFiles = readdirSync(WORKFLOWS_DIR).filter((f) => /\.ya?ml$/.test(f));

describe("pull_request_target workflows", () => {
  test("the workflow directory is actually read", () => {
    // Without this, a wrong path would make both tests below pass vacuously.
    expect(workflowFiles).toContain("ci.yml");
    expect(workflowFiles).toContain("cla.yml");
  });

  test("cla.yml is the only workflow triggered by pull_request_target", () => {
    expect(workflowFiles.filter((f) => declaresPullRequestTarget(read(f)))).toEqual(["cla.yml"]);
  });

  test("cla.yml never checks out the repository", () => {
    expect(checksOutCode(read("cla.yml"))).toBe(false);
  });
});

// What this file can catch is decided by the two detectors above, so their
// recall is pinned on its own: a guard that only knew the spelling cla.yml
// happens to use would let every other spelling through.
describe("the workflow detectors", () => {
  test.each([
    ["a mapping key", "on:\n  pull_request_target:\n    types: [opened]\n"],
    ["a scalar", "on: pull_request_target\n"],
    ["a flow sequence", "on: [push, pull_request_target]\n"],
    ["a block sequence", "on:\n  - push\n  - pull_request_target\n"],
  ])("see the trigger written as %s", (_form, source) => {
    expect(declaresPullRequestTarget(source)).toBe(true);
  });

  test("do not see the trigger when it is only named in a comment", () => {
    expect(
      declaresPullRequestTarget("# pull_request_target\non: push # pull_request_target\n"),
    ).toBe(false);
  });

  test.each([
    ["the unquoted checkout action", "      - uses: actions/checkout@0123abcd\n"],
    ["the double-quoted checkout action", '      - uses: "actions/checkout@0123abcd"\n'],
    ["the single-quoted checkout action", "      - uses: 'actions/checkout@0123abcd'\n"],
    ["git fetch", "      - run: git fetch origin pull/1/head\n"],
    ["git fetch after -C", '      - run: git -C "$dir" fetch origin pull/1/head\n'],
    ["git checkout after -c", "      - run: git -c x=y checkout FETCH_HEAD\n"],
    ["gh pr checkout", "      - run: gh pr checkout 1\n"],
    ["gh pr checkout after -R", "      - run: gh pr -R owner/repo checkout 1\n"],
  ])("see a checkout through %s", (_form, source) => {
    expect(checksOutCode(source)).toBe(true);
  });

  test("do not count an action that only talks to the API", () => {
    expect(checksOutCode("      - uses: actions/create-github-app-token@0123abcd\n")).toBe(false);
  });
});
