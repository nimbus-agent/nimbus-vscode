import {
  createDataView,
  errorRow,
  type SidebarConnection,
  type SidebarItem,
  type SidebarView,
} from "../sidebar/tree-view.js";
import type { ConnectorOps } from "./connector-client.js";
import { connectorPayloadOf, connectorRows, healthEntryToItem, telemetryToItem } from "./rows.js";

const ADD_MCP_ROW: SidebarItem = {
  label: "Add an MCP connector…",
  iconId: "add",
  command: { command: "nimbus.addMcpConnector", title: "Add MCP Connector" },
};

/**
 * The Connectors view: one row per registered connector, its recent syncs and
 * health transitions underneath. Detail loads on expand — eager children would
 * cost two round trips per connector on every open, for rows nobody looked at.
 *
 * Every call here is read-only and reaches no model.
 */
export function createConnectorsView(deps: {
  connection: SidebarConnection;
  ops: ConnectorOps;
  now?: () => number;
}): SidebarView {
  const now = (): number => (deps.now ?? Date.now)();
  return createDataView({
    connection: deps.connection,
    loadData: async () => {
      try {
        const statuses = await deps.ops.list();
        if (statuses.length === 0) {
          return [{ label: "No connectors registered", iconId: "info" }, ADD_MCP_ROW];
        }
        return connectorRows(statuses, now());
      } catch (err) {
        return [errorRow("Failed to load connectors", err)];
      }
    },
    loadChildren: async (item) => {
      const payload = connectorPayloadOf(item);
      // A group row, or a row we did not build, has no connector to fetch for.
      if (payload === undefined) return item.children ?? [];
      try {
        const at = now();
        const [detail, history] = await Promise.all([
          deps.ops.detail(payload.serviceId),
          deps.ops.history(payload.serviceId),
        ]);
        const syncs = (detail.telemetry ?? []).map((t) => telemetryToItem(t, at));
        const groups: SidebarItem[] = [
          {
            label: "Recent syncs",
            iconId: "history",
            children: syncs.length > 0 ? syncs : [{ label: "Never synced", iconId: "info" }],
          },
        ];
        // Omitted rather than empty for an mcp_* id: ops.history skips the call
        // the Gateway would reject, and a "no history" row would misreport why.
        if (history.length > 0) {
          groups.push({
            label: "Health history",
            iconId: "pulse",
            children: history.map((h) => healthEntryToItem(h, at)),
          });
        }
        return groups;
      } catch (err) {
        // Scoped to this connector: one unreadable detail must not blank the view.
        return [errorRow("Failed to load connector detail", err)];
      }
    },
  });
}
