import { describe, expect, test } from "vitest";

import type { ConnectionState } from "../../src/connection/connection-manager.js";
import { createEgressView, type EgressClientLike } from "../../src/sidebar/egress-view.js";
import type { SidebarConnection } from "../../src/sidebar/tree-view.js";

function makeConnection(initial: ConnectionState): { connection: SidebarConnection } {
  let state = initial;
  const listeners = new Set<(s: ConnectionState) => void>();
  return {
    connection: {
      current: () => state,
      onState: (l) => {
        listeners.add(l);
        return { dispose: () => listeners.delete(l) };
      },
    },
  };
}

const connected: ConnectionState = { kind: "connected", socketPath: "/s" };

function egressRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    timestamp: 1_000,
    destination: "gmail",
    method: "send",
    resultStatus: "authorized",
    hitlStatus: "approved",
    ...over,
  };
}

describe("createEgressView", () => {
  test("shows a not-connected row and never calls the client when the client is missing", async () => {
    let calls = 0;
    const c = makeConnection(connected);
    const view = createEgressView({
      connection: c.connection,
      getClient: () => {
        calls += 1;
        return undefined;
      },
    });
    const rows = await view.getChildren();
    expect(rows[0]?.label).toMatch(/reconnect/i);
    expect(calls).toBe(1);
  });

  test("maps ledger rows to items when connected, dropping unparseable rows", async () => {
    const client: EgressClientLike = {
      egressList: async () => ({
        rows: [
          egressRow({ id: 1, resultStatus: "authorized", timestamp: 1_000 }),
          egressRow({ id: 2, resultStatus: "blocked", timestamp: 2_000 }),
          "garbage",
        ],
      }),
    };
    const c = makeConnection(connected);
    const view = createEgressView({
      connection: c.connection,
      getClient: () => client,
      now: () => 61_000,
    });
    const rows = await view.getChildren();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ label: "gmail.send", iconId: "pass", description: "1m ago" });
    expect(rows[1]).toMatchObject({ iconId: "error" });
  });

  test("shows an empty-state row when connected with no rows", async () => {
    const c = makeConnection(connected);
    const view = createEgressView({
      connection: c.connection,
      getClient: () => ({ egressList: async () => ({ rows: [] }) }),
    });
    expect((await view.getChildren())[0]?.label).toBe("No egress entries yet");
  });

  test("surfaces an error row when egressList rejects", async () => {
    const c = makeConnection(connected);
    const view = createEgressView({
      connection: c.connection,
      getClient: () => ({
        egressList: async () => {
          throw new Error("ipc boom");
        },
      }),
    });
    const rows = await view.getChildren();
    expect(rows[0]?.label).toMatch(/failed to load the egress ledger/i);
    expect(rows[0]?.tooltip).toContain("ipc boom");
    expect(rows[0]?.iconId).toBe("error");
  });

  test("passes the configured limit through to egressList", async () => {
    let seen: number | undefined;
    const c = makeConnection(connected);
    const view = createEgressView({
      connection: c.connection,
      limit: 25,
      getClient: () => ({
        egressList: async (params) => {
          seen = params?.limit;
          return { rows: [] };
        },
      }),
    });
    await view.getChildren();
    expect(seen).toBe(25);
  });
});
