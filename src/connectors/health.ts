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
