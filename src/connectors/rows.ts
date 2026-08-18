import type {
  ConnectorHealthHistoryEntry,
  ConnectorSyncStatus,
  ConnectorSyncTelemetry,
} from "@nimbus-dev/client";

import { formatRelativeTime } from "../sidebar/relative-time.js";
import type { SidebarItem } from "../sidebar/tree-view.js";

/**
 * The contextValues the manifest keys its menus on. A connector is exactly one
 * of these: `disabled` wins over everything (an enabled:false connector is not
 * "paused"), then `syncing`, which is what hides the sync family mid-sync.
 */
export const CONNECTOR_CONTEXT = {
  active: "nimbus.connector.active",
  paused: "nimbus.connector.paused",
  disabled: "nimbus.connector.disabled",
  syncing: "nimbus.connector.syncing",
} as const;

/** What a view/item/context command needs off the node VS Code hands it. */
export type ConnectorPayload = { serviceId: string; itemCount: number };

const STATUS_ICONS: Record<ConnectorSyncStatus["status"], string> = {
  ok: "pass",
  syncing: "sync",
  paused: "debug-pause",
  backoff: "warning",
  error: "error",
};

// Unhealthy first: this is a health surface, and a row that needs attention
// should not sit below four that do not. Ties break on id so the order is total
// and the rendering is deterministic.
const SEVERITY: Record<ConnectorSyncStatus["status"], number> = {
  error: 0,
  backoff: 1,
  paused: 2,
  syncing: 3,
  ok: 4,
};

function iconFor(s: ConnectorSyncStatus): string {
  if (!s.enabled) return "circle-slash";
  return STATUS_ICONS[s.status];
}

function contextValueFor(s: ConnectorSyncStatus): string {
  if (!s.enabled) return CONNECTOR_CONTEXT.disabled;
  if (s.status === "paused") return CONNECTOR_CONTEXT.paused;
  if (s.status === "syncing") return CONNECTOR_CONTEXT.syncing;
  return CONNECTOR_CONTEXT.active;
}

function tooltipFor(s: ConnectorSyncStatus, now: number): string {
  const lines = [
    `${s.serviceId} · ${s.enabled ? s.status : "disabled"}`,
    `Depth: ${s.depth}`,
    `Interval: ${Math.round(s.intervalMs / 1000)}s`,
  ];
  if (s.nextSyncAt !== null) lines.push(`Next sync: ${formatRelativeTime(now, s.nextSyncAt)}`);
  if (s.consecutiveFailures > 0) lines.push(`${s.consecutiveFailures} consecutive failures`);
  // Verbatim, and never logged: it is the user's own error about their own
  // connector, and the host/path detail is what makes it actionable.
  if (s.lastError !== null) lines.push(`Last error: ${s.lastError}`);
  return lines.join("\n");
}

export function connectorToItem(s: ConnectorSyncStatus, now: number): SidebarItem {
  const synced = s.lastSyncAt === null ? "never synced" : `synced ${formatRelativeTime(now, s.lastSyncAt)}`;
  return {
    label: s.serviceId,
    description: `${s.itemCount.toLocaleString("en-US")} items · ${synced}`,
    tooltip: tooltipFor(s, now),
    iconId: iconFor(s),
    contextValue: contextValueFor(s),
    // Detail is fetched on expand, so the row declares no children but must
    // still render a twistie — without one the load can never be triggered.
    children: [],
    collapsible: true,
    payload: { serviceId: s.serviceId, itemCount: s.itemCount } satisfies ConnectorPayload,
  };
}

export function connectorRows(
  statuses: readonly ConnectorSyncStatus[],
  now: number,
): SidebarItem[] {
  return statuses
    .slice()
    .sort((a, b) => SEVERITY[a.status] - SEVERITY[b.status] || a.serviceId.localeCompare(b.serviceId))
    .map((s) => connectorToItem(s, now));
}

export function connectorPayloadOf(item: SidebarItem): ConnectorPayload | undefined {
  const p = item.payload;
  if (typeof p !== "object" || p === null) return undefined;
  const { serviceId, itemCount } = p as { serviceId?: unknown; itemCount?: unknown };
  if (typeof serviceId !== "string" || typeof itemCount !== "number") return undefined;
  return { serviceId, itemCount };
}

export function telemetryToItem(t: ConnectorSyncTelemetry, now: number): SidebarItem {
  const failed = t.errorMsg !== null;
  return {
    label: `${formatRelativeTime(now, t.startedAt)} · ${(t.durationMs / 1000).toFixed(1)}s`,
    description: t.errorMsg !== null ? t.errorMsg : `+${t.itemsUpserted} / -${t.itemsDeleted}`,
    iconId: failed ? "error" : "pass",
  };
}

export function healthEntryToItem(e: ConnectorHealthHistoryEntry, now: number): SidebarItem {
  const when = formatRelativeTime(now, e.occurredAtMs);
  return {
    label: `${e.fromState ?? ""} → ${e.toState}`.trim(),
    description: e.reason === null ? when : `${when} · ${e.reason}`,
    iconId: "history",
  };
}
