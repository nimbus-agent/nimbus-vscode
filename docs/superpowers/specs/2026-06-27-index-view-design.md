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
- Primary click on an item opens its source (url externally, else path in editor).
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

Items are untyped records. The existing `nimbus.search` handler reads
`title`, `id`, `service`, `url`, `path` off each row; we follow the same field
names and coerce defensively (rows are external `unknown` data).

## Architecture

### New — `src/sidebar/index.ts` (pure, schema-free core)

No `vscode` imports. Mirrors the `sessions.ts` split (pure parse/format helpers;
the schema-coupled query lives in the composition root).

```ts
export interface IndexItem {
  readonly id: string;
  readonly title: string;
  readonly service: string;        // "" → grouped under an "(unknown)" bucket
  readonly type?: string;
  readonly url?: string;
  readonly path?: string;
  readonly timestampMs?: number;
}

export interface ServiceGroup {
  readonly service: string;
  readonly items: IndexItem[];
}

// Defensive coercion over one untyped queryItems row. Returns undefined when the
// row has no usable id (which becomes the item's stable identity / fallback label).
export function parseIndexRow(row: Record<string, unknown>): IndexItem | undefined;

// Group items by service. Services sorted alphabetically; items newest-first
// within each group (by timestampMs when present, else input order preserved).
export function groupByService(items: IndexItem[]): ServiceGroup[];

// Build the two-level SidebarItem tree: a collapsible parent per service
// (label = service, description = item count), each carrying its item rows as
// `children`.
export function indexToTree(groups: ServiceGroup[]): SidebarItem[];
```

Item-row mapping (in `indexToTree`):
- `label` = `title` (fallback to `id`).
- `description` = `type` (when present).
- `tooltip` = `url` ?? `path` (when present).
- `command` = `{ command: "nimbus.openIndexItem", title: "Open", arguments: [item] }`
  **only when** the item has a `url` or `path`; otherwise no command (the row is
  still reachable via the right-click Ask action).
- `contextValue` = `"nimbusIndexItem"` (drives the `view/item/context` menu).
- `iconId` for a sensible codicon (e.g. `"file"`); service rows use e.g. `"folder"`.

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
  - `nimbus.openIndexItem` — argument is the `IndexItem`. If `url`, open via
    `vscode.env.openExternal(vscode.Uri.parse(url))`; else if `path`, open via
    `vscode.commands.executeCommand("vscode.open", vscode.Uri.file(path))`; else
    no-op. (Real `vscode` is already used at the composition root for the
    `ThemeIcon` factory, so this glue belongs here, outside the pure modules.)
  - `nimbus.askAboutIndexItem` — argument is the `IndexItem`. Builds a prompt
    (e.g. ``Tell me about this indexed item:\n\n${title}${url ? `\n${url}` : ""}``),
    then `ensureChatController()` → `ctl.start(prompt)`. Reuses the
    `askAboutSelection` shape.
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
| Item with neither url nor path | Leaf row, **no** command; still Ask-able via context menu. |

## Testing

- **`test/unit/index.test.ts`** (new, pure):
  - `parseIndexRow`: well-formed row; missing id → `undefined`; garbage/extra
    fields; url-only and path-only rows.
  - `groupByService`: grouping correctness, alphabetical service order,
    newest-first within group, empty input, blank-service bucket.
  - `indexToTree`: parents collapsible with correct counts; item rows carry a
    command only when a target exists; `contextValue` set; label fallback to id.
- **`test/unit/sidebar-views.test.ts`**:
  - index-view empty / error / loaded paths.
  - new nesting path in `createDataView`: `getChildren(parent)` returns the
    parent's `children`; leaf rows still return `[]`.
- **`test/unit/extension.test.ts`**:
  - `loadIndex` maps rows and drops unparseable ones; rethrows on `queryItems`
    failure.
  - `nimbus.openIndexItem` prefers url over path; no-op when neither.
  - `nimbus.askAboutIndexItem` builds a prompt and calls `ctl.start`.
  - `nimbus.refreshIndex` triggers a re-render.
- **Bars:** `bun run typecheck`, `bun run lint`, `bun run test` (keep
  `src/sidebar` at 100% lines), `bun run build`, `bun run check-bundle`.

## Risks / open questions

- **`queryItems` field names** — assumed identical to what `nimbus.search` reads
  (`title`/`id`/`service`/`url`/`path`/timestamp). If a timestamp field name is
  unknown, `groupByService` falls back to input order (newest-first relies on the
  Gateway's default ordering); confirm the field during implementation.
- **Inline vs. submenu** for the Ask action — cosmetic; decide while wiring
  `package.json`.
- **`INDEX_LIMIT`** value — start with a sensible cap (e.g. 100) consistent with
  the search handler's `limit: 50`; tune if needed.
