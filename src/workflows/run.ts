import type { WorkflowRow, WorkflowRunResult, WorkflowStepResult } from "@nimbus-dev/client";

import type { EgressMeta } from "../egress/preflight.js";

/**
 * The step labels a run will execute, read out of `steps_json`.
 *
 * The Gateway does not parse `steps_json` at save time — a malformed DAG saves
 * cleanly and fails only at run time — so this must tolerate anything and
 * return `[]` rather than throw. A manifest that cannot render is a manifest
 * that gets skipped.
 */
export function summarizeSteps(stepsJson: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stepsJson);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.map((step, i) => {
    const label = (step as { label?: unknown } | null)?.label;
    return typeof label === "string" && label.length > 0 ? label : `step ${i + 1}`;
  });
}

export interface RunOptions {
  readonly dryRun: boolean;
  readonly paramsOverride?: Record<string, Record<string, unknown>>;
}

/**
 * What the pre-flight modal shows before a workflow runs.
 *
 * Deliberately NOT claimed to be byte-exact. Every other gated surface previews
 * the literal string the extension is about to send; here the extension sends
 * only a workflow *name*, and the Gateway expands the saved steps into model
 * prompts it never shows us. Presenting this as the exact outbound text would
 * be a lie, so the manifest shows what is actually known — which workflow, in
 * which mode, with which steps and overrides — and says who expands it.
 */
export function buildRunManifest(
  row: WorkflowRow,
  opts: RunOptions,
): { prompt: string; meta: EgressMeta } {
  const steps = summarizeSteps(row.steps_json);
  const lines: string[] = [
    `Workflow: ${row.name}`,
    `Mode: ${opts.dryRun ? "dry run (no steps execute)" : "real run"}`,
  ];
  if (row.description !== null) lines.push(`Description: ${row.description}`);
  lines.push("", steps.length === 0 ? "Steps: (none readable)" : "Steps:");
  for (const [i, label] of steps.entries()) lines.push(`  ${i + 1}. ${label}`);
  if (opts.paramsOverride !== undefined) {
    lines.push("", "Parameter overrides:", JSON.stringify(opts.paramsOverride, null, 2));
  }

  const omissions = [
    "The Gateway expands each step into its own model prompt from the saved workflow; the extension sends only the workflow name and the options above, and never sees the expanded text.",
  ];
  if (steps.length === 0) {
    omissions.push(
      "This workflow's steps_json could not be read, so no step list is shown. The Gateway does not validate it at save time — the run may fail.",
    );
  }

  return {
    prompt: lines.join("\n"),
    meta: {
      action: `${opts.dryRun ? "Dry-run" : "Run"} workflow ${row.name}`,
      // A run sends no editor content — no selection, no diff, no file bodies.
      files: [],
      omissions,
    },
  };
}

function stepCount(n: number): string {
  return `${n} step${n === 1 ? "" : "s"}`;
}

/**
 * The one-line outcome shown after a run settles.
 *
 * `status` is optional on the wire (a Gateway predating `workflow.cancel` omits
 * it), so an absent status reports a plain finish rather than guessing —
 * guessing would mislabel every run against such a Gateway.
 */
export function describeRunOutcome(name: string, result: WorkflowRunResult): string {
  const steps = stepCount(result.stepResults.length);
  switch (result.status) {
    case "cancelled":
      // The single most misleading thing this surface could say is that the run
      // stopped instantly. It did not: cancellation lands between steps.
      return `Workflow ${name} cancelled after ${steps}. The step already running finished first — cancellation takes effect at the next step boundary.`;
    case "error":
      return `Workflow ${name} failed after ${steps}.`;
    case "preview":
      return `Workflow ${name} dry run complete — ${steps} previewed, nothing executed.`;
    case "done":
      return `Workflow ${name} completed ${steps}.`;
    default:
      return result.dryRun
        ? `Workflow ${name} dry run finished — ${steps} previewed.`
        : `Workflow ${name} finished ${steps}.`;
  }
}

function renderStep(step: WorkflowStepResult, i: number): string[] {
  const lines = [`${i + 1}. ${step.label ?? `step ${i + 1}`} — ${step.status}`];
  if (step.output !== undefined) lines.push(indent(step.output));
  if (step.error !== undefined) lines.push(indent(`error: ${step.error}`));
  return lines;
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((l) => `    ${l}`)
    .join("\n");
}

/** The read-only report tab opened once a run settles. */
export function formatRunReport(
  name: string,
  result: WorkflowRunResult,
): { title: string; content: string } {
  const lines: string[] = [
    `# Workflow run — ${name}`,
    "",
    `- Run id: ${result.runId}`,
    `- Status: ${result.status ?? "(not reported by this Gateway)"}`,
    `- Dry run: ${result.dryRun ? "yes" : "no"}`,
    `- Steps recorded: ${result.stepResults.length}`,
  ];
  if (result.status === "cancelled") {
    lines.push(
      "",
      "> Cancelled at the next step boundary. The step that was already running",
      "> ran to completion — steps after it never started.",
    );
  }
  lines.push("", "## Steps", "");
  if (result.stepResults.length === 0) {
    lines.push("_No steps recorded._");
  } else {
    for (const [i, step] of result.stepResults.entries()) lines.push(...renderStep(step, i));
  }
  return { title: `workflow-run-${result.runId}.md`, content: lines.join("\n") };
}
