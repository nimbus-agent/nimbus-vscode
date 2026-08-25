import type {
  WorkflowListResult,
  WorkflowListRunsParams,
  WorkflowListRunsResult,
} from "@nimbus-dev/client";

import { nodePayload } from "./parse-helpers.js";
import {
  createDataView,
  errorRow,
  NOT_CONNECTED_ROW,
  type SidebarConnection,
  type SidebarItem,
  type SidebarView,
} from "./tree-view.js";
import { runToItem, type WorkflowPayload, workflowToItem } from "./workflows.js";

// The Gateway client capability this view needs. Both calls are read-only and
// reach no model, so nothing here routes through the egress pre-flight gate —
// read-only Gateway data is not egress, and this view is not an exception to it.
export interface WorkflowsClientLike {
  workflowList(): Promise<WorkflowListResult>;
  workflowListRuns(params: WorkflowListRunsParams): Promise<WorkflowListRunsResult>;
}

/** The Gateway clamps to 1..500; this is what one screenful of history costs. */
const DEFAULT_RUN_LIMIT = 20;

function payloadOf(item: SidebarItem): WorkflowPayload | undefined {
  const name = (nodePayload(item) as { workflowName?: unknown } | undefined)?.workflowName;
  return typeof name === "string" ? { workflowName: name } : undefined;
}

/**
 * Read-only Workflows view: one row per saved workflow, its recent runs
 * underneath. Runs load on expand rather than up front — eager children would
 * cost one `workflow.listRuns` round trip per saved workflow every time the
 * view opens, for rows nobody looked at.
 */
export function createWorkflowsView(deps: {
  connection: SidebarConnection;
  getClient: () => WorkflowsClientLike | undefined;
  runLimit?: number;
  now?: () => number;
}): SidebarView {
  const now = (): number => (deps.now ?? Date.now)();
  return createDataView({
    connection: deps.connection,
    loadData: async () => {
      const client = deps.getClient();
      if (client === undefined) return [NOT_CONNECTED_ROW];
      try {
        const { workflows } = await client.workflowList();
        if (workflows.length === 0) {
          return [{ label: "No saved workflows", iconId: "info" }];
        }
        const at = now();
        return workflows.map((w) => workflowToItem(w, at));
      } catch (err) {
        return [errorRow("Failed to load workflows", err)];
      }
    },
    loadChildren: async (item) => {
      const payload = payloadOf(item);
      // A row we did not build (or a run row) has no name to fetch against.
      if (payload === undefined) return item.children ?? [];
      const client = deps.getClient();
      if (client === undefined) return [NOT_CONNECTED_ROW];
      try {
        const { runs } = await client.workflowListRuns({
          workflowName: payload.workflowName,
          limit: deps.runLimit ?? DEFAULT_RUN_LIMIT,
        });
        if (runs.length === 0) return [{ label: "Never run", iconId: "info" }];
        const at = now();
        return runs.map((r) => runToItem(r, at));
      } catch (err) {
        // Scoped to this workflow's children: one workflow's unreadable history
        // must not blank the whole view.
        return [errorRow("Failed to load runs", err)];
      }
    },
  });
}
