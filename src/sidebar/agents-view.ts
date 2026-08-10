import { type Agent, agentsTreeRows } from "./agents.js";
import { createDataView, type SidebarConnection, type SidebarView } from "./tree-view.js";

// Agent runner (design surface #3). Two groups: the built-in briefs the client
// types, and the chat scopes from the nimbus.agents setting. The settings-coupled
// `loadAgents` and the `activeAgentId` getter are injected from the composition
// root, keeping this view pure.
//
// The view is never empty: the built-in group always has rows, which is the
// point — the view named after the product's core used to render
// "No agents configured" on a fresh install.
export function createAgentsView(deps: {
  connection: SidebarConnection;
  loadAgents: () => Agent[];
  activeAgentId: () => string | undefined;
}): SidebarView {
  return createDataView({
    connection: deps.connection,
    loadData: async () => agentsTreeRows(deps.loadAgents(), deps.activeAgentId()),
  });
}
