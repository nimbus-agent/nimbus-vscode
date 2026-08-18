import type { ConnectorSyncStatus } from "@nimbus-dev/client";

/** How many connectors are degraded right now, and which. */
export type ConnectorHealthSummary = { count: number; names: string[] };

// A connector is degraded when it is enabled but its scheduler has given up or
// is backing off. paused/syncing are user-intended or transient, not degraded.
export function summarizeConnectorHealth(
  statuses: readonly ConnectorSyncStatus[],
): ConnectorHealthSummary {
  const names = statuses
    .filter((s) => s.enabled && (s.status === "error" || s.status === "backoff"))
    .map((s) => s.serviceId)
    .sort((a, b) => a.localeCompare(b));
  return { count: names.length, names };
}

// A cheap, order-independent fingerprint of the whole status list — every
// field the Connectors view actually renders (status, item count, last-sync
// time), not just the degraded subset summarizeConnectorHealth cares about.
// The status-bar poll compares this across ticks to decide whether the view
// has anything new to show; a finished sync, a changed itemCount, or an
// ok→syncing→ok transition all move it even though none of them changes the
// degraded summary. Sorted so the poll's own array order — which is not a
// contract — cannot itself register as a change.
export function connectorStatusFingerprint(statuses: readonly ConnectorSyncStatus[]): string {
  return statuses
    .map((s) => `${s.serviceId}:${s.status}:${s.itemCount}:${s.lastSyncAt ?? ""}`)
    .sort()
    .join("|");
}
