# Index view — design

**Date:** 2026-06-27
**Status:** Approved (brainstorm), pending implementation plan
**Branch:** `feat/sidebar-sessions`

## Summary

Flesh out the **Index** sidebar view (design surface #5), currently an empty
scaffold (`createPlaceholderView`, "No indexed items yet"). The view becomes a
**launchpad**: indexed items are grouped by service in a two-level tree; a
primary click opens an item's source, and a context-menu action asks Nimbus
about it in the chat panel.

This is the next step in the sidebar series after Audit (#9) and Sessions (#6).
Like Sessions, it reuses an existing, proven client capability —
`client.queryItems(...)`, already used by the `nimbus.search` command — so it
needs **no Gateway bump and no `@nimbus-dev/client` version change**.

## Goals

- Surface what's in the local index, grouped by service, newest-first.
- Primary click on an item opens its source `url` (by scheme: `file:` in the
  editor, `http(s):` externally).
- Right-click → "Ask Nimbus about this" seeds the chat panel with a prompt about
  the item, reusing the existing `askAboutSelection` flow.
- Introduce **one level of tree nesting** as a reusable capability in the shared
  `tree-view.ts`, not as view-local boilerplate.

## Non-goals (YAGNI for v1)

- Lazy per-service fetching (one bulk query is sufficient; there is no
  distinct-services API, so eager is simplest).
- Service/type filter controls or search-within-index (the flat search Quick
  Pick via `nimbus.search` already exists).
- Pagination / "load more" beyond a single `limit`.
- Any write/agent-invoke surface (Agents view #3 remains deferred per CLAUDE.md).

## Decisions (from brainstorm)

| Question | Decision |
| --- | --- |
| Purpose of the view | Launchpad to act — each item is an entry point. |
| Primary click | Open the item's source. |
| Secondary action | Right-click "Ask Nimbus about this" → chat. |
| List shape | Grouped by service (two-level tree). |
| Fetch strategy | Eager: one `queryItems({ limit })`, group in memory. |
| Nesting | Generic one-level nesting added to shared `tree-view.ts`. |

## API reference

`@nimbus-dev/client` `NimbusClient.queryItems`:

```ts
queryItems(params: {
  services?: string[];
  types?: string[];
  sinceMs?: number;
  untilMs?: number;
  limit?: number;
}): Promise<{
  items: Record<string, unknown>[];
  meta: { limit: number; total: number };
}>;
```

The real client erases items to `Record<string, unknown>[]`, but the
**authoritative shape is `NimbusItem`** from `@nimbus-dev/sdk` (the mock client
types `queryItems` as `NimbusItem[]`):

```ts
interface NimbusItem {
  id: string;
  service: string;
  itemType: "file" | "folder" | "email" | "event" | "photo" | "task";
  name: string;
  mimeType?: string;
  sizeBytes?: number;
  createdAt?: number;
  modifiedAt?: number;
  url?: string;
  parentId?: string;
  rawMeta?: Record<string, unknown>;
}
```

We **do not import `NimbusItem`** — CLAUDE.md mandates `@nimbus-dev/client` as
the only Nimbus dependency. We coerce defensively over `Record<string, unknown>`
but read the real field names: `name` (not `title`), `itemType` (not `type`),
`createdAt`/`modifiedAt` (not `timestampMs`), `url` (there is **no `path`
field**). Note: the existing `nimbus.search` handler reads `title`/`path`, which
do not exist on `NimbusItem` — it works only via its `?? id` fallback. That
latent mismatch is out of scope here but worth a follow-up.

## Architecture

### New — `src/sidebar/index.ts` (pure, schema-free core)

No `vscode` imports. Mirrors the `sessions.ts` split (pure parse/format helpers;
the schema-coupled query lives in the composition root).

```ts
// View-model projected from a NimbusItem row (we own this type; we do NOT import
// NimbusItem). Field names mirror NimbusItem so the defensive parse reads the
// real keys.
export interface IndexItem {
  readonly id: string;
  readonly name: string;
  readonly service: string;        // "" → grouped under an "(unknown)" bucket
  readonly itemType?: "file" | "folder" | "email" | "event" | "photo" | "task";
  readonly url?: string;
  readonly updatedMs?: number;     // modifiedAt ?? createdAt, for sorting
}

export interface ServiceGroup {
  readonly service: string;
  readonly items: IndexItem[];
}

// Defensive coercion over one untyped queryItems row. Reads name/service/
// itemType/url and updatedMs (modifiedAt ?? createdAt). Returns undefined when
// the row has no usable id (which is the item's stable identity / fallback name).
export function parseIndexRow(row: Record<string, unknown>): IndexItem | undefined;

// Group items by service. Services sorted alphabetically; items newest-first
// within each group (by updatedMs when present, else input order preserved).
export function groupByService(items: IndexItem[]): ServiceGroup[];

// Build the two-level SidebarItem tree: a collapsible parent per service
// (label = service, description = item count), each carrying its item rows as
// `children`.
export function indexToTree(groups: ServiceGroup[]): SidebarItem[];
```

Item-row mapping (in `indexToTree`):
- `label` = `name` (fallback to `id`).
- `description` = `itemType` (when present).
- `tooltip` = `url` (when present).
- `command` = `{ command: "nimbus.openIndexItem", title: "Open", arguments: [item] }`
  **only when** the item has a `url`; otherwise no command (the row is still
  reachable via the right-click Ask action).
- `contextValue` = `"nimbusIndexItem"` (drives the `view/item/context` menu).
- `iconId` mapped from `itemType` via a small authoritative table over the closed
  enum — `file`→`"file"`, `folder`→`"folder"`, `email`→`"mail"`,
  `event`→`"calendar"`, `photo`→`"device-camera"`, `task`→`"checklist"`; default
  `"file"`. Service (parent) rows use a generic `"folder"` icon for v1 (see
  Deferred — per-service branding).

### Extend — `src/sidebar/tree-view.ts` (the one shared change)

- Add to `SidebarItem`: `readonly children?: SidebarItem[]` and
  `readonly contextValue?: string`.
- `toTreeItem`: set `collapsibleState = 1` (Collapsed) when
  `item.children?.length`, else `0`; pass through `contextValue` when present
  (build incrementally — `exactOptionalPropertyTypes` is on).
- `createDataView`'s `getChildren`: return `element.children ?? []` for a
  non-root element instead of always `[]`. This is the generic one-level nesting
  and is reusable by any future view.

No behaviour change for the existing flat views: their rows have no `children`,
so they still render as leaves and `getChildren(element)` returns `[]`.

### Rewrite — `src/sidebar/index-view.ts`

Drops the placeholder; becomes a thin wrapper, structurally identical to
`sessions-view.ts`:

```ts
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
```

### Compose — `src/extension.ts`

- **`loadIndex` adapter** (next to `loadSessions`): isolates the schema/IPC
  coupling. Roughly:
  ```ts
  const loadIndex = async (): Promise<IndexItem[]> => {
    const c = connection.client() as NimbusClient | undefined;
    if (c === undefined) return [];
    const { items } = await c.queryItems({ limit: INDEX_LIMIT });
    return items.map(parseIndexRow).filter((x): x is IndexItem => x !== undefined);
  };
  ```
  On `queryItems` failure: log a warning via the output channel and rethrow, so
  the view renders its `errorRow` (matches `loadSessions`).
- Register `createIndexView({ connection, loadIndex })` in the `sidebarViews`
  array (replacing the placeholder entry).
- **Commands** (registered via the existing `register(...)` helper):
  - `nimbus.openIndexItem` — argument is the `IndexItem`. Opens `item.url` by
    scheme: `file:` → `vscode.commands.executeCommand("vscode.open", uri)`;
    `http`/`https` (or other) → `vscode.env.openExternal(uri)`; no `url` → no-op.
    The whole open is wrapped in try/catch; on failure (e.g. a file moved or
    deleted since indexing, or an unsupported scheme) show
    `vscode.window.showWarningMessage("Couldn't open <name>: <reason>")` rather
    than surfacing a raw error. (Real `vscode` is already used at the composition
    root for the `ThemeIcon` factory, so this glue belongs here, outside the pure
    modules.) `rawMeta` may carry additional location hints for some services —
    deferred; v1 opens via `url` only.
  - `nimbus.askAboutIndexItem` — argument is the `IndexItem`. Builds a structured
    prompt from the available fields, then `ensureChatController()` →
    `ctl.start(prompt)` (reuses the `askAboutSelection` shape):
    ```text
    Tell me about this indexed item:
    - Name: ${name}
    - Service: ${service}
    - Type: ${itemType ?? "unknown"}
    ${url ? `- URL: ${url}` : ""}
    ```
    No content/excerpt is included — `NimbusItem` exposes no body field
    (deferred; would need a client capability).
  - `nimbus.refreshIndex` — calls the view's `refresh()` (wired like
    `nimbus.refreshSessions`).

### `package.json`

- `views.nimbus` — the `nimbus.indexView` entry already exists; unchanged.
- `menus.view/title` — add a refresh button:
  `{ "command": "nimbus.refreshIndex", "when": "view == nimbus.indexView", "group": "navigation" }`.
- `menus.view/item/context` — add:
  `{ "command": "nimbus.askAboutIndexItem", "when": "view == nimbus.indexView && viewItem == nimbusIndexItem", "group": "inline" }`
  (or a non-inline group — decide during implementation).
- `menus.commandPalette` — hide the two item-scoped commands with `"when": "false"`
  (`nimbus.openIndexItem`, `nimbus.askAboutIndexItem`); `nimbus.refreshIndex` may
  stay visible like `nimbus.refreshSessions`.
- Declare all three commands in `contributes.commands`.

## Data flow

1. View first render / `refresh` / `nimbus.refreshIndex` fires
   `onDidChangeTreeData`.
2. `createDataView.getChildren(undefined)` → `connectionPlaceholder(state)`;
   if connected, `loadData()`.
3. `loadData` → `loadIndex()` → `queryItems({ limit })` → `parseIndexRow` ×
   rows → `groupByService` → `indexToTree` → collapsed service rows.
4. Expanding a service → `getChildren(serviceRow)` → `serviceRow.children`
   (item rows).
5. Click an item → `nimbus.openIndexItem` (open source).
6. Right-click an item → `nimbus.askAboutIndexItem` (seed chat).

## Error & empty states

| Situation | Render |
| --- | --- |
| Disconnected / connecting / permission-denied | Shared `connectionPlaceholder` (unchanged). |
| Connected, zero items | Single row "No indexed items yet". |
| `queryItems` throws | Single `errorRow("Failed to load index", err)`; warning logged. |
| Item with no `url` | Leaf row, **no** command; still Ask-able via context menu. |
| `url` open fails (moved/deleted/unsupported scheme) | `showWarningMessage`; tree unchanged. |

## Testing

- **`test/unit/index.test.ts`** (new, pure):
  - `parseIndexRow`: well-formed `NimbusItem`-shaped row; missing id →
    `undefined`; garbage/extra fields; url-present and url-absent rows;
    `updatedMs` from `modifiedAt`, falling back to `createdAt`.
  - `groupByService`: grouping correctness, alphabetical service order,
    newest-first (by `updatedMs`) within group, empty input, blank-service
    bucket.
  - `indexToTree`: parents collapsible with correct counts; item rows carry a
    command only when `url` is present; `contextValue` set; label fallback to id;
    `itemType`→`iconId` mapping (each enum value + default).
- **`test/unit/sidebar-views.test.ts`**:
  - index-view empty / error / loaded paths.
  - new nesting path in `createDataView`: `getChildren(parent)` returns the
    parent's `children`; leaf rows still return `[]`.
- **`test/unit/extension.test.ts`**:
  - `loadIndex` maps rows and drops unparseable ones; rethrows on `queryItems`
    failure.
  - `nimbus.openIndexItem` routes `file:` → `vscode.open` and `http(s):` →
    `openExternal`; no-op without `url`; a thrown open surfaces a warning, not a
    raw error.
  - `nimbus.askAboutIndexItem` builds the structured prompt and calls
    `ctl.start`.
  - `nimbus.refreshIndex` triggers a re-render.
- **Manual verification:** in the Extension Development Host, confirm pressing
  `Enter` / primary-selecting an item row fires `nimbus.openIndexItem` (default
  `registerTreeDataProvider` behaviour — we add no `TreeViewOptions` that could
  conflict), and the right-click "Ask Nimbus about this" appears only on item
  rows.
- **Bars:** `bun run typecheck`, `bun run lint`, `bun run test` (keep
  `src/sidebar` at 100% lines), `bun run build`, `bun run check-bundle`.

## Deferred (post-v1)

Recorded from review feedback (2026-06-27); each is a deliberate non-goal for v1:

- **Auto-refresh / polling** — no public index-changed event on the client (only
  `subscribeHitl`; `onNotification` is private transport state). Manual refresh
  matches Audit & Sessions. Revisit if the client exposes an index event.
- **Per-service branding (friendly names + service-specific icons)** — the real
  `service` string values are unobserved, so a mapping table now risks dead code.
  `groupByService`/`indexToTree` keep a single seam (one function maps a service
  string to a label+icon) so this drops in later; v1 renders the raw service
  string with a generic folder icon.
- **Excerpt/content in the Ask prompt** — `NimbusItem` has no body field; would
  need a new client capability.
- **Pagination / load-more** — single `INDEX_LIMIT` cap is sufficient for v1.

## Risks / open questions

- **`queryItems` field names** — RESOLVED. Verified against `NimbusItem`
  (`@nimbus-dev/sdk`, the mock client's `queryItems` element type): `name`,
  `service`, `itemType`, `createdAt`/`modifiedAt`, `url`. We read these via
  defensive coercion without importing the type. Sort key is
  `modifiedAt ?? createdAt`; absent both, input order is preserved (relies on the
  Gateway's default ordering).
- **`rawMeta` location hints** — some services may stash a richer location in
  `rawMeta`; v1 opens via `url` only. Inspect real data before relying on it.
- **Inline vs. submenu** for the Ask action — cosmetic; decide while wiring
  `package.json`.
- **`INDEX_LIMIT`** value — start with a sensible cap (e.g. 100) consistent with
  the search handler's `limit: 50`; tune if needed.
