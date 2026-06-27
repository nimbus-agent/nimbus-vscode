import { groupByService, type IndexItem, indexToTree } from "./index.js";
import { createDataView, errorRow, type SidebarConnection, type SidebarView } from "./tree-view.js";

// Index browser (design surface #5). Groups indexed items by service into a
// two-level tree; each item opens its source via nimbus.openIndexItem.
// `loadIndex` is injected so the schema-coupled queryItems call lives in the
// composition root, keeping this view pure and swappable for a typed client
// method later.
export function createIndexView(deps: {
  connection: SidebarConnection;
  loadIndex: () => Promise<IndexItem[]>;
}): SidebarView {
  return createDataView({
    connection: deps.connection,
    loadData: async () => {
      try {
        const items = await deps.loadIndex();
        if (items.length === 0) return [{ label: "No indexed items yet" }];
        return indexToTree(groupByService(items));
      } catch (err) {
        return [errorRow("Failed to load index", err)];
      }
    },
  });
}
