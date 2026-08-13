import type { WorkflowRow, WorkflowRunResult } from "@nimbus-dev/client";
import { describe, expect, test } from "vitest";

import {
  buildRunManifest,
  describeRunOutcome,
  formatRunReport,
  summarizeSteps,
} from "../../src/workflows/run.js";

function workflow(over: Partial<WorkflowRow> = {}): WorkflowRow {
  return {
    id: "wf-1",
    name: "nightly-sync",
    description: "Sync everything overnight",
    steps_json: JSON.stringify([
      { label: "collect", run: "gather the open PRs" },
      { label: "summarise", run: "write it up" },
    ]),
    created_at: 1,
    updated_at: 2,
    ...over,
  };
}

function result(over: Partial<WorkflowRunResult> = {}): WorkflowRunResult {
  return {
    runId: "run-1",
    status: "done",
    dryRun: false,
    stepResults: [{ label: "collect", status: "done", output: "3 PRs" }],
    ...over,
  };
}

describe("summarizeSteps", () => {
  test("lists each step's label so the manifest shows what will execute", () => {
    expect(summarizeSteps(workflow().steps_json)).toEqual(["collect", "summarise"]);
  });

  test("falls back to a positional label for an unlabelled step", () => {
    expect(summarizeSteps(JSON.stringify([{ run: "a" }, { run: "b" }]))).toEqual([
      "step 1",
      "step 2",
    ]);
  });

  test("unparseable steps_json does not throw — the Gateway never validates it", () => {
    // steps_json is opaque at save time, so a malformed DAG is stored happily
    // and only fails at run time. The manifest must still render.
    expect(summarizeSteps("{not json")).toEqual([]);
    expect(summarizeSteps(JSON.stringify({ notAnArray: true }))).toEqual([]);
  });
});

describe("buildRunManifest", () => {
  test("the previewed prompt names the workflow and every step that will run", () => {
    const { prompt } = buildRunManifest(workflow(), { dryRun: false });
    expect(prompt).toContain("nightly-sync");
    expect(prompt).toContain("collect");
    expect(prompt).toContain("summarise");
  });

  test("the action distinguishes a dry run from a real one", () => {
    expect(buildRunManifest(workflow(), { dryRun: false }).meta.action).toBe(
      "Run workflow nightly-sync",
    );
    expect(buildRunManifest(workflow(), { dryRun: true }).meta.action).toBe(
      "Dry-run workflow nightly-sync",
    );
  });

  test("states plainly that the Gateway expands the steps, not the extension", () => {
    // The extension never sees the prompts each step sends; claiming the
    // manifest is byte-exact would be a lie, so it says what it actually is.
    const { meta } = buildRunManifest(workflow(), { dryRun: false });
    expect(meta.omissions.join(" ")).toMatch(/gateway/i);
  });

  test("declares no files — a workflow run sends no editor content", () => {
    expect(buildRunManifest(workflow(), { dryRun: false }).meta.files).toEqual([]);
  });

  test("warns in the manifest when the steps could not be read at all", () => {
    // The user is about to authorise a send whose contents nobody can enumerate.
    // Staying silent here would show an empty step list that reads like "no
    // steps" rather than "unknown steps".
    const { prompt, meta } = buildRunManifest(workflow({ steps_json: "{not json" }), {
      dryRun: false,
    });
    expect(prompt).toContain("(none readable)");
    expect(meta.omissions.join(" ")).toMatch(/could not be read/i);
    expect(meta.omissions.join(" ")).toMatch(/does not validate it at save time/i);
  });

  test("a workflow with no description omits the line rather than printing null", () => {
    expect(
      buildRunManifest(workflow({ description: null }), { dryRun: false }).prompt,
    ).not.toContain("null");
  });

  test("a param override is shown, since it changes what is sent", () => {
    const { prompt } = buildRunManifest(workflow(), {
      dryRun: false,
      paramsOverride: { collect: { repo: "acme/widgets" } },
    });
    expect(prompt).toContain("acme/widgets");
  });
});

describe("describeRunOutcome", () => {
  test("a cancelled run says the in-flight step still finished", () => {
    // The single most misleading thing this surface could do is imply the run
    // stopped instantly.
    const msg = describeRunOutcome("nightly-sync", result({ status: "cancelled" }));
    expect(msg).toMatch(/cancelled/i);
    expect(msg).toMatch(/step/i);
  });

  test("a completed run reports its step count", () => {
    expect(describeRunOutcome("nightly-sync", result())).toMatch(/1 step/);
  });

  test("a failed run is reported as failed", () => {
    expect(describeRunOutcome("nightly-sync", result({ status: "error" }))).toMatch(/failed/i);
  });

  test("a dry run is never reported as if it had really run", () => {
    const msg = describeRunOutcome("nightly-sync", result({ status: "preview", dryRun: true }));
    expect(msg).toMatch(/dry run|preview/i);
  });

  test("a Gateway too old to report a status does not get called cancelled", () => {
    // status is optional on the wire. Guessing here would mislabel every run
    // against a Gateway that predates the field.
    const { status: _drop, ...noStatus } = result();
    const msg = describeRunOutcome("nightly-sync", noStatus as WorkflowRunResult);
    expect(msg).not.toMatch(/cancelled/i);
    expect(msg).toMatch(/finished|completed/i);
  });
});

describe("formatRunReport", () => {
  test("titles the tab by run id so two runs never collide", () => {
    expect(formatRunReport("nightly-sync", result()).title).toContain("run-1");
  });

  test("renders each step's status and output", () => {
    const { content } = formatRunReport("nightly-sync", result());
    expect(content).toContain("collect");
    expect(content).toContain("3 PRs");
  });

  test("a step error is surfaced, not swallowed", () => {
    const { content } = formatRunReport(
      "nightly-sync",
      result({
        status: "error",
        stepResults: [{ label: "collect", status: "error", error: "no network" }],
      }),
    );
    expect(content).toContain("no network");
  });

  test("a cancelled report carries the boundary caveat in the body", () => {
    const { content } = formatRunReport("nightly-sync", result({ status: "cancelled" }));
    expect(content).toMatch(/next step boundary/i);
  });

  test("a run cancelled before its first step says so instead of rendering a blank list", () => {
    const { content } = formatRunReport(
      "nightly-sync",
      result({ status: "cancelled", stepResults: [] }),
    );
    expect(content).toMatch(/no steps recorded/i);
  });

  test("an unlabelled step still gets a positional heading", () => {
    const { content } = formatRunReport(
      "nightly-sync",
      result({ stepResults: [{ status: "done", output: "out" }] }),
    );
    expect(content).toContain("1. step 1 — done");
  });

  test("a Gateway that reports no status says so rather than printing undefined", () => {
    const { status: _drop, ...noStatus } = result();
    const { content } = formatRunReport("nightly-sync", noStatus as WorkflowRunResult);
    expect(content).toContain("not reported by this Gateway");
  });
});
