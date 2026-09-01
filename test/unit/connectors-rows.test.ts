import type { ConnectorSyncStatus } from "@nimbus-dev/client";
import { describe, expect, test } from "vitest";

import {
  CONNECTOR_CONTEXT,
  connectorPayloadOf,
  connectorRows,
  connectorToItem,
  healthEntryToItem,
  telemetryToItem,
} from "../../src/connectors/rows.js";
import { REAL_CONNECTOR_STATUSES } from "./fixtures/real-connector-statuses.js";

const NOW = 1_000_000_000;

function status(over: Partial<ConnectorSyncStatus> = {}): ConnectorSyncStatus {
  return {
    serviceId: "github",
    status: "ok",
    lastSyncAt: NOW - 180_000,
    nextSyncAt: NOW + 180_000,
    intervalMs: 360_000,
    itemCount: 1204,
    lastError: null,
    consecutiveFailures: 0,
    depth: "summary",
    enabled: true,
    ...over,
  };
}

describe("connectorToItem", () => {
  test("a healthy connector shows its item count and relative last sync", () => {
    const item = connectorToItem(status(), NOW);
    expect(item.label).toBe("github");
    expect(item.description).toBe("1,204 items · synced 3m ago");
    expect(item.iconId).toBe("pass");
    expect(item.contextValue).toBe(CONNECTOR_CONTEXT.active);
    expect(item.collapsible).toBe(true);
  });

  test("a connector that has never synced says so rather than dating from the epoch", () => {
    expect(connectorToItem(status({ lastSyncAt: null }), NOW).description).toBe(
      "1,204 items · never synced",
    );
  });

  test("each status maps to its own icon", () => {
    expect(connectorToItem(status({ status: "error" }), NOW).iconId).toBe("error");
    expect(connectorToItem(status({ status: "backoff" }), NOW).iconId).toBe("warning");
    expect(connectorToItem(status({ status: "paused" }), NOW).iconId).toBe("debug-pause");
    expect(connectorToItem(status({ status: "syncing" }), NOW).iconId).toBe("sync");
  });

  test("disabled overrides the icon and the contextValue whatever the status says", () => {
    const item = connectorToItem(status({ status: "error", enabled: false }), NOW);
    expect(item.iconId).toBe("circle-slash");
    expect(item.contextValue).toBe(CONNECTOR_CONTEXT.disabled);
  });

  test("a syncing connector carries the syncing contextValue, so the sync family hides", () => {
    expect(connectorToItem(status({ status: "syncing" }), NOW).contextValue).toBe(
      CONNECTOR_CONTEXT.syncing,
    );
  });

  test("the tooltip carries the error and the failure count", () => {
    const item = connectorToItem(
      status({ status: "error", lastError: "401 Unauthorized", consecutiveFailures: 3 }),
      NOW,
    );
    expect(item.tooltip).toContain("401 Unauthorized");
    expect(item.tooltip).toContain("3 consecutive failures");
  });

  test("the payload carries what a context-menu command needs", () => {
    expect(connectorPayloadOf(connectorToItem(status(), NOW))).toEqual({
      serviceId: "github",
      itemCount: 1204,
    });
  });

  test("a row we did not build yields no payload", () => {
    expect(connectorPayloadOf({ label: "No connectors registered" })).toBeUndefined();
  });
});

describe("connectorRows", () => {
  test("unhealthy connectors sort above healthy ones, then by id", () => {
    const rows = connectorRows(
      [
        status({ serviceId: "zulip", status: "ok" }),
        status({ serviceId: "slack", status: "backoff" }),
        status({ serviceId: "asana", status: "ok" }),
        status({ serviceId: "github", status: "error" }),
      ],
      NOW,
    );
    expect(rows.map((r) => r.label)).toEqual(["github", "slack", "asana", "zulip"]);
  });
});

describe("detail rows", () => {
  test("a telemetry row reads as a completed sync", () => {
    const item = telemetryToItem(
      {
        startedAt: NOW - 60_000,
        durationMs: 2_500,
        itemsUpserted: 12,
        itemsDeleted: 1,
        bytesTransferred: null,
        hadMore: false,
        errorMsg: null,
      },
      NOW,
    );
    expect(item.label).toBe("1m ago · 2.5s");
    expect(item.description).toBe("+12 / -1");
    expect(item.iconId).toBe("pass");
  });

  test("a failed telemetry row shows the Gateway's message verbatim", () => {
    const item = telemetryToItem(
      {
        startedAt: NOW - 60_000,
        durationMs: 900,
        itemsUpserted: 0,
        itemsDeleted: 0,
        bytesTransferred: null,
        hadMore: false,
        errorMsg: "connect ECONNREFUSED 127.0.0.1:5432",
      },
      NOW,
    );
    expect(item.iconId).toBe("error");
    expect(item.description).toBe("connect ECONNREFUSED 127.0.0.1:5432");
  });

  test("a health transition names both states and its reason", () => {
    const item = healthEntryToItem(
      {
        id: 4,
        connectorId: "github",
        fromState: "healthy",
        toState: "backoff",
        reason: "429 rate limited",
        occurredAtMs: NOW - 3_600_000,
      },
      NOW,
    );
    expect(item.label).toBe("healthy → backoff");
    expect(item.description).toBe("1h ago · 429 rate limited");
  });

  test("a first-ever transition has no from-state to name", () => {
    const item = healthEntryToItem(
      {
        id: 1,
        connectorId: "github",
        fromState: null,
        toState: "healthy",
        reason: null,
        occurredAtMs: NOW - 3_600_000,
      },
      NOW,
    );
    expect(item.label).toBe("→ healthy");
    expect(item.description).toBe("1h ago");
  });
});

// --- Findings 3: rows built from a REAL Gateway payload -------------------
// The Connectors surface shipped believing `status` told the whole story. A
// real Gateway 7.1.0 returns every known service, configured or not, and
// carries the distinction in `healthState` — a field this repo did not read.
describe("healthState (captured from a real Gateway)", () => {
  test("a never-configured connector does not render as a healthy one", () => {
    const airflow = REAL_CONNECTOR_STATUSES.find((s) => s.serviceId === "airflow");
    if (airflow === undefined) throw new Error("fixture lost its airflow row");
    const item = connectorToItem(airflow, NOW);
    // Before this change it drew "[pass] airflow - 0 items · synced 3d ago",
    // byte-identical in icon to github, which was genuinely working.
    expect(item.iconId).not.toBe("pass");
    expect(item.iconId).toBe("circle-outline");
  });

  test("it says 'not configured' rather than dating a sync that never happened", () => {
    const airflow = REAL_CONNECTOR_STATUSES.find((s) => s.serviceId === "airflow");
    if (airflow === undefined) throw new Error("fixture lost its airflow row");
    const item = connectorToItem(airflow, NOW);
    expect(item.description).toBe("not configured");
    expect(item.description).not.toContain("synced");
  });

  test("an absent healthState still renders exactly as it did before", () => {
    // `healthState` is `?: string` in the client: an older Gateway omits it,
    // and such a row must keep its old rendering rather than become "not
    // configured" on the strength of a missing field.
    const item = connectorToItem(status(), NOW);
    expect(item.iconId).toBe("pass");
    expect(item.description).toBe("1,204 items · synced 3m ago");
  });

  test("unconfigured connectors are hidden by default", () => {
    const rows = connectorRows(REAL_CONNECTOR_STATUSES, NOW);
    const labels = rows.map((r) => r.label);
    expect(labels).not.toContain("airflow");
    // obsidian is healthy with zero items — configured, just empty; it stays.
    expect(labels).toContain("obsidian");
    expect(labels).toContain("github");
    expect(labels).toContain("gmail");
  });

  test("showUnconfigured surfaces them, sorted below every configured row", () => {
    const rows = connectorRows(REAL_CONNECTOR_STATUSES, NOW, { showUnconfigured: true });
    const labels = rows.map((r) => r.label);
    expect(labels).toContain("airflow");
    // Every unconfigured row sits below every configured one, so a row that
    // needs attention is never pushed under 74 that cannot.
    const lastConfigured = Math.max(labels.indexOf("github"), labels.indexOf("google_photos"));
    expect(labels.indexOf("airflow")).toBeGreaterThan(lastConfigured);
  });

  test("errors still sort to the top, ahead of working connectors", () => {
    const rows = connectorRows(REAL_CONNECTOR_STATUSES, NOW, { showUnconfigured: true });
    const labels = rows.map((r) => r.label);
    expect(labels.indexOf("bigeye")).toBeLessThan(labels.indexOf("github"));
  });
});
