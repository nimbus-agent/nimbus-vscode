import type { ConnectorSyncStatus } from "@nimbus-dev/client";

// A connector is degraded when it is enabled but its scheduler has given up or
// is backing off. paused/syncing are user-intended or transient, not degraded.
export function summarizeConnectorHealth(statuses: readonly ConnectorSyncStatus[]): {
  count: number;
  names: string[];
} {
  const names = statuses
    .filter((s) => s.enabled && (s.status === "error" || s.status === "backoff"))
    .map((s) => s.serviceId)
    .sort();
  return { count: names.length, names };
}
