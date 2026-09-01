import type { ConnectorSyncStatus } from "@nimbus-dev/client";
import { describe, expect, test } from "vitest";

import {
  connectorStatusFingerprint,
  summarizeConnectorHealth,
} from "../../src/connectors/health.js";
import { REAL_CONNECTOR_STATUSES } from "./fixtures/real-connector-statuses.js";

// The default is a connector that HAS worked — it has completed a sync. The
// old default (`lastSyncAt: null`, `itemCount: 0`) described a service nobody
// ever configured, which is the shape a real Gateway returns ~74 of, and
// asserting degradation over it was what let the Sources row ship naming
// connectors the user had never set up.
function status(over: Partial<ConnectorSyncStatus>): ConnectorSyncStatus {
  return {
    serviceId: "github",
    status: "ok",
    lastSyncAt: 1_700_000_000_000,
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

// --- Finding 4: Sources must name what regressed, not what was never set up
describe("summarizeConnectorHealth against a real Gateway payload", () => {
  test("names only connectors that were working and stopped", () => {
    const h = summarizeConnectorHealth(REAL_CONNECTOR_STATUSES);
    // gmail (299 items) and google_drive (62) both synced successfully in the
    // past and are now failing on an expired token — that is a real signal:
    // indexed data is going stale.
    expect(h.names).toEqual(["gmail", "google_drive"]);
    expect(h.count).toBe(2);
  });

  test("ignores a connector that has never synced and indexed nothing", () => {
    // bigeye and onedrive report status "error", but their error is
    // "no server spawned" / "OAuth not configured" — they were never set up,
    // so there is nothing degraded to report. Before this change the ambient
    // panel's Sources row named all of them and so never turned off.
    const h = summarizeConnectorHealth(REAL_CONNECTOR_STATUSES);
    expect(h.names).not.toContain("bigeye");
    expect(h.names).not.toContain("onedrive");
  });

  test("a connector with indexed items counts even if lastSyncAt is null", () => {
    // Items in the index are proof it once worked, whatever the cursor says.
    const h = summarizeConnectorHealth([
      {
        ...REAL_CONNECTOR_STATUSES[0]!,
        serviceId: "jira",
        status: "error",
        lastSyncAt: null,
        itemCount: 12,
        healthState: "error",
      },
    ]);
    expect(h.names).toEqual(["jira"]);
  });
});
