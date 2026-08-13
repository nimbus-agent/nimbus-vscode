import type { WorkflowRow, WorkflowRunEvent, WorkflowRunResult } from "@nimbus-dev/client";
import { describe, expect, test } from "vitest";

import { EgressCancelled } from "../../src/egress/gated-client.js";
import { createLogger } from "../../src/logging.js";
import { createWorkflowCommands, type WorkflowCommandDeps } from "../../src/workflows/commands.js";

const ROW: WorkflowRow = {
  id: "wf-1",
  name: "nightly-sync",
  description: "Sync everything overnight",
  steps_json: JSON.stringify([{ label: "collect", run: "gather" }]),
  created_at: 1,
  updated_at: 2,
};

const RESULT: WorkflowRunResult = {
  runId: "run-1",
  status: "done",
  dryRun: false,
  stepResults: [{ label: "collect", status: "done", output: "ok" }],
};

/** Spin the microtask queue until `cond` holds, so tests never race the stream. */
async function waitFor(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i += 1) await Promise.resolve();
  if (!cond()) throw new Error("waitFor: condition never became true");
}

function fakeHandle(over?: {
  events?: WorkflowRunEvent[];
  result?: WorkflowRunResult;
  onCancel?: () => void;
  cancelled?: boolean;
}) {
  const events = over?.events ?? [{ type: "done" as const, result: over?.result ?? RESULT }];
  return {
    streamId: "sid-1",
    result: Promise.resolve(over?.result ?? RESULT),
    async cancel() {
      over?.onCancel?.();
      return { cancelled: over?.cancelled ?? true };
    },
    async *[Symbol.asyncIterator]() {
      for (const e of events) yield e;
    },
  };
}

type Harness = {
  deps: WorkflowCommandDeps;
  picked: string[];
  info: string[];
  errors: string[];
  opened: Array<{ title: string; content: string }>;
  appended: string[];
  gateCalls: Array<{ manifest: string; action: string }>;
  cancelToken: { fire(): void };
};

function makeHarness(over?: {
  workflows?: WorkflowRow[];
  pick?: (items: readonly { label: string }[]) => { label: string } | undefined;
  runThrows?: unknown;
  handle?: ReturnType<typeof fakeHandle>;
  listThrows?: boolean;
}): Harness {
  const picked: string[] = [];
  const info: string[] = [];
  const errors: string[] = [];
  const opened: Array<{ title: string; content: string }> = [];
  const appended: string[] = [];
  const gateCalls: Array<{ manifest: string; action: string }> = [];
  let onCancelRequested: (() => void) | undefined;

  const deps: WorkflowCommandDeps = {
    listWorkflows: async () => {
      if (over?.listThrows === true) throw new Error("gateway down");
      return over?.workflows ?? [ROW];
    },
    runWorkflow: async (params, manifest, meta) => {
      gateCalls.push({ manifest, action: meta.action });
      if (over?.runThrows !== undefined) throw over.runThrows;
      void params;
      return over?.handle ?? fakeHandle();
    },
    output: {
      appendLine: (m) => appended.push(m),
      show: () => undefined,
      dispose: () => undefined,
    },
    openReadonly: async (title, content) => {
      opened.push({ title, content });
    },
    withCancellableProgress: async (_title, body) => {
      return body({
        onCancellationRequested: (cb) => {
          onCancelRequested = cb;
          return { dispose: () => undefined };
        },
      });
    },
    window: {
      showQuickPick: async (items) => {
        const chosen = over?.pick === undefined ? items[0] : over.pick(items);
        if (chosen !== undefined) picked.push(chosen.label);
        return chosen as never;
      },
      showInformationMessage: async (m) => {
        info.push(m);
        return undefined;
      },
      showErrorMessage: async (m) => {
        errors.push(m);
        return undefined;
      },
    },
    log: createLogger(
      { appendLine: () => undefined, show: () => undefined, dispose: () => undefined },
      () => "error",
    ),
  };

  return {
    deps,
    picked,
    info,
    errors,
    opened,
    appended,
    gateCalls,
    cancelToken: {
      fire: () => onCancelRequested?.(),
    },
  };
}

describe("createWorkflowCommands — run", () => {
  test("previews the manifest through the gate before starting the run", async () => {
    const h = makeHarness();
    await createWorkflowCommands(h.deps).run();
    expect(h.gateCalls).toHaveLength(1);
    expect(h.gateCalls[0]?.manifest).toContain("nightly-sync");
    expect(h.gateCalls[0]?.manifest).toContain("collect");
    expect(h.gateCalls[0]?.action).toBe("Run workflow nightly-sync");
  });

  test("a dry run is labelled as one all the way to the gate", async () => {
    const h = makeHarness();
    await createWorkflowCommands(h.deps).dryRun();
    expect(h.gateCalls[0]?.action).toBe("Dry-run workflow nightly-sync");
  });

  test("streams chunks into the output channel as they arrive", async () => {
    const h = makeHarness({
      handle: fakeHandle({
        events: [
          { type: "chunk", text: "step one output" },
          { type: "done", result: RESULT },
        ],
      }),
    });
    await createWorkflowCommands(h.deps).run();
    expect(h.appended.join("\n")).toContain("step one output");
  });

  test("opens the run report when the run settles", async () => {
    const h = makeHarness();
    await createWorkflowCommands(h.deps).run();
    expect(h.opened[0]?.title).toContain("run-1");
    expect(h.opened[0]?.content).toContain("collect");
  });

  test("a cancelled pre-flight reports nothing and opens no report", async () => {
    const h = makeHarness({ runThrows: new EgressCancelled() });
    await createWorkflowCommands(h.deps).run();
    expect(h.opened).toEqual([]);
    // Cancelling the preview is a deliberate choice, not an error to shout about.
    expect(h.errors).toEqual([]);
  });

  test("cancelling mid-run calls the handle's cancel", async () => {
    // The stream is held open until the test releases it, so the cancel lands
    // while the run is genuinely live rather than after it already settled.
    let release = (): void => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    let cancelled = false;
    const handle = {
      streamId: "sid-1",
      result: Promise.resolve(RESULT),
      async cancel() {
        cancelled = true;
        return { cancelled: true };
      },
      async *[Symbol.asyncIterator]() {
        yield { type: "chunk", text: "working" } as WorkflowRunEvent;
        await held;
        yield { type: "done", result: RESULT } as WorkflowRunEvent;
      },
    };
    const h = makeHarness({ handle });
    const done = createWorkflowCommands(h.deps).run();
    await waitFor(() => h.appended.some((l) => l.includes("working")));
    h.cancelToken.fire();
    await waitFor(() => cancelled);
    release();
    await done;
    expect(cancelled).toBe(true);
  });

  test("the cancel message never implies the run stopped instantly", async () => {
    const h = makeHarness({
      handle: fakeHandle({
        result: { ...RESULT, status: "cancelled" },
      }),
    });
    await createWorkflowCommands(h.deps).run();
    const said = h.info.join(" ");
    expect(said).toMatch(/next step boundary|step already running/i);
  });

  test("a run that reaches no live handle surfaces the error", async () => {
    const h = makeHarness({ runThrows: new Error("gateway exploded") });
    await createWorkflowCommands(h.deps).run();
    expect(h.errors.join(" ")).toContain("gateway exploded");
  });

  test("no saved workflows tells the user rather than opening an empty picker", async () => {
    const h = makeHarness({ workflows: [] });
    await createWorkflowCommands(h.deps).run();
    expect(h.info.join(" ")).toMatch(/no saved workflows/i);
    expect(h.gateCalls).toEqual([]);
  });

  test("dismissing the picker runs nothing", async () => {
    const h = makeHarness({ pick: () => undefined });
    await createWorkflowCommands(h.deps).run();
    expect(h.gateCalls).toEqual([]);
  });

  test("a failing workflowList surfaces the error instead of an empty picker", async () => {
    const h = makeHarness({ listThrows: true });
    await createWorkflowCommands(h.deps).run();
    expect(h.errors.join(" ")).toContain("gateway down");
  });

  test("a run started from a tree row skips the picker", async () => {
    const h = makeHarness();
    await createWorkflowCommands(h.deps).run({ workflowName: "nightly-sync" });
    expect(h.picked).toEqual([]);
    expect(h.gateCalls[0]?.action).toBe("Run workflow nightly-sync");
  });

  test("a tree row naming a workflow that no longer exists says so and runs nothing", async () => {
    // The view can outlive a deletion made elsewhere; silently falling back to
    // the picker would run a different workflow than the row the user clicked.
    const h = makeHarness();
    await createWorkflowCommands(h.deps).run({ workflowName: "deleted-since" });
    expect(h.errors.join(" ")).toContain("deleted-since");
    expect(h.gateCalls).toEqual([]);
  });

  test("a workflow with unreadable steps is still offered, labelled as such", async () => {
    const h = makeHarness({ workflows: [{ ...ROW, steps_json: "{not json" }] });
    await createWorkflowCommands(h.deps).run();
    // It may well be the one the user wants to run to discover it is broken.
    expect(h.gateCalls).toHaveLength(1);
  });

  test("a cancel that rejects is logged, not thrown into the run", async () => {
    // handle.cancel() rejecting must not take down a run that is still healthy.
    const logged: string[] = [];
    let release = (): void => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    const handle = {
      streamId: "sid-1",
      result: Promise.resolve(RESULT),
      cancel: async () => {
        throw new Error("cancel rpc exploded");
      },
      async *[Symbol.asyncIterator]() {
        yield { type: "chunk", text: "working" } as WorkflowRunEvent;
        await held;
        yield { type: "done", result: RESULT } as WorkflowRunEvent;
      },
    };
    const h = makeHarness({ handle });
    h.deps.log.warn = (m: string) => logged.push(m);
    const done = createWorkflowCommands(h.deps).run();
    await waitFor(() => h.appended.some((l) => l.includes("working")));
    h.cancelToken.fire();
    await waitFor(() => logged.length > 0);
    release();
    await done;
    expect(logged.join(" ")).toContain("cancel rpc exploded");
    expect(h.errors).toEqual([]);
  });

  test("a cancel the Gateway could not honour says so rather than claiming success", async () => {
    let release = (): void => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    const handle = {
      streamId: "sid-1",
      result: Promise.resolve(RESULT),
      cancel: async () => ({ cancelled: false }),
      async *[Symbol.asyncIterator]() {
        yield { type: "chunk", text: "working" } as WorkflowRunEvent;
        await held;
        yield { type: "done", result: RESULT } as WorkflowRunEvent;
      },
    };
    const h = makeHarness({ handle });
    const done = createWorkflowCommands(h.deps).run();
    await waitFor(() => h.appended.some((l) => l.includes("working")));
    h.cancelToken.fire();
    await waitFor(() => h.appended.some((l) => l.includes("no effect")));
    release();
    await done;
    expect(h.appended.join(" ")).toMatch(/no effect/i);
  });

  test("a stream error event is surfaced in the output rather than dropped", async () => {
    const h = makeHarness({
      handle: fakeHandle({
        events: [
          { type: "error", message: "step 2 exploded" },
          { type: "done", result: RESULT },
        ],
      }),
    });
    await createWorkflowCommands(h.deps).run();
    expect(h.appended.join("\n")).toContain("step 2 exploded");
  });
});
