import { type AuditEntry, auditEntryToItem, parseAuditEntry } from "./audit.js";
import { parseAll } from "./parse-helpers.js";
import {
  createDataView,
  errorRow,
  NOT_CONNECTED_ROW,
  type SidebarConnection,
  type SidebarView,
} from "./tree-view.js";

// The Gateway client capability this view needs. The real NimbusClient
// satisfies it; tests pass a fake (or MockClient).
export interface AuditClientLike {
  auditList(limit?: number): Promise<unknown[]>;
}

// Audit / egress viewer (design surface #1). Lists recent audit entries from
// client.auditList(), one row per entry (actionType + relative time, icon by
// HITL status). Clicking a row opens its detail via nimbus.openAuditEntry.
export function createAuditView(deps: {
  connection: SidebarConnection;
  getClient: () => AuditClientLike | undefined;
  limit?: number;
  now?: () => number;
}): SidebarView {
  return createDataView({
    connection: deps.connection,
    loadData: async () => {
      const client = deps.getClient();
      if (client === undefined) return [NOT_CONNECTED_ROW];
      try {
        const entries: AuditEntry[] = parseAll(
          await client.auditList(deps.limit ?? 100),
          parseAuditEntry,
        );
        if (entries.length === 0) return [{ label: "No audit entries yet" }];
        const now = (deps.now ?? Date.now)();
        return entries.map((entry) => auditEntryToItem(entry, now));
      } catch (err) {
        return [errorRow("Failed to load the audit log", err)];
      }
    },
  });
}
