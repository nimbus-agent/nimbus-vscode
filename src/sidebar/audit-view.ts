import { createPlaceholderView, type SidebarConnection, type SidebarView } from "./tree-view.js";

// Audit / egress viewer (design surface #1). Phase 1 ships the empty scaffold;
// a later phase wires `getChildren` to client.auditList().
export function createAuditView(deps: { connection: SidebarConnection }): SidebarView {
  return createPlaceholderView({
    connection: deps.connection,
    emptyLabel: "No audit entries yet",
  });
}
