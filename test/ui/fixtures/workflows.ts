import type { WorkflowRow, WorkflowRunHistoryRow } from "@nimbus-dev/client";

// Fixture data for the workflow surface: the saved workflows `workflow.list`
// answers with, the run history `workflow.listRuns` answers with, and the
// terminal result a cancelled `workflow.run` settles on.
//
// The rows are the GATEWAY's raw shape — snake_case (`steps_json`,
// `updated_at`), because the Gateway does not camelCase them and the client's
// validator would reject a camelCased row. Run-history rows, by contrast, ARE
// camelCase on the wire. Getting either wrong fails inside the client's
// validate() with an IpcResponseError, which surfaces as a "Failed to load
// workflows" row rather than as a spec failure — so keep them exact.

// Fixed at module load so the view's relative-time description ("2h ago") is
// plausible rather than "56y ago" from an epoch-zero timestamp. Nothing
// asserts on the rendered time — it is a description, not a label.
const NOW = Date.now();
const HOUR = 3_600_000;

/**
 * The step labels of {@link NIGHTLY_TRIAGE}, in run order. The pre-flight
 * manifest renders these as `  1. <label>`, so the order here is the order the
 * spec asserts.
 */
export const NIGHTLY_STEP_LABELS = [
  "collect failing tests",
  "summarise the diff",
  "post the digest",
] as const;

export const NIGHTLY_TRIAGE: WorkflowRow = {
  id: "wf-nightly-triage",
  name: "nightly-triage",
  description: "Triage last night's failures",
  // A JSON-encoded array string, exactly as the Gateway stores it. The
  // extension's summarizeSteps parses this and reads each element's `label`.
  steps_json: JSON.stringify(NIGHTLY_STEP_LABELS.map((label) => ({ label, agent: "ask" }))),
  created_at: NOW - 30 * 24 * HOUR,
  updated_at: NOW - 2 * HOUR,
};

/** A second workflow, with no run history — proves the per-workflow lookup. */
export const RELEASE_CHECKLIST: WorkflowRow = {
  id: "wf-release-checklist",
  name: "release-checklist",
  description: null,
  steps_json: JSON.stringify([{ label: "check the changelog" }, { label: "check open PRs" }]),
  created_at: NOW - 10 * 24 * HOUR,
  updated_at: NOW - 26 * HOUR,
};

export const WORKFLOWS: readonly WorkflowRow[] = [NIGHTLY_TRIAGE, RELEASE_CHECKLIST];

const NIGHTLY_RUNS: readonly WorkflowRunHistoryRow[] = [
  {
    id: "run-1",
    startedAt: NOW - 3 * HOUR,
    finishedAt: NOW - 3 * HOUR + 4200,
    durationMs: 4200,
    status: "done",
    errorMsg: null,
    dryRun: false,
    paramsOverrideJson: null,
    triggeredBy: "cli",
  },
  {
    id: "run-2",
    startedAt: NOW - 26 * HOUR,
    finishedAt: NOW - 26 * HOUR + 900,
    durationMs: 900,
    status: "preview",
    errorMsg: null,
    dryRun: true,
    paramsOverrideJson: null,
    triggeredBy: "vscode",
  },
];

/** Run history keyed by `workflow.listRuns`'s `workflowName` param. */
export const RUNS_BY_WORKFLOW: Readonly<Record<string, readonly WorkflowRunHistoryRow[]>> = {
  [NIGHTLY_TRIAGE.name]: NIGHTLY_RUNS,
  // release-checklist is deliberately absent: the view must render its
  // "Never run" row rather than another workflow's history.
};

interface StepResult {
  readonly label: string;
  readonly status: string;
  readonly output?: string;
}

interface RunResult {
  readonly runId: string;
  readonly dryRun: boolean;
  readonly status: string;
  readonly stepResults: readonly StepResult[];
}

function stepLabels(name: string): string[] {
  const row = WORKFLOWS.find((w) => w.name === name);
  if (row === undefined) return [];
  const parsed: unknown = JSON.parse(row.steps_json);
  if (!Array.isArray(parsed)) return [];
  return parsed.map((s, i) => {
    const label = (s as { label?: unknown } | null)?.label;
    return typeof label === "string" ? label : `step ${i + 1}`;
  });
}

/**
 * What a DRY run settles with, immediately. A dry run executes nothing, so the
 * fake answers it in one round trip rather than holding the request open the
 * way a real run does — a dry run that hung would be a fake-gateway artefact,
 * not a property of the surface.
 */
export function previewRunResult(name: string): RunResult {
  return {
    runId: `run-preview-${name}`,
    dryRun: true,
    status: "preview",
    stepResults: stepLabels(name).map((label) => ({ label, status: "preview" })),
  };
}

/** What the fake settles a cancelled `workflow.run` with. */
export const CANCELLED_RUN_ID = "run-cancelled";

/**
 * The one step that was already in flight when the cancel arrived. The real
 * Gateway always finishes it — the surface's wording depends on that being
 * true, so the fixture models it rather than reporting zero steps.
 */
export const CANCELLED_RUN_RESULT = {
  runId: CANCELLED_RUN_ID,
  dryRun: false,
  status: "cancelled",
  stepResults: [
    {
      label: NIGHTLY_STEP_LABELS[0],
      status: "done",
      output: "12 failing tests collected",
    },
  ],
} as const;
