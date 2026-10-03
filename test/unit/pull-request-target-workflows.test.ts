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
function code(file: string): string {
  return readFileSync(join(WORKFLOWS_DIR, file), "utf8")
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .map((line) => line.replace(/\s+#.*$/, ""))
    .join("\n");
}

const workflowFiles = readdirSync(WORKFLOWS_DIR).filter((f) => /\.ya?ml$/.test(f));

/** Workflows that declare `pull_request_target` as a trigger key. */
const privileged = workflowFiles.filter((f) => /^\s+pull_request_target:/m.test(code(f)));

describe("pull_request_target workflows", () => {
  test("the workflow directory is actually read", () => {
    // Without this, a wrong path would make both tests below pass vacuously.
    expect(workflowFiles).toContain("ci.yml");
    expect(workflowFiles).toContain("cla.yml");
  });

  test("cla.yml is the only workflow triggered by pull_request_target", () => {
    expect(privileged).toEqual(["cla.yml"]);
  });

  test("cla.yml never checks out the repository", () => {
    expect(code("cla.yml")).not.toMatch(/uses:\s*actions\/checkout@/);
  });
});
