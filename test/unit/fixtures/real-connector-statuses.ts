import type { ConnectorSyncStatus } from "@nimbus-dev/client";

/**
 * Ten connector statuses CAPTURED VERBATIM from a real Nimbus Gateway 7.1.0 on
 * 2026-09-01 (`nimbus connector list --json`), trimmed from the 97 that
 * install returned. Hand-written stubs are what let the Connectors surface ship
 * believing every row was either healthy or broken; this fixture exists so the
 * shapes a real Gateway actually emits are the ones the tests reason about.
 *
 * What each row is here to represent:
 *  - github / github_actions / cloudwatch  configured and working (healthState "healthy")
 *  - gmail / google_drive                  configured, WAS working, now failing — has items
 *                                          and a real lastSyncAt (healthState "error")
 *  - bigeye / onedrive                     never configured; erroring only because nothing
 *                                          was ever set up — no items, never synced
 *  - google_photos                         enabled:false, healthState "error", status "paused"
 *  - airflow                                never configured, yet status "ok" — the row that
 *                                          rendered as a green tick indistinguishable from github
 *  - obsidian                               genuinely healthy with NOTHING indexed: proof that
 *                                          a zero item count is not itself evidence of neglect
 *
 * NOTE the field the extension was blind to: `healthState` is present on every
 * row here and carries "healthy" | "error" | "not_configured". It is typed
 * `?: string` in the client, so absence must stay valid for older Gateways.
 */
export const REAL_CONNECTOR_STATUSES: readonly ConnectorSyncStatus[] = [
  {
    serviceId: "github",
    status: "ok",
    lastSyncAt: 1788014604127,
    nextSyncAt: 1788278936264,
    intervalMs: 60000,
    itemCount: 336,
    lastError: null,
    consecutiveFailures: 0,
    healthState: "healthy",
    healthRetryAfterMs: null,
    depth: "full",
    enabled: true,
  },
  {
    serviceId: "github_actions",
    status: "ok",
    lastSyncAt: 1788014576383,
    nextSyncAt: 1788278936264,
    intervalMs: 60000,
    itemCount: 21647,
    lastError: null,
    consecutiveFailures: 0,
    healthState: "healthy",
    healthRetryAfterMs: null,
    depth: "full",
    enabled: true,
  },
  {
    serviceId: "cloudwatch",
    status: "ok",
    lastSyncAt: 1788014322980,
    nextSyncAt: 1788279476264,
    intervalMs: 600000,
    itemCount: 20,
    lastError: null,
    consecutiveFailures: 0,
    healthState: "healthy",
    healthRetryAfterMs: null,
    depth: "full",
    enabled: true,
  },
  {
    serviceId: "gmail",
    status: "error",
    lastSyncAt: 1787897227783,
    nextSyncAt: null,
    intervalMs: 300000,
    itemCount: 299,
    lastError: "Token exchange failed (invalid_grant: Token has been expired or revoked.)",
    consecutiveFailures: 5,
    healthState: "error",
    healthRetryAfterMs: null,
    depth: "full",
    enabled: true,
  },
  {
    serviceId: "google_drive",
    status: "error",
    lastSyncAt: 1787887866382,
    nextSyncAt: null,
    intervalMs: 1800000,
    itemCount: 62,
    lastError: "Token exchange failed (invalid_grant: Token has been expired or revoked.)",
    consecutiveFailures: 5,
    healthState: "error",
    healthRetryAfterMs: null,
    depth: "full",
    enabled: true,
  },
  {
    serviceId: "bigeye",
    status: "error",
    lastSyncAt: null,
    nextSyncAt: null,
    intervalMs: 600000,
    itemCount: 0,
    lastError: 'connector-session: no server spawned for service "bigeye"',
    consecutiveFailures: 5,
    healthState: "error",
    healthRetryAfterMs: null,
    depth: "full",
    enabled: true,
  },
  {
    serviceId: "onedrive",
    status: "error",
    lastSyncAt: null,
    nextSyncAt: null,
    intervalMs: 1800000,
    itemCount: 0,
    lastError:
      "Microsoft OAuth not configured; run: nimbus connector auth onedrive (or outlook / teams)",
    consecutiveFailures: 5,
    healthState: "error",
    healthRetryAfterMs: null,
    depth: "full",
    enabled: true,
  },
  {
    serviceId: "google_photos",
    status: "paused",
    lastSyncAt: 1778147964470,
    nextSyncAt: 1788300476264,
    intervalMs: 21600000,
    itemCount: 0,
    lastError: null,
    consecutiveFailures: 0,
    healthState: "error",
    healthRetryAfterMs: null,
    depth: "full",
    enabled: false,
  },
  {
    serviceId: "airflow",
    status: "ok",
    lastSyncAt: 1788014234168,
    nextSyncAt: 1788279476264,
    intervalMs: 600000,
    itemCount: 0,
    lastError: null,
    consecutiveFailures: 0,
    healthState: "not_configured",
    healthRetryAfterMs: null,
    depth: "full",
    enabled: true,
  },
  {
    serviceId: "obsidian",
    status: "ok",
    lastSyncAt: 1788014230653,
    nextSyncAt: 1788279476264,
    intervalMs: 600000,
    itemCount: 0,
    lastError: null,
    consecutiveFailures: 0,
    healthState: "healthy",
    healthRetryAfterMs: null,
    depth: "full",
    enabled: true,
  },
];
