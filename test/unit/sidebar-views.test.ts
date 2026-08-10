import { describe, expect, test } from "vitest";

import type { ConnectionState } from "../../src/connection/connection-manager.js";
import { createAgentsView } from "../../src/sidebar/agents-view.js";
import { createIndexView } from "../../src/sidebar/index-view.js";
import {
  applyThemeIcons,
  connectionPlaceholder,
  createDataView,
  createPlaceholderView,
  type SidebarConnection,
  toTreeItem,
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

  test("disconnected renders an empty tree so the viewsWelcome content takes over", () => {
    // Load-bearing: VS Code shows a view's viewsWelcome (the start/troubleshoot
    // buttons, when "!nimbus.connected") only when the tree is EMPTY. A
    // placeholder row here would permanently suppress it.
    const items = connectionPlaceholder({
      kind: "disconnected",
      socketPath: "/s",
      reason: "ECONNREFUSED",
    });
    expect(items).toEqual([]);
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
    const c = makeConnection({ kind: "permission-denied", socketPath: "/s" });
    const view = createPlaceholderView({ connection: c.connection, emptyLabel: "x" });
    const [row] = await view.getChildren();
    if (row === undefined) throw new Error("expected a placeholder row");
    const item = view.getTreeItem(row);
    expect(item.collapsibleState).toBe(0);
    expect(item.label).toMatch(/permission denied/i);
    expect(item.command?.command).toBe("nimbus.openLogs");
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

describe("createAgentsView", () => {
  const connected: ConnectionState = { kind: "connected", socketPath: "/s" };

  // The view is never empty now: the built-in briefs group always has rows.
  // That is the whole point of the change — the view named after the product's
  // core used to render "No agents configured" on a fresh install.
  test("with no configured agents it still shows the built-in briefs", async () => {
    const view = createAgentsView({
      connection: makeConnection(connected).connection,
      loadAgents: () => [],
      activeAgentId: () => undefined,
    });
    const groups = await view.getChildren();
    expect(groups[0]?.label).toBe("Built-in briefs");
    expect((groups[0]?.children ?? []).length).toBeGreaterThan(0);
  });

  test("with no configured agents the second group keeps settings discoverable", async () => {
    const view = createAgentsView({
      connection: makeConnection(connected).connection,
      loadAgents: () => [],
      activeAgentId: () => undefined,
    });
    const configured = (await view.getChildren())[1];
    expect(configured?.label).toBe("Configured agents");
    expect(configured?.children?.[0]?.label).toMatch(/configure agents in settings/i);
  });

  test("renders configured agents as clickable rows", async () => {
    const view = createAgentsView({
      connection: makeConnection(connected).connection,
      loadAgents: () => [{ id: "researcher", label: "Researcher" }],
      activeAgentId: () => undefined,
    });
    const row = (await view.getChildren())[1]?.children?.[0];
    expect(row?.label).toBe("Researcher");
    expect(row?.command?.command).toBe("nimbus.openAgentChat");
    expect(row?.description).toBeUndefined();
  });

  test("marks the active agent", async () => {
    const view = createAgentsView({
      connection: makeConnection(connected).connection,
      loadAgents: () => [{ id: "researcher", label: "Researcher" }],
      activeAgentId: () => "researcher",
    });
    const row = (await view.getChildren())[1]?.children?.[0];
    expect(row?.description).toBe("(active)");
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
