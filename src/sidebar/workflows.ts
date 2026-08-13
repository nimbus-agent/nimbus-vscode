import type { WorkflowRow, WorkflowRunHistoryRow } from "@nimbus-dev/client";

import { formatRelativeTime } from "./relative-time.js";
import type { SidebarItem } from "./tree-view.js";

/**
 * Codicon per run status. `status` is typed `string` rather than a union — the
 * Gateway does not constrain it — so this deliberately has a fallback branch
 * instead of assuming the values below are exhaustive.
 *
 * `cancelled` is mapped even though nothing produces it until the Gateway's
 * `workflow.cancel` ships, so this view needs no change when it lands.
 */
const ICON_BY_RUN_STATUS: Readonly<Record<string, string>> = {
  done: "pass",
  error: "error",
  running: "dash",
  cancelled: "circle-slash",
  preview: "eye",
};

export function iconForRunStatus(status: string): string {
  return ICON_BY_RUN_STATUS[status] ?? "question";
}

/**
 * Humanised run duration. `null` means the run has not finished — reporting
 * that as "0ms" would read as an instantaneous run rather than a live one.
 */
export function formatRunDuration(durationMs: number | null): string {
  if (durationMs === null) return "running…";
  if (durationMs < 1000) return `${durationMs}ms`;
  if (durationMs < 60_000) return `${(durationMs / 1000).toFixed(1)}s`;
  const totalSec = Math.round(durationMs / 1000);
  return `${Math.floor(totalSec / 60)}m ${totalSec % 60}s`;
}

/** Carried on a workflow row so the lazy child load knows what to fetch. */
export interface WorkflowPayload {
  readonly workflowName: string;
}

export function workflowToItem(row: WorkflowRow, now: number): SidebarItem {
  return {
    label: row.name,
    description: formatRelativeTime(now, row.updated_at),
    // A null description would leave an empty hover; the name is at least true.
    tooltip: row.description ?? row.name,
    iconId: "symbol-event",
    // Runs are fetched on expand, so the row must advertise a twistie while
    // still having no children — hence the explicit `collapsible`.
    children: [],
    collapsible: true,
    payload: { workflowName: row.name } satisfies WorkflowPayload,
  };
}

export function runToItem(row: WorkflowRunHistoryRow, now: number): SidebarItem {
  const started = formatRelativeTime(now, row.startedAt);
  const label = row.dryRun ? `${started} (dry run)` : started;
  const tooltipLines = [
    `${row.status} · triggered by ${row.triggeredBy}`,
    `started ${new Date(row.startedAt).toISOString()}`,
  ];
  if (row.errorMsg !== null) tooltipLines.push(row.errorMsg);
  return {
    label,
    description: `${formatRunDuration(row.durationMs)} · ${row.triggeredBy}`,
    tooltip: tooltipLines.join("\n"),
    iconId: iconForRunStatus(row.status),
  };
}
