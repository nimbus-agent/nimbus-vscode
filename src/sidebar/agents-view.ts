import { createPlaceholderView, type SidebarConnection, type SidebarView } from "./tree-view.js";

// Agent / workflow runner (design surface #3). Phase 1 ships the empty
// scaffold; a later phase populates it from the `nimbus.agents` setting and
// invokes via client.agentInvoke().
export function createAgentsView(deps: { connection: SidebarConnection }): SidebarView {
  return createPlaceholderView({
    connection: deps.connection,
    emptyLabel: "No agents configured",
  });
}
