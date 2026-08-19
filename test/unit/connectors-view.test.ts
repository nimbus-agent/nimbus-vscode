import type { ConnectorSyncStatus } from "@nimbus-dev/client";
import { describe, expect, test, vi } from "vitest";

import type { ConnectorOps } from "../../src/connectors/connector-client.js";
import { createConnectorsView } from "../../src/connectors/connectors-view.js";
import type { SidebarItem } from "../../src/sidebar/tree-view.js";

const NOW = 1_000_000_000;
const connection = {
  current: () => ({ kind: "connected" }) as never,
  onState: () => ({ dispose: () => {} }),
};

function status(over: Partial<ConnectorSyncStatus> = {}): ConnectorSyncStatus {
  return {
    serviceId: "github",
    status: "ok",
    lastSyncAt: NOW,
    nextSyncAt: null,
    intervalMs: 60_000,
    itemCount: 2,
    lastError: null,
    consecutiveFailures: 0,
    depth: "summary",
    enabled: true,
    ...over,
  };
}

function ops(over: Partial<ConnectorOps> = {}): ConnectorOps {
  return {
    list: vi.fn(async () => [status()]),
    detail: vi.fn(async () => ({ ...status(), telemetry: [] })),
    history: vi.fn(async () => []),
    // Spread LAST: a helper that drops its override makes every test that
    // passes one assert nothing at all.
    ...over,
  } as unknown as ConnectorOps;
}

describe("the connectors view", () => {
  test("renders a row per connector", async () => {
    const view = createConnectorsView({ connection, ops: ops(), now: () => NOW });
    const rows = await view.getChildren();
    expect(rows.map((r) => r.label)).toEqual(["github"]);
  });

  test("an empty Gateway offers the one source the extension can register", async () => {
    const view = createConnectorsView({
      connection,
      ops: ops({ list: vi.fn(async () => []) }),
      now: () => NOW,
    });
    const rows = await view.getChildren();
    expect(rows[0]?.label).toBe("No connectors registered");
    expect(rows[1]?.command?.command).toBe("nimbus.addMcpConnector");
  });

  test("a failed load renders one error row rather than throwing", async () => {
    const view = createConnectorsView({
      connection,
      ops: ops({
        list: vi.fn(async () => {
          throw new Error("Method not found");
        }),
      }),
      now: () => NOW,
    });
    const rows = await view.getChildren();
    expect(rows[0]?.iconId).toBe("error");
    expect(rows[0]?.tooltip).toContain("Method not found");
  });

  test("expanding fetches telemetry and history under group rows", async () => {
    const o = ops({
      detail: vi.fn(async () => ({
        ...status(),
        telemetry: [
          {
            startedAt: NOW - 1000,
            durationMs: 500,
            itemsUpserted: 1,
            itemsDeleted: 0,
            bytesTransferred: null,
            hadMore: false,
            errorMsg: null,
          },
        ],
      })),
      history: vi.fn(async () => [
        {
          id: 1,
          connectorId: "github",
          fromState: null,
          toState: "healthy",
          reason: null,
          occurredAtMs: NOW,
        },
      ]),
    });
    const view = createConnectorsView({ connection, ops: o, now: () => NOW });
    const [row] = await view.getChildren();
    const children = await view.getChildren(row);
    expect(children.map((c) => c.label)).toEqual(["Recent syncs", "Health history"]);
    expect(children[0]?.children).toHaveLength(1);
    expect(children[1]?.children).toHaveLength(1);
  });

  test("a connector with no history at all shows only the syncs group", async () => {
    const view = createConnectorsView({ connection, ops: ops(), now: () => NOW });
    const [row] = await view.getChildren();
    const children = await view.getChildren(row);
    expect(children.map((c) => c.label)).toEqual(["Recent syncs"]);
    expect(children[0]?.children?.[0]?.label).toBe("Never synced");
  });

  test("one connector's unreadable detail does not blank the view", async () => {
    const view = createConnectorsView({
      connection,
      ops: ops({
        detail: vi.fn(async () => {
          throw new Error("nope");
        }),
      }),
      now: () => NOW,
    });
    const [row] = await view.getChildren();
    const children = await view.getChildren(row);
    expect(children[0]?.iconId).toBe("error");
  });

  test("a row we did not build has nothing to expand", async () => {
    const view = createConnectorsView({ connection, ops: ops(), now: () => NOW });
    const foreign: SidebarItem = { label: "No connectors registered" };
    expect(await view.getChildren(foreign)).toEqual([]);
  });
});
