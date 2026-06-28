import { describe, expect, test } from "vitest";

import type { ConnectionState } from "../../src/connection/connection-manager.js";
import { createAgentsView } from "../../src/sidebar/agents-view.js";
import { createIndexView } from "../../src/sidebar/index-view.js";
import {
  applyThemeIcons,
  connectionPlaceholder,
  createDataView,
  createPlaceholderView,
  toTreeItem,
  type SidebarConnection,
} from "../../src/sidebar/tree-view.js";

// A controllable SidebarConnection: tests drive state transitions via `set`,
// and `listenerCount` exposes whether the view cleaned up on dispose.
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
        return {
          dispose: () => {
            listeners.delete(listener);
          },
        };
      },
    },
    set: (s) => {
      state = s;
      for (const l of listeners) l(s);
    },
    listenerCount: () => listeners.size,
  };
}

describe("connectionPlaceholder", () => {
  test("returns undefined when connected (the view renders its own data)", () => {
    expect(connectionPlaceholder({ kind: "connected", socketPath: "/s" })).toBeUndefined();
  });

  test("idle / connecting / starting-gateway all show a connecting row", () => {
    const states: ConnectionState[] = [
      { kind: "idle" },
      { kind: "connecting", socketPath: "/s" },
      { kind: "starting-gateway", socketPath: "/s" },
    ];
    for (const s of states) {
      const items = connectionPlaceholder(s);
      expect(items).toHaveLength(1);
      expect(items?.[0]?.label).toMatch(/Connecting/);
      expect(items?.[0]?.command).toBeUndefined();
    }
  });

  test("disconnected offers a reconnect command and surfaces the reason", () => {
    const items = connectionPlaceholder({
      kind: "disconnected",
      socketPath: "/s",
      reason: "ECONNREFUSED",
    });
    expect(items?.[0]?.command?.command).toBe("nimbus.reconnect");
    expect(items?.[0]?.tooltip).toBe("ECONNREFUSED");
  });

  test("permission-denied points at the logs", () => {
    const items = connectionPlaceholder({ kind: "permission-denied", socketPath: "/sock" });
    expect(items?.[0]?.command?.command).toBe("nimbus.openLogs");
    expect(items?.[0]?.tooltip).toContain("/sock");
  });
});

describe("createPlaceholderView", () => {
  test("getChildren reflects the live connection state", async () => {
    const c = makeConnection({ kind: "idle" });
    const view = createPlaceholderView({ connection: c.connection, emptyLabel: "nothing here" });
    expect((await view.getChildren())[0]?.label).toMatch(/Connecting/);
    c.set({ kind: "connected", socketPath: "/s" });
    expect(await view.getChildren()).toEqual([{ label: "nothing here" }]);
  });

  test("getTreeItem maps a row to a leaf TreeItem carrying its command", async () => {
    const c = makeConnection({ kind: "disconnected", socketPath: "/s", reason: "down" });
    const view = createPlaceholderView({ connection: c.connection, emptyLabel: "x" });
    const [row] = await view.getChildren();
    if (row === undefined) throw new Error("expected a placeholder row");
    const item = view.getTreeItem(row);
    expect(item.collapsibleState).toBe(0);
    expect(item.label).toMatch(/reconnect/i);
    expect(item.command?.command).toBe("nimbus.reconnect");
  });

  test("fires onDidChangeTreeData when the connection state changes", () => {
    const c = makeConnection({ kind: "idle" });
    const view = createPlaceholderView({ connection: c.connection, emptyLabel: "x" });
    let fired = 0;
    view.onDidChangeTreeData?.(() => {
      fired += 1;
    });
    c.set({ kind: "connected", socketPath: "/s" });
    c.set({ kind: "disconnected", socketPath: "/s", reason: "bye" });
    expect(fired).toBe(2);
  });

  test("dispose unsubscribes from the connection", () => {
    const c = makeConnection({ kind: "idle" });
    const view = createPlaceholderView({ connection: c.connection, emptyLabel: "x" });
    expect(c.listenerCount()).toBe(1);
    view.dispose();
    expect(c.listenerCount()).toBe(0);
  });

  test("disposing an onDidChangeTreeData subscription stops further notifications", () => {
    const c = makeConnection({ kind: "connected", socketPath: "/s" });
    const view = createPlaceholderView({ connection: c.connection, emptyLabel: "x" });
    let fired = 0;
    const sub = view.onDidChangeTreeData?.(() => {
      fired += 1;
    });
    c.set({ kind: "idle" });
    sub?.dispose();
    c.set({ kind: "connected", socketPath: "/s" });
    expect(fired).toBe(1);
  });
});

describe("scaffold view factories", () => {
  test("the agents placeholder view exposes its connected empty label", async () => {
    const connected: ConnectionState = { kind: "connected", socketPath: "/s" };
    const view = createAgentsView({ connection: makeConnection(connected).connection });
    expect((await view.getChildren())[0]?.label).toMatch(/agents/i);
  });
});

describe("createIndexView", () => {
  const connected: ConnectionState = { kind: "connected", socketPath: "/s" };

  test("empty index shows the empty-state row", async () => {
    const c = makeConnection(connected);
    const view = createIndexView({ connection: c.connection, loadIndex: async () => [] });
    expect((await view.getChildren())[0]?.label).toMatch(/no indexed items/i);
  });

  test("loaded items render as collapsible service groups", async () => {
    const c = makeConnection(connected);
    const view = createIndexView({
      connection: c.connection,
      loadIndex: async () => [{ id: "a", name: "Doc", service: "gdrive", url: "https://x" }],
    });
    const [group] = await view.getChildren();
    if (group === undefined) throw new Error("expected a service group");
    expect(group.label).toBe("Google Drive");
    expect(view.getTreeItem(group).collapsibleState).toBe(1);
    expect((await view.getChildren(group))[0]?.label).toBe("Doc");
  });

  test("a failing loadIndex renders a single error row", async () => {
    const c = makeConnection(connected);
    const view = createIndexView({
      connection: c.connection,
      loadIndex: async () => {
        throw new Error("index offline");
      },
    });
    const rows = (await view.getChildren()) as Array<{ label: string; tooltip?: string }>;
    expect(rows[0]?.label).toMatch(/failed to load index/i);
    expect(rows[0]?.tooltip).toBe("index offline");
  });
});

describe("applyThemeIcons", () => {
  test("resolves iconId to iconPath via the factory and strips iconId", () => {
    const c = makeConnection({ kind: "disconnected", socketPath: "/s", reason: "x" });
    const view = createPlaceholderView({ connection: c.connection, emptyLabel: "e" });
    const wrapped = applyThemeIcons(view, (id) => ({ themeIcon: id }));
    const item = wrapped.getTreeItem({ label: "row", iconId: "debug-disconnect" });
    expect(item.iconPath).toEqual({ themeIcon: "debug-disconnect" });
    expect(item.iconId).toBeUndefined();
  });

  test("passes rows without an icon through untouched", () => {
    const c = makeConnection({ kind: "connected", socketPath: "/s" });
    const view = createPlaceholderView({ connection: c.connection, emptyLabel: "empty" });
    let calls = 0;
    const wrapped = applyThemeIcons(view, (id) => {
      calls += 1;
      return id;
    });
    const item = wrapped.getTreeItem({ label: "empty" });
    expect(item.iconPath).toBeUndefined();
    expect(calls).toBe(0);
  });

  test("forwards getChildren and onDidChangeTreeData to the wrapped view", async () => {
    const c = makeConnection({ kind: "connected", socketPath: "/s" });
    const view = createPlaceholderView({ connection: c.connection, emptyLabel: "empty" });
    const wrapped = applyThemeIcons(view, (id) => id);
    expect(await wrapped.getChildren()).toEqual([{ label: "empty" }]);
    let fired = 0;
    wrapped.onDidChangeTreeData?.(() => {
      fired += 1;
    });
    c.set({ kind: "idle" });
    expect(fired).toBe(1);
  });
});

describe("one-level nesting", () => {
  test("toTreeItem marks a row with children collapsible and forwards contextValue", () => {
    const item = toTreeItem({ label: "svc", contextValue: "grp", children: [{ label: "kid" }] });
    expect(item.collapsibleState).toBe(1);
    expect(item.contextValue).toBe("grp");
  });

  test("toTreeItem leaves a childless row as a leaf", () => {
    expect(toTreeItem({ label: "leaf" }).collapsibleState).toBe(0);
    expect(toTreeItem({ label: "leaf", children: [] }).collapsibleState).toBe(0);
  });

  test("createDataView returns a parent's children, and [] for leaves", async () => {
    const connected: ConnectionState = { kind: "connected", socketPath: "/s" };
    const c = makeConnection(connected);
    const view = createDataView({
      connection: c.connection,
      loadData: async () => [{ label: "svc", children: [{ label: "kid" }] }],
    });
    const [parent] = await view.getChildren();
    if (parent === undefined) throw new Error("expected a parent row");
    expect(await view.getChildren(parent)).toEqual([{ label: "kid" }]);
    const [kid] = (await view.getChildren(parent)) as Array<{ label: string }>;
    expect(await view.getChildren(kid as never)).toEqual([]);
  });
});
