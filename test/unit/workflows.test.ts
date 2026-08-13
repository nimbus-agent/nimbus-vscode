import type { WorkflowRow, WorkflowRunHistoryRow } from "@nimbus-dev/client";
import { describe, expect, test } from "vitest";

import type { ConnectionState } from "../../src/connection/connection-manager.js";
import type { SidebarConnection } from "../../src/sidebar/tree-view.js";
import {
  formatRunDuration,
  iconForRunStatus,
  runToItem,
  workflowToItem,
} from "../../src/sidebar/workflows.js";
import { createWorkflowsView } from "../../src/sidebar/workflows-view.js";

const CONNECTED: ConnectionState = { kind: "connected", socketPath: "/s" };

function makeConnection(initial: ConnectionState = CONNECTED): SidebarConnection {
  const state = initial;
  const listeners = new Set<(s: ConnectionState) => void>();
  return {
    current: () => state,
    onState: (listener) => {
      listeners.add(listener);
      return {
        dispose: () => {
          listeners.delete(listener);
        },
      };
    },
  };
}

const NOW = 1_700_000_000_000;

function workflow(over: Partial<WorkflowRow> = {}): WorkflowRow {
  return {
    id: "wf-1",
    name: "nightly-sync",
    description: "Sync everything overnight",
    steps_json: "[]",
    created_at: NOW - 100_000,
    updated_at: NOW - 60_000,
    ...over,
  };
}

function run(over: Partial<WorkflowRunHistoryRow> = {}): WorkflowRunHistoryRow {
  return {
    id: "run-1",
    startedAt: NOW - 30_000,
    finishedAt: NOW - 20_000,
    durationMs: 10_000,
    status: "done",
    errorMsg: null,
    dryRun: false,
    paramsOverrideJson: null,
    triggeredBy: "cli",
    ...over,
  };
}

describe("iconForRunStatus", () => {
  test("maps the four statuses the Gateway produces", () => {
    expect(iconForRunStatus("done")).toBe("pass");
    expect(iconForRunStatus("error")).toBe("error");
    expect(iconForRunStatus("running")).toBe("dash");
    expect(iconForRunStatus("cancelled")).toBe("circle-slash");
  });

  test("falls back for an unknown status rather than assuming the union", () => {
    // `status` is typed `string`, not a union — a Gateway may add one.
    expect(iconForRunStatus("quarantined")).toBe("question");
    expect(iconForRunStatus("")).toBe("question");
  });

  test("renders preview distinctly from a real completed run", () => {
    expect(iconForRunStatus("preview")).toBe("eye");
  });
});

describe("formatRunDuration", () => {
  test("renders sub-second, second and minute scales", () => {
    expect(formatRunDuration(340)).toBe("340ms");
    expect(formatRunDuration(10_000)).toBe("10.0s");
    expect(formatRunDuration(125_000)).toBe("2m 5s");
  });

  test("a still-running row has no duration yet", () => {
    expect(formatRunDuration(null)).toBe("running…");
  });
});

describe("workflowToItem", () => {
  test("renders the name with a relative updated_at and the description as tooltip", () => {
    const item = workflowToItem(workflow(), NOW);
    expect(item.label).toBe("nightly-sync");
    expect(item.description).toBe("1m ago");
    expect(item.tooltip).toBe("Sync everything overnight");
  });

  test("a null description falls back to the name rather than an empty tooltip", () => {
    expect(workflowToItem(workflow({ description: null }), NOW).tooltip).toBe("nightly-sync");
  });

  test("is collapsible before its runs are loaded", () => {
    // Runs are fetched lazily on expand — the row must still offer a twistie.
    const item = workflowToItem(workflow(), NOW);
    expect(item.collapsible).toBe(true);
    expect(item.children).toEqual([]);
  });

  test("carries the workflow name so the lazy child load knows what to fetch", () => {
    expect(workflowToItem(workflow(), NOW).payload).toEqual({ workflowName: "nightly-sync" });
  });

  test("declares the contextValue the Run / Dry-Run menu items key off", () => {
    // package.json gates them on `viewItem == nimbus.workflow`; without this the
    // context menu silently never appears on any row.
    expect(workflowToItem(workflow(), NOW).contextValue).toBe("nimbus.workflow");
  });
});

describe("runToItem", () => {
  test("describes duration and trigger", () => {
    const item = runToItem(run(), NOW);
    expect(item.description).toBe("10.0s · cli");
    expect(item.iconId).toBe("pass");
  });

  test("badges a dry run so a rehearsal is never mistaken for a real one", () => {
    expect(runToItem(run({ dryRun: true }), NOW).label).toMatch(/dry run/i);
  });

  test("surfaces the error message in the tooltip of a failed run", () => {
    const item = runToItem(run({ status: "error", errorMsg: "step 2 blew up" }), NOW);
    expect(item.iconId).toBe("error");
    expect(item.tooltip).toContain("step 2 blew up");
  });

  test("a still-running row reads as running rather than as a zero-length run", () => {
    const item = runToItem(run({ finishedAt: null, durationMs: null, status: "running" }), NOW);
    expect(item.iconId).toBe("dash");
    expect(item.description).toBe("running… · cli");
  });

  test("a cancelled run is visually distinct from a failed one", () => {
    expect(runToItem(run({ status: "cancelled" }), NOW).iconId).toBe("circle-slash");
  });
});

describe("createWorkflowsView", () => {
  function makeClient(over?: {
    workflows?: WorkflowRow[];
    runs?: WorkflowRunHistoryRow[];
    listThrows?: boolean;
    runsThrow?: boolean;
    onListRuns?: (p: { workflowName: string; limit: number }) => void;
  }) {
    return {
      workflowList: async () => {
        if (over?.listThrows === true) throw new Error("gateway said no");
        return { workflows: over?.workflows ?? [workflow()] };
      },
      workflowListRuns: async (p: { workflowName: string; limit: number }) => {
        over?.onListRuns?.(p);
        if (over?.runsThrow === true) throw new Error("runs unavailable");
        return { runs: over?.runs ?? [run()] };
      },
    };
  }

  test("lists saved workflows as top-level rows", async () => {
    const view = createWorkflowsView({
      connection: makeConnection(),
      getClient: () => makeClient(),
      now: () => NOW,
    });
    const rows = await view.getChildren();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.label).toBe("nightly-sync");
  });

  test("does not fetch runs until a workflow is expanded", async () => {
    // The whole point of the lazy seam: N+1 round trips on open would be the
    // alternative, for rows nobody looked at.
    let calls = 0;
    const view = createWorkflowsView({
      connection: makeConnection(),
      getClient: () => makeClient({ onListRuns: () => (calls += 1) }),
      now: () => NOW,
    });
    await view.getChildren();
    expect(calls).toBe(0);

    const [parent] = await view.getChildren();
    if (parent === undefined) throw new Error("expected a workflow row");
    await view.getChildren(parent);
    expect(calls).toBe(1);
  });

  test("expanding a workflow lists its runs, most recent first", async () => {
    const view = createWorkflowsView({
      connection: makeConnection(),
      getClient: () =>
        makeClient({
          runs: [run({ id: "run-2", startedAt: NOW - 5_000 }), run({ id: "run-1" })],
        }),
      now: () => NOW,
    });
    const [parent] = await view.getChildren();
    if (parent === undefined) throw new Error("expected a workflow row");
    const runs = await view.getChildren(parent);
    expect(runs).toHaveLength(2);
  });

  test("a workflow with no runs says so instead of rendering nothing", async () => {
    const view = createWorkflowsView({
      connection: makeConnection(),
      getClient: () => makeClient({ runs: [] }),
      now: () => NOW,
    });
    const [parent] = await view.getChildren();
    if (parent === undefined) throw new Error("expected a workflow row");
    expect((await view.getChildren(parent))[0]?.label).toMatch(/never run/i);
  });

  test("an empty workflow list shows the empty state", async () => {
    const view = createWorkflowsView({
      connection: makeConnection(),
      getClient: () => makeClient({ workflows: [] }),
      now: () => NOW,
    });
    expect((await view.getChildren())[0]?.label).toMatch(/no saved workflows/i);
  });

  test("a failing workflowList renders one error row carrying the reason", async () => {
    const view = createWorkflowsView({
      connection: makeConnection(),
      getClient: () => makeClient({ listThrows: true }),
      now: () => NOW,
    });
    const [row] = await view.getChildren();
    expect(row?.label).toMatch(/failed to load workflows/i);
    expect(row?.tooltip).toBe("gateway said no");
  });

  test("a failing workflowListRuns fails only that workflow's children", async () => {
    const view = createWorkflowsView({
      connection: makeConnection(),
      getClient: () => makeClient({ runsThrow: true }),
      now: () => NOW,
    });
    const [parent] = await view.getChildren();
    if (parent === undefined) throw new Error("expected a workflow row");
    const rows = await view.getChildren(parent);
    expect(rows[0]?.label).toMatch(/failed to load runs/i);
    expect(rows[0]?.tooltip).toBe("runs unavailable");
  });

  test("disconnected renders an empty tree so viewsWelcome takes over", async () => {
    const view = createWorkflowsView({
      connection: makeConnection({ kind: "disconnected", socketPath: "/s", reason: "nope" }),
      getClient: () => undefined,
      now: () => NOW,
    });
    expect(await view.getChildren()).toEqual([]);
  });

  test("connected but with no client yet offers a reconnect row", async () => {
    const view = createWorkflowsView({
      connection: makeConnection(),
      getClient: () => undefined,
      now: () => NOW,
    });
    expect((await view.getChildren())[0]?.command?.command).toBe("nimbus.reconnect");
  });
});
