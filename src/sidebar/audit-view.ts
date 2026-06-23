import { type AuditEntry, auditEntryToItem, parseAuditEntry } from "./audit.js";
import {
  connectionPlaceholder,
  createEmitter,
  type SidebarConnection,
  type SidebarItem,
  type SidebarView,
  toTreeItem,
} from "./tree-view.js";

// The Gateway client capability this view needs. The real NimbusClient
// satisfies it; tests pass a fake (or MockClient).
export interface AuditClientLike {
  auditList(limit?: number): Promise<unknown[]>;
}

const NOT_CONNECTED_ROW: SidebarItem = {
  label: "Not connected — click to reconnect",
  iconId: "debug-disconnect",
  command: { command: "nimbus.reconnect", title: "Reconnect to Gateway" },
};

// Audit / egress viewer (design surface #1). Lists recent audit entries from
// client.auditList(), one row per entry (actionType + relative time, icon by
// HITL status). Clicking a row opens its detail via nimbus.openAuditEntry.
export function createAuditView(deps: {
  connection: SidebarConnection;
  getClient: () => AuditClientLike | undefined;
  limit?: number;
  now?: () => number;
}): SidebarView {
  const emitter = createEmitter<SidebarItem | undefined>();
  const sub = deps.connection.onState(() => emitter.fire(undefined));

  const loadRows = async (): Promise<SidebarItem[]> => {
    const placeholder = connectionPlaceholder(deps.connection.current());
    if (placeholder !== undefined) return placeholder;
    const client = deps.getClient();
    if (client === undefined) return [NOT_CONNECTED_ROW];
    try {
      const raw = await client.auditList(deps.limit ?? 100);
      const entries: AuditEntry[] = [];
      for (const row of raw) {
        const entry = parseAuditEntry(row);
        if (entry !== undefined) entries.push(entry);
      }
      if (entries.length === 0) return [{ label: "No audit entries yet" }];
      const now = (deps.now ?? Date.now)();
      return entries.map((entry) => auditEntryToItem(entry, now));
    } catch (err) {
      return [
        {
          label: "Failed to load the audit log",
          tooltip: err instanceof Error ? err.message : String(err),
          iconId: "error",
        },
      ];
    }
  };

  return {
    onDidChangeTreeData: emitter.event,
    getTreeItem: (item) => toTreeItem(item),
    getChildren: async (element) => (element === undefined ? await loadRows() : []),
    refresh: () => emitter.fire(undefined),
    dispose: () => {
      sub.dispose();
      emitter.dispose();
    },
  };
}
