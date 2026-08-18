import type { ConnectorSyncStatus } from "@nimbus-dev/client";
import { describe, expect, test } from "vitest";

import {
  connectorStatusFingerprint,
  summarizeConnectorHealth,
} from "../../src/connectors/health.js";

function status(over: Partial<ConnectorSyncStatus>): ConnectorSyncStatus {
  return {
    serviceId: "github",
    status: "ok",
    lastSyncAt: null,
    nextSyncAt: null,
    intervalMs: 60000,
    itemCount: 0,
    lastError: null,
    consecutiveFailures: 0,
    depth: "summary",
    enabled: true,
    ...over,
  };
}

describe("summarizeConnectorHealth", () => {
  test("error and backoff count as degraded, sorted by serviceId", () => {
    const r = summarizeConnectorHealth([
      status({ serviceId: "slack", status: "error" }),
      status({ serviceId: "github", status: "backoff" }),
      status({ serviceId: "jira", status: "ok" }),
    ]);
    expect(r).toEqual({ count: 2, names: ["github", "slack"] });
  });

  test("disabled connectors never count", () => {
    const r = summarizeConnectorHealth([status({ status: "error", enabled: false })]);
    expect(r).toEqual({ count: 0, names: [] });
  });

  test("paused and syncing are not degraded", () => {
    const r = summarizeConnectorHealth([
      status({ status: "paused" }),
      status({ serviceId: "gitlab", status: "syncing" }),
    ]);
    expect(r).toEqual({ count: 0, names: [] });
  });

  test("empty input yields the zero summary", () => {
    expect(summarizeConnectorHealth([])).toEqual({ count: 0, names: [] });
  });
});

describe("connectorStatusFingerprint", () => {
  test("the same input produces the same fingerprint", () => {
    const list = [status({ serviceId: "github", itemCount: 3 }), status({ serviceId: "slack" })];
    expect(connectorStatusFingerprint(list)).toBe(connectorStatusFingerprint(list));
  });

  test("a changed itemCount changes the fingerprint", () => {
    const before = connectorStatusFingerprint([status({ itemCount: 3 })]);
    const after = connectorStatusFingerprint([status({ itemCount: 4 })]);
    expect(before).not.toBe(after);
  });

  test("the order of the input array does not matter", () => {
    const a = status({ serviceId: "github" });
    const b = status({ serviceId: "slack", status: "error" });
    expect(connectorStatusFingerprint([a, b])).toBe(connectorStatusFingerprint([b, a]));
  });
});
