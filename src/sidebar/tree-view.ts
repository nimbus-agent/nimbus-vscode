import type { ConnectionState } from "../connection/connection-manager.js";
import type { DisposableLike, TreeDataProviderLike, TreeItemLike } from "../vscode-shim.js";

// The slice of the connection manager a sidebar view needs: the current state
// plus a subscription so the view can refresh when connectivity changes. The
// real ConnectionManager satisfies this structurally.
export interface SidebarConnection {
  current(): ConnectionState;
  onState(listener: (s: ConnectionState) => void): DisposableLike;
}

// A single row rendered by a sidebar view. Plain data — no vscode types — so
// providers stay pure and unit-testable; extension.ts maps these to TreeItems.
export interface SidebarItem {
  readonly label: string;
  readonly description?: string;
  readonly tooltip?: string;
  readonly command?: { command: string; title: string; arguments?: unknown[] };
}

export interface SidebarView extends TreeDataProviderLike<SidebarItem> {
  dispose(): void;
}

// A minimal typed event source whose `event` is shape-compatible with a
// vscode.Event<T>, so it can back TreeDataProvider.onDidChangeTreeData without
// pulling in vscode.EventEmitter.
export interface Emitter<T> {
  readonly event: (listener: (e: T) => void) => DisposableLike;
  fire(e: T): void;
  dispose(): void;
}

export function createEmitter<T>(): Emitter<T> {
  const listeners = new Set<(e: T) => void>();
  return {
    event: (listener) => {
      listeners.add(listener);
      return {
        dispose: () => {
          listeners.delete(listener);
        },
      };
    },
    fire: (e) => {
      for (const listener of listeners) listener(e);
    },
    dispose: () => {
      listeners.clear();
    },
  };
}

// The connection-aware rows shown by an otherwise-empty view. Each view passes
// its own `emptyLabel` for the connected-but-no-data case; everything else is
// shared so all four views degrade identically when the Gateway is unreachable.
export function placeholderItems(state: ConnectionState, emptyLabel: string): SidebarItem[] {
  switch (state.kind) {
    case "connected":
      return [{ label: emptyLabel }];
    case "idle":
    case "connecting":
    case "starting-gateway":
      return [{ label: "Connecting to the Nimbus Gateway…" }];
    case "permission-denied":
      return [
        {
          label: "Gateway socket permission denied",
          tooltip: `Permission denied accessing ${state.socketPath}`,
          command: { command: "nimbus.openLogs", title: "Show Logs" },
        },
      ];
    case "disconnected":
      return [
        {
          label: "Not connected — click to reconnect",
          tooltip: state.reason,
          command: { command: "nimbus.reconnect", title: "Reconnect to Gateway" },
        },
      ];
  }
}

function toTreeItem(item: SidebarItem): TreeItemLike {
  // Build incrementally so we never assign `undefined` to an optional field
  // (tsconfig has exactOptionalPropertyTypes). Phase 1 rows are leaf
  // placeholders (TreeItemCollapsibleState.None = 0).
  const treeItem: TreeItemLike = { label: item.label, collapsibleState: 0 };
  if (item.description !== undefined) treeItem.description = item.description;
  if (item.tooltip !== undefined) treeItem.tooltip = item.tooltip;
  if (item.command !== undefined) treeItem.command = item.command;
  return treeItem;
}

// Shared factory for the Phase 1 scaffold views: each renders connection-aware
// placeholder rows and refreshes whenever the connection state changes. Later
// phases replace `getChildren` with real data while keeping this DI shape.
export function createPlaceholderView(deps: {
  connection: SidebarConnection;
  emptyLabel: string;
}): SidebarView {
  const emitter = createEmitter<SidebarItem | undefined>();
  const sub = deps.connection.onState(() => emitter.fire(undefined));
  return {
    onDidChangeTreeData: emitter.event,
    getTreeItem: (item) => toTreeItem(item),
    getChildren: () => placeholderItems(deps.connection.current(), deps.emptyLabel),
    dispose: () => {
      sub.dispose();
      emitter.dispose();
    },
  };
}
