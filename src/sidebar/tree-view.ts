import type { ConnectionState } from "../connection/connection-manager.js";
import { errMsg } from "../logging.js";
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
  /** A vscode TreeItem contextValue, used to gate context-menu (view/item/context) commands. */
  readonly contextValue?: string;
  /** Child rows; when present and non-empty, this row renders collapsible. */
  readonly children?: SidebarItem[];
  /**
   * Overrides the children-derived collapsibility. A row whose children are
   * fetched lazily on expand (see `createDataView`'s `loadChildren`) declares
   * `children: []` and would otherwise render as an un-expandable leaf — with
   * no twistie, the load could never be triggered.
   */
  readonly collapsible?: boolean;
  /**
   * Domain object carried on the tree node. VS Code passes the NODE element
   * (this SidebarItem) — not `command.arguments` — to a view/item/context
   * command, so a menu handler reads its data from here. Untyped because it's
   * generic across views; consumers coerce it defensively.
   */
  readonly payload?: unknown;
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
      // Empty (not a row): an empty tree is what lets VS Code render the
      // viewsWelcome content for "!nimbus.connected", which carries the
      // Start Gateway / Troubleshoot buttons. A placeholder row here would
      // permanently suppress it.
      return [];
  }
}

// A standard error row for a view whose data load threw.
export function errorRow(label: string, err: unknown): SidebarItem {
  return { label, tooltip: errMsg(err), iconId: "error" };
}

export function toTreeItem(item: SidebarItem): TreeItemLike {
  // Build incrementally so we never assign `undefined` to an optional field
  // (tsconfig has exactOptionalPropertyTypes). A row with children renders
  // Collapsed (1); otherwise it's a leaf (None = 0).
  const hasChildren = item.children !== undefined && item.children.length > 0;
  const collapsibleState = (item.collapsible ?? hasChildren) ? 1 : 0;
  const treeItem: TreeItemLike = { label: item.label, collapsibleState };
  if (item.description !== undefined) treeItem.description = item.description;
  if (item.tooltip !== undefined) treeItem.tooltip = item.tooltip;
  if (item.contextValue !== undefined) treeItem.contextValue = item.contextValue;
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

// The shared sidebar view: connection-aware (renders a placeholder for any
// non-connected state), refreshes on state change, and otherwise renders
// `loadData()` rows. Every concrete view (audit, sessions, scaffolds) is a thin
// wrapper that supplies its own `loadData`, so the provider boilerplate lives
// in exactly one place.
export function createDataView(deps: {
  connection: SidebarConnection;
  loadData: () => Promise<SidebarItem[]>;
  /**
   * Resolve a row's children on expand rather than up front. Supplied only by
   * views whose children cost a round trip each — without it, populating them
   * eagerly would mean one RPC per row on open, for rows nobody expanded.
   * Omitted, `getChildren` behaves exactly as it always has.
   */
  loadChildren?: (item: SidebarItem) => Promise<SidebarItem[]>;
}): SidebarView {
  const emitter = createEmitter<SidebarItem | undefined>();
  const sub = deps.connection.onState(() => emitter.fire(undefined));
  const loadRows = async (): Promise<SidebarItem[]> => {
    const placeholder = connectionPlaceholder(deps.connection.current());
    return placeholder ?? (await deps.loadData());
  };
  const childrenOf = async (element: SidebarItem): Promise<SidebarItem[]> => {
    if (deps.loadChildren !== undefined) return await deps.loadChildren(element);
    return element.children ?? [];
  };
  return {
    onDidChangeTreeData: emitter.event,
    getTreeItem: (item) => toTreeItem(item),
    getChildren: async (element) =>
      element === undefined ? await loadRows() : await childrenOf(element),
    refresh: () => emitter.fire(undefined),
    dispose: () => {
      sub.dispose();
      emitter.dispose();
    },
  };
}

// A scaffold view: shows `emptyLabel` when connected with no data yet.
export function createPlaceholderView(deps: {
  connection: SidebarConnection;
  emptyLabel: string;
}): SidebarView {
  return createDataView({
    connection: deps.connection,
    loadData: async () => [{ label: deps.emptyLabel }],
  });
}

// Shown by every data view that has a connection but no client yet — one row,
// worded and wired identically everywhere, so "not connected" never means two
// different things in two panels of the same sidebar.
export const NOT_CONNECTED_ROW: SidebarItem = {
  label: "Not connected — click to reconnect",
  iconId: "debug-disconnect",
  command: { command: "nimbus.reconnect", title: "Reconnect to Gateway" },
};
