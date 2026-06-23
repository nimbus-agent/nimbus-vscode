import { createPlaceholderView, type SidebarConnection, type SidebarView } from "./tree-view.js";

// Index search browser (design surface #5). Phase 1 ships the empty scaffold;
// a later phase wires `getChildren` to client.queryItems() with service/type
// filters.
export function createIndexView(deps: { connection: SidebarConnection }): SidebarView {
  return createPlaceholderView({
    connection: deps.connection,
    emptyLabel: "No indexed items yet",
  });
}
