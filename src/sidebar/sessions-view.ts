import { type SessionSummary, sessionToItem } from "./sessions.js";
import {
  connectionPlaceholder,
  createEmitter,
  type SidebarConnection,
  type SidebarItem,
  type SidebarView,
  toTreeItem,
} from "./tree-view.js";

// Session history browser (design surface #6). Lists persisted sessions; each
// row opens (rehydrates) that session in the chat panel via nimbus.openSession.
// `loadSessions` is injected so the schema-coupled query lives in the
// composition root, keeping this view pure and swappable for a typed client
// method later.
export function createSessionsView(deps: {
  connection: SidebarConnection;
  loadSessions: () => Promise<SessionSummary[]>;
  now?: () => number;
}): SidebarView {
  const emitter = createEmitter<SidebarItem | undefined>();
  const sub = deps.connection.onState(() => emitter.fire(undefined));

  const loadRows = async (): Promise<SidebarItem[]> => {
    const placeholder = connectionPlaceholder(deps.connection.current());
    if (placeholder !== undefined) return placeholder;
    try {
      const sessions = await deps.loadSessions();
      if (sessions.length === 0) return [{ label: "No saved sessions yet" }];
      const now = (deps.now ?? Date.now)();
      return sessions.map((session) => sessionToItem(session, now));
    } catch (err) {
      return [
        {
          label: "Failed to load sessions",
          tooltip: err instanceof Error ? err.message : String(err),
          iconId: "error",
        },
      ];
    }
  };

  return {
    onDidChangeTreeData: emitter.event,
    getTreeItem: (item) => toTreeItem(item),
    getChildren: async (element) => (element === undefined ? await loadRows() : []),
    refresh: () => emitter.fire(undefined),
    dispose: () => {
      sub.dispose();
      emitter.dispose();
    },
  };
}
