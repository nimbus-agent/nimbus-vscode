import { createPlaceholderView, type SidebarConnection, type SidebarView } from "./tree-view.js";

// Session history browser (design surface #6). Phase 1 ships the empty
// scaffold; a later phase lists persisted sessions and rehydrates them into the
// chat panel.
export function createSessionsView(deps: { connection: SidebarConnection }): SidebarView {
  return createPlaceholderView({
    connection: deps.connection,
    emptyLabel: "No saved sessions yet",
  });
}
