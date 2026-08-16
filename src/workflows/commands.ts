import type {
  WorkflowRow,
  WorkflowRunEvent,
  WorkflowRunResult,
  WorkflowRunStreamParams,
} from "@nimbus-dev/client";

import { isEgressCancelled } from "../egress/gated-client.js";
import type { EgressMeta } from "../egress/preflight.js";
import { errMsg, type Logger } from "../logging.js";
import type {
  CancellationTokenLike,
  MessageOptionsLike,
  OutputChannelHandle,
  QuickPickItemLike,
} from "../vscode-shim.js";
import { buildRunManifest, describeRunOutcome, formatRunReport } from "./run.js";

/** A live run, narrowed from the client's WorkflowRunStreamHandle. */
export interface RunHandleLike {
  readonly streamId: string;
  readonly result: Promise<WorkflowRunResult>;
  cancel(): Promise<{ cancelled: boolean }>;
  [Symbol.asyncIterator](): AsyncIterator<WorkflowRunEvent>;
}

interface WorkflowPickItem extends QuickPickItemLike {
  readonly row: WorkflowRow;
}

export interface WorkflowCommandDeps {
  /** Saved workflows. Throws when the Gateway is unreachable. */
  listWorkflows(): Promise<WorkflowRow[]>;
  /**
   * The GATED run. Its third argument is what the pre-flight shows; a run that
   * the user declines throws EgressCancelled and never reaches the Gateway.
   */
  runWorkflow(
    params: WorkflowRunStreamParams,
    manifest: string,
    meta: EgressMeta,
  ): Promise<RunHandleLike>;
  /** Per-step output lands here as it streams. */
  output: OutputChannelHandle;
  openReadonly(title: string, content: string): Promise<void>;
  withCancellableProgress<R>(
    title: string,
    body: (token: CancellationTokenLike) => Promise<R>,
  ): Promise<R>;
  window: {
    showQuickPick<T extends QuickPickItemLike>(
      items: readonly T[],
      opts?: { placeHolder?: string; matchOnDescription?: boolean; matchOnDetail?: boolean },
    ): Thenable<T | undefined>;
    showInformationMessage(
      msg: string,
      opts?: MessageOptionsLike,
      ...items: string[]
    ): Thenable<string | undefined>;
    showErrorMessage(
      msg: string,
      opts?: MessageOptionsLike,
      ...items: string[]
    ): Thenable<string | undefined>;
  };
  log: Logger;
}

/** Passed when a run is started from a Workflows-view row rather than the palette. */
export interface WorkflowRunTarget {
  readonly workflowName: string;
}

export interface WorkflowCommands {
  run(target?: WorkflowRunTarget): Promise<void>;
  dryRun(target?: WorkflowRunTarget): Promise<void>;
}

export function createWorkflowCommands(deps: WorkflowCommandDeps): WorkflowCommands {
  const pick = async (target: WorkflowRunTarget | undefined): Promise<WorkflowRow | undefined> => {
    const workflows = await deps.listWorkflows();
    if (target !== undefined) {
      const found = workflows.find((w) => w.name === target.workflowName);
      if (found === undefined) {
        await deps.window.showErrorMessage(
          `Nimbus: no saved workflow named ${target.workflowName}.`,
        );
      }
      return found;
    }
    if (workflows.length === 0) {
      // An empty picker looks broken; say what is actually true.
      await deps.window.showInformationMessage(
        "Nimbus: no saved workflows. Create one with the Nimbus CLI first.",
      );
      return undefined;
    }
    const items: WorkflowPickItem[] = workflows.map((row) => ({
      label: row.name,
      description: `${summarizeStepCount(row)}`,
      ...(row.description === null ? {} : { detail: row.description }),
      row,
    }));
    const chosen = await deps.window.showQuickPick(items, {
      placeHolder: "Pick a workflow to run",
      matchOnDescription: true,
      matchOnDetail: true,
    });
    return chosen?.row;
  };

  const stream = async (handle: RunHandleLike, token: CancellationTokenLike): Promise<void> => {
    // Cancelling does NOT close the stream: the in-flight step runs to
    // completion and the run then settles as "cancelled". Tearing the iterator
    // down here would discard that terminal result — the only confirmation the
    // cancel took effect.
    const sub = token.onCancellationRequested(() => {
      void handle.cancel().then(
        ({ cancelled }) => {
          deps.output.appendLine(
            cancelled
              ? "— cancellation requested; the step already running will finish first —"
              : "— cancellation had no effect: this run is no longer live, or this Gateway has no workflow.cancel —",
          );
        },
        (e: unknown) => deps.log.warn(`workflow cancel failed: ${errMsg(e)}`),
      );
    });
    try {
      for await (const ev of handle) {
        if (ev.type === "chunk") deps.output.appendLine(ev.text);
        else if (ev.type === "error") deps.output.appendLine(`error: ${ev.message}`);
      }
    } finally {
      sub.dispose();
    }
  };

  const execute = async (target: WorkflowRunTarget | undefined, dryRun: boolean): Promise<void> => {
    let row: WorkflowRow | undefined;
    try {
      row = await pick(target);
    } catch (e) {
      await deps.window.showErrorMessage(`Nimbus: could not list workflows — ${errMsg(e)}`);
      return;
    }
    if (row === undefined) return;

    const { prompt, meta } = buildRunManifest(row, { dryRun });
    const title = `${dryRun ? "Dry-running" : "Running"} workflow ${row.name}…`;

    try {
      await deps.withCancellableProgress(title, async (token) => {
        const handle = await deps.runWorkflow({ name: row.name, dryRun }, prompt, meta);
        deps.output.appendLine(`— ${title} (stream ${handle.streamId}) —`);
        deps.output.show(true);
        await stream(handle, token);
        const result = await handle.result;
        const report = formatRunReport(row.name, result);
        await deps.openReadonly(report.title, report.content);
        await deps.window.showInformationMessage(describeRunOutcome(row.name, result));
      });
    } catch (e) {
      // Declining the pre-flight is a choice, not a failure — the gate already
      // told the user what happened by being dismissed.
      if (isEgressCancelled(e)) {
        deps.log.info(`workflow run for ${row.name} cancelled at the pre-flight preview`);
        return;
      }
      await deps.window.showErrorMessage(`Nimbus: workflow ${row.name} failed — ${errMsg(e)}`);
    }
  };

  return {
    run: (target) => execute(target, false),
    dryRun: (target) => execute(target, true),
  };
}

function summarizeStepCount(row: WorkflowRow): string {
  const n = countSteps(row.steps_json);
  if (n === undefined) return "steps unreadable";
  return `${n} ${n === 1 ? "step" : "steps"}`;
}

function countSteps(stepsJson: string): number | undefined {
  try {
    const parsed: unknown = JSON.parse(stepsJson);
    return Array.isArray(parsed) ? parsed.length : undefined;
  } catch {
    return undefined;
  }
}
