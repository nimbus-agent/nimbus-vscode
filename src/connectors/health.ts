import type { ConnectorSyncStatus } from "@nimbus-dev/client";

/** How many connectors are degraded right now, and which. */
export type ConnectorHealthSummary = { count: number; names: string[] };

/**
 * Whether this connector ever actually worked. A real Gateway reports `error`
 * for a service that was never set up as readily as for one that broke —
 * `bigeye` ("no server spawned") and `gmail` ("token has been expired or
 * revoked") are both `status: "error"`, and `healthState` calls both "error"
 * too, so neither field separates them. What does: a connector that has never
 * completed a sync and has nothing in the index has nothing to have degraded
 * from. Items alone are enough — they are proof it once worked, whatever the
 * sync cursor currently says.
 */
function hasEverWorked(s: ConnectorSyncStatus): boolean {
  return s.lastSyncAt !== null || s.itemCount > 0;
}

// A connector is degraded when it is enabled, its scheduler has given up or is
// backing off, AND it was working before — otherwise the ambient panel's
// Sources row names every service the user never configured, which on a real
// install was 12 names and meant the row never turned off. paused/syncing are
// user-intended or transient, not degraded.
export function summarizeConnectorHealth(
  statuses: readonly ConnectorSyncStatus[],
): ConnectorHealthSummary {
  const names = statuses
    .filter(
      (s) => s.enabled && (s.status === "error" || s.status === "backoff") && hasEverWorked(s),
    )
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
  return (
    statuses
      .map((s) => `${s.serviceId}:${s.status}:${s.itemCount}:${s.lastSyncAt ?? ""}`)
      // Explicit comparator, matching summarizeConnectorHealth above: a bare
      // sort() orders by UTF-16 code unit, which is deterministic but not what a
      // reader assumes of a string sort (and Sonar's S2871 flags it).
      .sort((a, b) => a.localeCompare(b))
      .join("|")
  );
}
