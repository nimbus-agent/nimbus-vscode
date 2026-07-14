import { type SessionSummary, sessionToItem } from "./sessions.js";
import { createDataView, errorRow, type SidebarConnection, type SidebarView } from "./tree-view.js";

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
  return createDataView({
    connection: deps.connection,
    loadData: async () => {
      try {
        const sessions = await deps.loadSessions();
        if (sessions.length === 0) return [{ label: "No saved sessions yet" }];
        const now = (deps.now ?? Date.now)();
        return sessions.map((session) => sessionToItem(session, now));
      } catch (err) {
        return [errorRow("Failed to load sessions", err)];
      }
    },
  });
}
