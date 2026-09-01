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

/**
 * `connectorListStatus` returns every service the Gateway knows, not just the
 * ones set up here — a real Gateway 7.1.0 returned 97, of which 74 had never
 * been configured. Those carry `healthState: "not_configured"` and otherwise
 * look ordinary: `status: "ok"`, a `lastSyncAt` that is only the scheduler
 * ticking, and an item count of zero. Rendered off `status` alone they drew a
 * green tick indistinguishable from a connector that was genuinely working.
 *
 * `healthState` is `?: string` in the client — untyped, and absent on older
 * Gateways — so a missing value must mean "say nothing", never "unconfigured".
 */
const NOT_CONFIGURED = "not_configured";

export function isUnconfigured(s: ConnectorSyncStatus): boolean {
  return s.healthState === NOT_CONFIGURED;
}

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

// Below every configured row, whatever its status. An unconfigured connector
// cannot be acted on from here — registering a built-in one is a CLI job — so
// it must never push a row that needs attention down the view.
const UNCONFIGURED_SEVERITY = 5;

function severityOf(s: ConnectorSyncStatus): number {
  return isUnconfigured(s) ? UNCONFIGURED_SEVERITY : SEVERITY[s.status];
}

function iconFor(s: ConnectorSyncStatus): string {
  if (!s.enabled) return "circle-slash";
  // Ahead of the status icon: an unconfigured connector reporting "ok" (or
  // "error", as the never-spawned ones do) is describing a scheduler tick, not
  // a connector, and neither a tick nor a cross is honest about it.
  if (isUnconfigured(s)) return "circle-outline";
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
  const synced =
    s.lastSyncAt === null ? "never synced" : `synced ${formatRelativeTime(now, s.lastSyncAt)}`;
  // An unconfigured connector has no item count worth printing and no sync
  // worth dating — its `lastSyncAt` is the scheduler having ticked over a
  // connector that was never set up, and printing "synced 3d ago" over that is
  // the half of this row that actually misled.
  const description = isUnconfigured(s)
    ? "not configured"
    : `${s.itemCount.toLocaleString("en-US")} items · ${synced}`;
  return {
    label: s.serviceId,
    description,
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

/**
 * `showUnconfigured` mirrors `nimbus.connectors.showUnconfigured`, and is off
 * by default: a real Gateway returns ~74 services nobody here set up, and none
 * of them can be registered from the extension anyway. Turning it on relabels
 * them rather than hiding them — nothing is ever silently reclassified.
 */
export function connectorRows(
  statuses: readonly ConnectorSyncStatus[],
  now: number,
  opts: { showUnconfigured?: boolean } = {},
): SidebarItem[] {
  const visible =
    opts.showUnconfigured === true ? statuses.slice() : statuses.filter((s) => !isUnconfigured(s));
  return visible
    .sort((a, b) => severityOf(a) - severityOf(b) || a.serviceId.localeCompare(b.serviceId))
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
    description: t.errorMsg ?? `+${t.itemsUpserted} / -${t.itemsDeleted}`,
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
