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
