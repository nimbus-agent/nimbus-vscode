import { type Agent, agentsToRows } from "./agents.js";
import { createDataView, type SidebarConnection, type SidebarView } from "./tree-view.js";

// Agent runner (design surface #3). Renders the agents configured in the
// nimbus.agents setting; clicking one opens a chat scoped to that agent. The
// settings-coupled `loadAgents` and the `activeAgentId` getter are injected from
// the composition root, keeping this view pure.
export function createAgentsView(deps: {
  connection: SidebarConnection;
  loadAgents: () => Agent[];
  activeAgentId: () => string | undefined;
}): SidebarView {
  return createDataView({
    connection: deps.connection,
    loadData: async () => {
      const agents = deps.loadAgents();
      if (agents.length === 0) return [{ label: "No agents configured" }];
      return agentsToRows(agents, deps.activeAgentId());
    },
  });
}
