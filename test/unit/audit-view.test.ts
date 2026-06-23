import { describe, expect, test } from "vitest";

import type { ConnectionState } from "../../src/connection/connection-manager.js";
import { type AuditClientLike, createAuditView } from "../../src/sidebar/audit-view.js";
import type { SidebarConnection } from "../../src/sidebar/tree-view.js";

function makeConnection(initial: ConnectionState): {
  connection: SidebarConnection;
  set(s: ConnectionState): void;
  listenerCount(): number;
} {
  let state = initial;
  const listeners = new Set<(s: ConnectionState) => void>();
  return {
    connection: {
      current: () => state,
      onState: (listener) => {
        listeners.add(listener);
        return { dispose: () => listeners.delete(listener) };
      },
    },
    set: (s) => {
      state = s;
      for (const l of listeners) l(s);
    },
    listenerCount: () => listeners.size,
  };
}

const connected: ConnectionState = { kind: "connected", socketPath: "/s" };

function entryRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    actionType: "github.pr.merge",
    hitlStatus: "approved",
    actionJson: "{}",
    timestamp: 5_000,
    ...over,
  };
}

describe("createAuditView", () => {
  test("shows a connection placeholder and never calls the client when disconnected", async () => {
    let calls = 0;
    const client: AuditClientLike = {
      auditList: async () => {
        calls += 1;
        return [];
      },
    };
    const c = makeConnection({ kind: "disconnected", socketPath: "/s", reason: "down" });
    const view = createAuditView({ connection: c.connection, getClient: () => client });
    const rows = await view.getChildren();
    expect(rows[0]?.label).toMatch(/reconnect/i);
    expect(calls).toBe(0);
  });

  test("maps audit entries to rows when connected", async () => {
    const client: AuditClientLike = {
      auditList: async () => [
        entryRow({ id: 1, actionType: "a", hitlStatus: "approved", timestamp: 1_000 }),
        entryRow({ id: 2, actionType: "b", hitlStatus: "rejected", timestamp: 2_000 }),
        "garbage-row",
      ],
    };
    const c = makeConnection(connected);
    const view = createAuditView({
      connection: c.connection,
      getClient: () => client,
      now: () => 61_000,
    });
    const rows = await view.getChildren();
    expect(rows).toHaveLength(2); // the unparseable row is dropped
    expect(rows[0]).toMatchObject({ label: "a", iconId: "pass", description: "1m ago" });
    expect(rows[1]).toMatchObject({ label: "b", iconId: "error" });
  });

  test("shows an empty-state row when connected with no entries", async () => {
    const c = makeConnection(connected);
    const view = createAuditView({
      connection: c.connection,
      getClient: () => ({ auditList: async () => [] }),
    });
    expect((await view.getChildren())[0]?.label).toBe("No audit entries yet");
  });

  test("surfaces an error row when auditList rejects", async () => {
    const c = makeConnection(connected);
    const view = createAuditView({
      connection: c.connection,
      getClient: () => ({
        auditList: async () => {
          throw new Error("ipc boom");
        },
      }),
    });
    const rows = await view.getChildren();
    expect(rows[0]?.label).toMatch(/failed to load/i);
    expect(rows[0]?.tooltip).toContain("ipc boom");
    expect(rows[0]?.iconId).toBe("error");
  });

  test("falls back to a not-connected row when connected but the client is missing", async () => {
    const c = makeConnection(connected);
    const view = createAuditView({ connection: c.connection, getClient: () => undefined });
    expect((await view.getChildren())[0]?.label).toMatch(/reconnect/i);
  });

  test("returns no children for a non-root element", async () => {
    const c = makeConnection(connected);
    const view = createAuditView({
      connection: c.connection,
      getClient: () => ({ auditList: async () => [] }),
    });
    expect(await view.getChildren({ label: "row" })).toEqual([]);
  });

  test("passes the configured limit through to auditList", async () => {
    let seen: number | undefined;
    const c = makeConnection(connected);
    const view = createAuditView({
      connection: c.connection,
      limit: 25,
      getClient: () => ({
        auditList: async (limit) => {
          seen = limit;
          return [];
        },
      }),
    });
    await view.getChildren();
    expect(seen).toBe(25);
  });

  test("refresh and connection changes fire onDidChangeTreeData; dispose unsubscribes", async () => {
    const c = makeConnection(connected);
    const view = createAuditView({
      connection: c.connection,
      getClient: () => ({ auditList: async () => [] }),
    });
    let fired = 0;
    view.onDidChangeTreeData?.(() => {
      fired += 1;
    });
    view.refresh();
    c.set({ kind: "idle" });
    expect(fired).toBe(2);
    expect(c.listenerCount()).toBe(1);
    view.dispose();
    expect(c.listenerCount()).toBe(0);
  });
});
