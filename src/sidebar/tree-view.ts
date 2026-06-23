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
// providers stay pure and unit-testable; extension.ts maps these to TreeItems
// (and resolves `iconId` to a real ThemeIcon via applyThemeIcons).
export interface SidebarItem {
  readonly label: string;
  readonly description?: string;
  readonly tooltip?: string;
  /** A vscode ThemeIcon id (codicon), e.g. "pass" / "error" / "dash". */
  readonly iconId?: string;
  readonly command?: { command: string; title: string; arguments?: unknown[] };
}

export interface SidebarView extends TreeDataProviderLike<SidebarItem> {
  /** Force a re-render (fires onDidChangeTreeData). */
  refresh(): void;
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

// Connection-aware rows for any non-connected state, shared by every view so
// they all degrade identically when the Gateway is unreachable. Returns
// undefined when connected (the caller renders its own data instead).
export function connectionPlaceholder(state: ConnectionState): SidebarItem[] | undefined {
  switch (state.kind) {
    case "connected":
      return undefined;
    case "idle":
    case "connecting":
    case "starting-gateway":
      return [{ label: "Connecting to the Nimbus Gateway…" }];
    case "permission-denied":
      return [
        {
          label: "Gateway socket permission denied",
          tooltip: `Permission denied accessing ${state.socketPath}`,
          iconId: "error",
          command: { command: "nimbus.openLogs", title: "Show Logs" },
        },
      ];
    case "disconnected":
      return [
        {
          label: "Not connected — click to reconnect",
          tooltip: state.reason,
          iconId: "debug-disconnect",
          command: { command: "nimbus.reconnect", title: "Reconnect to Gateway" },
        },
      ];
  }
}

// The rows shown by an otherwise-empty view: the non-connected placeholder, or
// the view's own `emptyLabel` when connected with nothing to show.
export function placeholderItems(state: ConnectionState, emptyLabel: string): SidebarItem[] {
  return connectionPlaceholder(state) ?? [{ label: emptyLabel }];
}

export function toTreeItem(item: SidebarItem): TreeItemLike {
  // Build incrementally so we never assign `undefined` to an optional field
  // (tsconfig has exactOptionalPropertyTypes). Phase 1 rows are leaf
  // placeholders (TreeItemCollapsibleState.None = 0).
  const treeItem: TreeItemLike = { label: item.label, collapsibleState: 0 };
  if (item.description !== undefined) treeItem.description = item.description;
  if (item.tooltip !== undefined) treeItem.tooltip = item.tooltip;
  if (item.iconId !== undefined) treeItem.iconId = item.iconId;
  if (item.command !== undefined) treeItem.command = item.command;
  return treeItem;
}

// Wrap a view for registration with VS Code, resolving each row's `iconId` to a
// real ThemeIcon via the injected `makeIcon` factory (kept out of this pure
// module). Rows without an icon pass through untouched.
export function applyThemeIcons(
  view: SidebarView,
  makeIcon: (id: string) => unknown,
): TreeDataProviderLike<SidebarItem> {
  const provider: TreeDataProviderLike<SidebarItem> = {
    getChildren: (element) => view.getChildren(element),
    getTreeItem: (item) => {
      const treeItem = view.getTreeItem(item);
      if (treeItem.iconId === undefined) return treeItem;
      const { iconId, ...rest } = treeItem;
      return { ...rest, iconPath: makeIcon(iconId) };
    },
  };
  if (view.onDidChangeTreeData !== undefined) {
    provider.onDidChangeTreeData = view.onDidChangeTreeData;
  }
  return provider;
}

// Shared factory for the scaffold views: each renders connection-aware
// placeholder rows and refreshes whenever the connection state changes.
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
    refresh: () => emitter.fire(undefined),
    dispose: () => {
      sub.dispose();
      emitter.dispose();
    },
  };
}
