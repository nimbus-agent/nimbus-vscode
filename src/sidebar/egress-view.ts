import { type EgressRow, egressRowToItem, parseEgressRow } from "./egress.js";
import {
  createDataView,
  errorRow,
  type SidebarConnection,
  type SidebarItem,
  type SidebarView,
} from "./tree-view.js";

// The Gateway client capability this view needs. The real NimbusClient
// satisfies it; tests pass a fake.
export interface EgressClientLike {
  egressList(params?: {
    since?: number;
    until?: number;
    limit?: number;
  }): Promise<{ rows: unknown[] }>;
}

// Default number of ledger rows to pull. The Gateway clamps to 1..5000; we cap
// lower to keep the tree responsive (cf. INDEX_LIMIT).
const EGRESS_LIMIT = 200;

const NOT_CONNECTED_ROW: SidebarItem = {
  label: "Not connected — click to reconnect",
  iconId: "debug-disconnect",
  command: { command: "nimbus.reconnect", title: "Reconnect to Gateway" },
};

// Egress ledger viewer. Lists recent rows from client.egressList(), one row per
// entry (destination.method + relative time, icon by resultStatus). Clicking a
// row opens its detail via nimbus.openEgressEntry.
export function createEgressView(deps: {
  connection: SidebarConnection;
  getClient: () => EgressClientLike | undefined;
  limit?: number;
  now?: () => number;
}): SidebarView {
  return createDataView({
    connection: deps.connection,
    loadData: async () => {
      const client = deps.getClient();
      if (client === undefined) return [NOT_CONNECTED_ROW];
      try {
        const { rows } = await client.egressList({ limit: deps.limit ?? EGRESS_LIMIT });
        const parsed: EgressRow[] = [];
        for (const raw of rows) {
          const row = parseEgressRow(raw);
          if (row !== undefined) parsed.push(row);
        }
        if (parsed.length === 0) return [{ label: "No egress entries yet" }];
        const now = (deps.now ?? Date.now)();
        return parsed.map((row) => egressRowToItem(row, now));
      } catch (err) {
        return [errorRow("Failed to load the egress ledger", err)];
      }
    },
  });
}
