import { describe, expect, test } from "vitest";

import type { ConnectionState } from "../../src/connection/connection-manager.js";
import type { SessionSummary } from "../../src/sidebar/sessions.js";
import { createSessionsView } from "../../src/sidebar/sessions-view.js";
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
const summary: SessionSummary = { sessionId: "sess-1", lastWriteAt: 1000, chunkCount: 2 };

describe("createSessionsView", () => {
  test("shows a placeholder and never loads when disconnected", async () => {
    let calls = 0;
    const c = makeConnection({ kind: "disconnected", socketPath: "/s", reason: "down" });
    const view = createSessionsView({
      connection: c.connection,
      loadSessions: async () => {
        calls += 1;
        return [];
      },
    });
    expect(await view.getChildren()).toEqual([]); // empty tree → viewsWelcome renders instead
    expect(calls).toBe(0);
  });

  test("maps loaded sessions to rows when connected", async () => {
    const c = makeConnection(connected);
    const view = createSessionsView({
      connection: c.connection,
      loadSessions: async () => [summary],
      now: () => summary.lastWriteAt,
    });
    const rows = await view.getChildren();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.label).toBe("Session sess-1");
    expect(rows[0]?.command?.command).toBe("nimbus.openSession");
  });

  test("shows an empty-state row when there are no sessions", async () => {
    const c = makeConnection(connected);
    const view = createSessionsView({ connection: c.connection, loadSessions: async () => [] });
    expect((await view.getChildren())[0]?.label).toBe("No saved sessions yet");
  });

  test("surfaces an error row when loading fails", async () => {
    const c = makeConnection(connected);
    const view = createSessionsView({
      connection: c.connection,
      loadSessions: async () => {
        throw new Error("sql boom");
      },
    });
    const rows = await view.getChildren();
    expect(rows[0]?.label).toMatch(/failed to load/i);
    expect(rows[0]?.tooltip).toContain("sql boom");
    expect(rows[0]?.iconId).toBe("error");
  });

  test("returns no children for a non-root element", async () => {
    const c = makeConnection(connected);
    const view = createSessionsView({ connection: c.connection, loadSessions: async () => [] });
    expect(await view.getChildren({ label: "row" })).toEqual([]);
  });

  test("refresh + connection changes fire onDidChangeTreeData; dispose unsubscribes", async () => {
    const c = makeConnection(connected);
    const view = createSessionsView({ connection: c.connection, loadSessions: async () => [] });
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
