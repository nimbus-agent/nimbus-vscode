# Index View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the empty Index sidebar view into a launchpad that groups locally-indexed items by service in a two-level tree, opens an item's source on click, and asks Nimbus about it via a context-menu action.

**Architecture:** A new pure module `src/sidebar/index.ts` parses untyped `queryItems` rows into an `IndexItem` view-model, groups them by service, and projects them to `SidebarItem` rows. The shared `tree-view.ts` gains generic one-level nesting (parent rows carry `children`). `index-view.ts` becomes a thin `createDataView` wrapper over an injected `loadIndex()` thunk. `extension.ts` (the composition root) owns the schema-coupled `queryItems` call and three commands (`openIndexItem`, `askAboutIndexItem`, `refreshIndex`), with all real-`vscode` source-opening glue confined to an injected opener.

**Tech Stack:** TypeScript (strict), VS Code extension API (touched only via `src/vscode-shim.ts`), `@nimbus-dev/client` IPC, Vitest (with `vscode` aliased to `test/unit/vscode-stub.ts`), Biome, esbuild.

## Global Constraints

- TypeScript **strict**; **no `any`** — use `unknown` for external data and coerce.
- **No `console`** — log via the output channel (`log.warn`/`log.error`/`log.info`).
- **No non-null assertions** (`!`); build objects incrementally / conditionally (tsconfig has `exactOptionalPropertyTypes`).
- The only Nimbus dependency is `@nimbus-dev/client`. **Do NOT import `@nimbus-dev/sdk`** or anything else Nimbus. `NimbusItem` is a reference for field names only — we read them defensively off `Record<string, unknown>`.
- The `vscode` API is touched **only** through `src/vscode-shim.ts`, except at the composition root in `extension.ts` (which already imports real `vscode` for the `ThemeIcon` factory).
- `src/sidebar` must stay at **100% line coverage**.
- Bars that must pass before each commit: `bun run typecheck`, `bun run lint`, `bun run test`, `bun run build`, `bun run check-bundle`.
- Authoritative item field names (from `NimbusItem`): `id`, `service`, `itemType` (enum: `file`/`folder`/`email`/`event`/`photo`/`task`), `name`, `url`, `createdAt`, `modifiedAt`. There is **no** `title`/`type`/`path`/`timestampMs`.

---

## File structure

- **Create** `src/sidebar/index.ts` — pure: `IndexItem`/`ServiceGroup` types, `parseIndexRow`, `groupByService`, `iconForItemType`, `indexToTree`, `buildAskPrompt`.
- **Modify** `src/sidebar/tree-view.ts` — add `children?`/`contextValue?` to `SidebarItem`; nesting in `toTreeItem` + `createDataView.getChildren`.
- **Rewrite** `src/sidebar/index-view.ts` — `createIndexView({ connection, loadIndex })`.
- **Modify** `src/vscode-shim.ts` — add `showWarningMessage` to `WindowApi`.
- **Modify** `src/extension.ts` — `INDEX_LIMIT`, `loadIndex` adapter, `openSource` dep + `createSourceOpener` default, register the index view, three commands.
- **Modify** `package.json` — three command declarations + `view/title`, `view/item/context`, `commandPalette` menu entries.
- **Create** `test/unit/index.test.ts`; **modify** `test/unit/sidebar-views.test.ts`, `test/unit/extension.test.ts`, `test/unit/vscode-stub.ts`, `test/unit/hitl-surfaces.test.ts`.

---

## Task 1: Generic one-level nesting in the shared view layer

**Files:**
- Modify: `src/sidebar/tree-view.ts` (`SidebarItem` ~lines 15-22, `toTreeItem` ~96-106, `createDataView` `getChildren` ~148)
- Test: `test/unit/sidebar-views.test.ts`

**Interfaces:**
- Produces: `SidebarItem` now has optional `readonly children?: SidebarItem[]`, `readonly contextValue?: string`, and `readonly payload?: unknown` (a domain object the node carries for view/item/context commands). `toTreeItem(item)` sets `collapsibleState = 1` when `children` is non-empty (else `0`) and passes through `contextValue` (it does **not** copy `payload`/`children` onto the TreeItem). `createDataView(...).getChildren(parent)` returns `parent.children ?? []`.

- [ ] **Step 1: Write the failing tests**

Add to `test/unit/sidebar-views.test.ts`. First extend the import from `tree-view.js` to also pull in `createDataView` and `toTreeItem`:

```ts
import {
  applyThemeIcons,
  connectionPlaceholder,
  createDataView,
  createPlaceholderView,
  type SidebarConnection,
  toTreeItem,
} from "../../src/sidebar/tree-view.js";
```

Then append this describe block at the end of the file:

```ts
describe("one-level nesting", () => {
  test("toTreeItem marks a row with children collapsible and forwards contextValue", () => {
    const item = toTreeItem({ label: "svc", contextValue: "grp", children: [{ label: "kid" }] });
    expect(item.collapsibleState).toBe(1);
    expect(item.contextValue).toBe("grp");
  });

  test("toTreeItem leaves a childless row as a leaf", () => {
    expect(toTreeItem({ label: "leaf" }).collapsibleState).toBe(0);
    expect(toTreeItem({ label: "leaf", children: [] }).collapsibleState).toBe(0);
  });

  test("createDataView returns a parent's children, and [] for leaves", async () => {
    const connected: ConnectionState = { kind: "connected", socketPath: "/s" };
    const c = makeConnection(connected);
    const view = createDataView({
      connection: c.connection,
      loadData: async () => [{ label: "svc", children: [{ label: "kid" }] }],
    });
    const [parent] = await view.getChildren();
    if (parent === undefined) throw new Error("expected a parent row");
    expect(await view.getChildren(parent)).toEqual([{ label: "kid" }]);
    const [kid] = (await view.getChildren(parent)) as Array<{ label: string }>;
    expect(await view.getChildren(kid as never)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bunx vitest run test/unit/sidebar-views.test.ts -t "nesting"`
Expected: FAIL — `toTreeItem` is not exported / `collapsibleState` is `0` for a row with children; `getChildren(parent)` returns `[]`.

- [ ] **Step 3: Implement the nesting**

In `src/sidebar/tree-view.ts`, add the two optional fields to `SidebarItem` (after the existing `command` field):

```ts
  readonly command?: { command: string; title: string; arguments?: unknown[] };
  /** A vscode TreeItem contextValue, used to gate context-menu (view/item/context) commands. */
  readonly contextValue?: string;
  /** Child rows; when present and non-empty, this row renders collapsible. */
  readonly children?: SidebarItem[];
  /**
   * Domain object carried on the tree node. VS Code passes the NODE element
   * (this SidebarItem) — not `command.arguments` — to a view/item/context
   * command, so a menu handler reads its data from here. Untyped because it's
   * generic across views; consumers coerce it defensively.
   */
  readonly payload?: unknown;
```

Replace `toTreeItem` with:

```ts
export function toTreeItem(item: SidebarItem): TreeItemLike {
  // Build incrementally so we never assign `undefined` to an optional field
  // (tsconfig has exactOptionalPropertyTypes). A row with children renders
  // Collapsed (1); otherwise it's a leaf (None = 0).
  const collapsibleState = item.children !== undefined && item.children.length > 0 ? 1 : 0;
  const treeItem: TreeItemLike = { label: item.label, collapsibleState };
  if (item.description !== undefined) treeItem.description = item.description;
  if (item.tooltip !== undefined) treeItem.tooltip = item.tooltip;
  if (item.contextValue !== undefined) treeItem.contextValue = item.contextValue;
  if (item.iconId !== undefined) treeItem.iconId = item.iconId;
  if (item.command !== undefined) treeItem.command = item.command;
  return treeItem;
}
```

In `createDataView`, replace the `getChildren` line:

```ts
    getChildren: async (element) =>
      element === undefined ? await loadRows() : (element.children ?? []),
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bunx vitest run test/unit/sidebar-views.test.ts`
Expected: PASS (all existing tests plus the three new ones).

- [ ] **Step 5: Verify the bars**

Run: `bun run typecheck && bun run lint`
Expected: both exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/sidebar/tree-view.ts test/unit/sidebar-views.test.ts
git commit -m "feat(sidebar): generic one-level nesting in createDataView"
```

---

## Task 2: Pure `index.ts` module

**Files:**
- Create: `src/sidebar/index.ts`
- Test: `test/unit/index.test.ts`

**Interfaces:**
- Consumes: `SidebarItem` from `./tree-view.js` (incl. `children`/`contextValue` from Task 1).
- Produces:
  - `type IndexItemType = "file" | "folder" | "email" | "event" | "photo" | "task"`
  - `interface IndexItem { id: string; name: string; service: string; itemType?: IndexItemType; url?: string; updatedMs?: number }`
  - `interface ServiceGroup { service: string; items: IndexItem[] }`
  - `parseIndexRow(raw: unknown): IndexItem | undefined`
  - `groupByService(items: IndexItem[]): ServiceGroup[]`
  - `iconForItemType(itemType: IndexItem["itemType"]): string`
  - `indexToTree(groups: ServiceGroup[]): SidebarItem[]`
  - `buildAskPrompt(item: IndexItem): string`

- [ ] **Step 1: Write the failing tests**

Create `test/unit/index.test.ts`:

```ts
import { describe, expect, test } from "vitest";

import {
  buildAskPrompt,
  groupByService,
  iconForItemType,
  type IndexItem,
  indexToTree,
  parseIndexRow,
} from "../../src/sidebar/index.js";

describe("parseIndexRow", () => {
  test("reads NimbusItem fields and derives updatedMs from modifiedAt", () => {
    const item = parseIndexRow({
      id: "i1",
      name: "Report",
      service: "gdrive",
      itemType: "file",
      url: "https://x/y",
      createdAt: 100,
      modifiedAt: 200,
    });
    expect(item).toEqual({
      id: "i1",
      name: "Report",
      service: "gdrive",
      itemType: "file",
      url: "https://x/y",
      updatedMs: 200,
    });
  });

  test("falls back to createdAt when modifiedAt is absent", () => {
    expect(parseIndexRow({ id: "i", createdAt: 5 })?.updatedMs).toBe(5);
  });

  test("name falls back to id; unknown itemType is dropped", () => {
    const item = parseIndexRow({ id: "i2", itemType: "wormhole" });
    expect(item?.name).toBe("i2");
    expect(item?.itemType).toBeUndefined();
  });

  test("returns undefined without a usable id or for a non-object", () => {
    expect(parseIndexRow({ name: "no id" })).toBeUndefined();
    expect(parseIndexRow(null)).toBeUndefined();
    expect(parseIndexRow("nope")).toBeUndefined();
  });
});

describe("groupByService", () => {
  const items: IndexItem[] = [
    { id: "a", name: "A", service: "slack", updatedMs: 1 },
    { id: "b", name: "B", service: "gdrive", updatedMs: 3 },
    { id: "c", name: "C", service: "gdrive", updatedMs: 2 },
    { id: "d", name: "D", service: "" },
  ];

  test("groups by service, sorts groups alphabetically, items newest-first", () => {
    const groups = groupByService(items);
    expect(groups.map((g) => g.service)).toEqual(["(unknown)", "gdrive", "slack"]);
    const gdrive = groups.find((g) => g.service === "gdrive");
    expect(gdrive?.items.map((i) => i.id)).toEqual(["b", "c"]);
  });

  test("empty input yields no groups", () => {
    expect(groupByService([])).toEqual([]);
  });
});

describe("iconForItemType", () => {
  test("maps each enum value and defaults to file", () => {
    expect(iconForItemType("email")).toBe("mail");
    expect(iconForItemType("event")).toBe("calendar");
    expect(iconForItemType("photo")).toBe("device-camera");
    expect(iconForItemType("task")).toBe("checklist");
    expect(iconForItemType("folder")).toBe("folder");
    expect(iconForItemType(undefined)).toBe("file");
  });
});

describe("indexToTree", () => {
  test("service rows are collapsible parents with counts; items carry open command only with a url", () => {
    const tree = indexToTree(
      groupByService([
        { id: "a", name: "Has URL", service: "slack", itemType: "email", url: "https://x" },
        { id: "b", name: "No URL", service: "slack" },
      ]),
    );
    expect(tree).toHaveLength(1);
    const parent = tree[0];
    expect(parent?.label).toBe("slack");
    expect(parent?.description).toBe("2");
    expect(parent?.children).toHaveLength(2);

    const withUrl = parent?.children?.find((c) => c.label === "Has URL");
    expect(withUrl?.contextValue).toBe("nimbusIndexItem");
    expect(withUrl?.description).toBe("email");
    expect(withUrl?.command?.command).toBe("nimbus.openIndexItem");
    expect(withUrl?.iconId).toBe("mail");
    expect(withUrl?.payload).toMatchObject({ id: "a", service: "slack", url: "https://x" });

    const noUrl = parent?.children?.find((c) => c.label === "No URL");
    expect(noUrl?.command).toBeUndefined();
    expect(noUrl?.contextValue).toBe("nimbusIndexItem");
  });
});

describe("buildAskPrompt", () => {
  test("includes name/service/type and url when present", () => {
    const prompt = buildAskPrompt({
      id: "i",
      name: "Q3 Deck",
      service: "gdrive",
      itemType: "file",
      url: "https://x",
    });
    expect(prompt).toContain("- Name: Q3 Deck");
    expect(prompt).toContain("- Service: gdrive");
    expect(prompt).toContain("- Type: file");
    expect(prompt).toContain("- URL: https://x");
  });

  test("omits the URL line and shows unknown type/service when absent", () => {
    const prompt = buildAskPrompt({ id: "i", name: "x", service: "" });
    expect(prompt).not.toContain("- URL:");
    expect(prompt).toContain("- Type: unknown");
    expect(prompt).toContain("- Service: unknown");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bunx vitest run test/unit/index.test.ts`
Expected: FAIL — `src/sidebar/index.ts` does not exist.

- [ ] **Step 3: Implement `src/sidebar/index.ts`**

```ts
import type { SidebarItem } from "./tree-view.js";

// The closed itemType enum mirrored from NimbusItem (we do not import the SDK).
export type IndexItemType = "file" | "folder" | "email" | "event" | "photo" | "task";

// View-model projected from a NimbusItem row. Field names mirror NimbusItem so
// the defensive parse reads the real keys; we own this type.
export interface IndexItem {
  id: string;
  name: string;
  service: string;
  itemType?: IndexItemType;
  url?: string;
  updatedMs?: number;
}

export interface ServiceGroup {
  service: string;
  items: IndexItem[];
}

const ITEM_TYPES: ReadonlySet<string> = new Set<string>([
  "file",
  "folder",
  "email",
  "event",
  "photo",
  "task",
]);

const ITEM_TYPE_ICONS: Record<IndexItemType, string> = {
  file: "file",
  folder: "folder",
  email: "mail",
  event: "calendar",
  photo: "device-camera",
  task: "checklist",
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

// Coerce one queryItems row (or any unknown) into an IndexItem, or undefined
// when it lacks a usable id. Reads NimbusItem field names: name/service/
// itemType/url, plus updatedMs from modifiedAt ?? createdAt ?? updatedMs (the
// last lets a re-parsed command argument keep its sort key).
export function parseIndexRow(raw: unknown): IndexItem | undefined {
  const rec = asRecord(raw);
  if (rec === undefined) return undefined;
  const id = asNonEmptyString(rec["id"]);
  if (id === undefined) return undefined;

  const item: IndexItem = {
    id,
    name: asNonEmptyString(rec["name"]) ?? id,
    service: asNonEmptyString(rec["service"]) ?? "",
  };
  const itemType = rec["itemType"];
  if (typeof itemType === "string" && ITEM_TYPES.has(itemType)) {
    item.itemType = itemType as IndexItemType;
  }
  const url = asNonEmptyString(rec["url"]);
  if (url !== undefined) item.url = url;
  const updatedMs =
    asFiniteNumber(rec["modifiedAt"]) ??
    asFiniteNumber(rec["createdAt"]) ??
    asFiniteNumber(rec["updatedMs"]);
  if (updatedMs !== undefined) item.updatedMs = updatedMs;
  return item;
}

// Group items by service. Services sorted alphabetically; items newest-first by
// updatedMs (Array.sort is stable, so equal/absent timestamps keep input order).
export function groupByService(items: IndexItem[]): ServiceGroup[] {
  const byService = new Map<string, IndexItem[]>();
  for (const item of items) {
    const key = item.service.length > 0 ? item.service : "(unknown)";
    const bucket = byService.get(key);
    if (bucket === undefined) byService.set(key, [item]);
    else bucket.push(item);
  }
  const groups: ServiceGroup[] = [];
  for (const [service, bucket] of byService) {
    const sorted = [...bucket].sort((a, b) => (b.updatedMs ?? 0) - (a.updatedMs ?? 0));
    groups.push({ service, items: sorted });
  }
  groups.sort((a, b) => a.service.localeCompare(b.service));
  return groups;
}

export function iconForItemType(itemType: IndexItem["itemType"]): string {
  return itemType === undefined ? "file" : ITEM_TYPE_ICONS[itemType];
}

function itemToRow(item: IndexItem): SidebarItem {
  return {
    label: item.name,
    iconId: iconForItemType(item.itemType),
    contextValue: "nimbusIndexItem",
    // Carried so the view/item/context "Ask" command (which receives this node,
    // not command.arguments) can recover the IndexItem.
    payload: item,
    ...(item.itemType !== undefined ? { description: item.itemType } : {}),
    ...(item.url !== undefined
      ? {
          tooltip: item.url,
          command: { command: "nimbus.openIndexItem", title: "Open", arguments: [item] },
        }
      : {}),
  };
}

// Two-level tree: a collapsible parent per service (label + item count), each
// carrying its item rows as `children`.
export function indexToTree(groups: ServiceGroup[]): SidebarItem[] {
  return groups.map((group) => ({
    label: group.service,
    description: `${group.items.length}`,
    iconId: "folder",
    children: group.items.map(itemToRow),
  }));
}

// A structured, copy-pasteable prompt seeded into the chat panel.
export function buildAskPrompt(item: IndexItem): string {
  const lines = [
    "Tell me about this indexed item:",
    `- Name: ${item.name}`,
    `- Service: ${item.service.length > 0 ? item.service : "unknown"}`,
    `- Type: ${item.itemType ?? "unknown"}`,
  ];
  if (item.url !== undefined) lines.push(`- URL: ${item.url}`);
  return lines.join("\n");
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bunx vitest run test/unit/index.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify the bars**

Run: `bun run typecheck && bun run lint`
Expected: both exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/sidebar/index.ts test/unit/index.test.ts
git commit -m "feat(sidebar): pure index module (parse/group/tree/prompt)"
```

---

## Task 3: `index-view.ts` — real view behind an injected `loadIndex`

**Files:**
- Rewrite: `src/sidebar/index-view.ts`
- Test: `test/unit/sidebar-views.test.ts`

**Interfaces:**
- Consumes: `groupByService`, `indexToTree`, `IndexItem` from `./index.js`; `createDataView`, `errorRow`, `SidebarConnection`, `SidebarView` from `./tree-view.js`.
- Produces: `createIndexView(deps: { connection: SidebarConnection; loadIndex: () => Promise<IndexItem[]> }): SidebarView`. **Signature change** — the old `createIndexView({ connection })` placeholder is gone; every caller must pass `loadIndex`.

- [ ] **Step 1: Update the existing scaffold test and add behavior tests**

In `test/unit/sidebar-views.test.ts`, the `scaffold view factories` describe currently calls `createIndexView({ connection })`. Remove the index case from it so it only covers Agents:

```ts
describe("scaffold view factories", () => {
  test("the agents placeholder view exposes its connected empty label", async () => {
    const connected: ConnectionState = { kind: "connected", socketPath: "/s" };
    const view = createAgentsView({ connection: makeConnection(connected).connection });
    expect((await view.getChildren())[0]?.label).toMatch(/agents/i);
  });
});
```

Then add a dedicated describe for the index view (the `createIndexView` import already exists at the top of the file):

```ts
describe("createIndexView", () => {
  const connected: ConnectionState = { kind: "connected", socketPath: "/s" };

  test("empty index shows the empty-state row", async () => {
    const c = makeConnection(connected);
    const view = createIndexView({ connection: c.connection, loadIndex: async () => [] });
    expect((await view.getChildren())[0]?.label).toMatch(/no indexed items/i);
  });

  test("loaded items render as collapsible service groups", async () => {
    const c = makeConnection(connected);
    const view = createIndexView({
      connection: c.connection,
      loadIndex: async () => [{ id: "a", name: "Doc", service: "gdrive", url: "https://x" }],
    });
    const [group] = await view.getChildren();
    if (group === undefined) throw new Error("expected a service group");
    expect(group.label).toBe("gdrive");
    expect(view.getTreeItem(group).collapsibleState).toBe(1);
    expect((await view.getChildren(group))[0]?.label).toBe("Doc");
  });

  test("a failing loadIndex renders a single error row", async () => {
    const c = makeConnection(connected);
    const view = createIndexView({
      connection: c.connection,
      loadIndex: async () => {
        throw new Error("index offline");
      },
    });
    const rows = (await view.getChildren()) as Array<{ label: string; tooltip?: string }>;
    expect(rows[0]?.label).toMatch(/failed to load index/i);
    expect(rows[0]?.tooltip).toBe("index offline");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bunx vitest run test/unit/sidebar-views.test.ts`
Expected: FAIL — `createIndexView` is still the placeholder requiring only `connection`; the new `loadIndex` calls / behaviors don't match.

- [ ] **Step 3: Rewrite `src/sidebar/index-view.ts`**

```ts
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bunx vitest run test/unit/sidebar-views.test.ts`
Expected: PASS.

Note: `bun run typecheck` will still FAIL here because `src/extension.ts` calls the old `createIndexView({ connection })` signature. That call site is fixed in Task 4 — do not commit until typecheck is green, so combine this with Task 4, OR commit only the test+view here and accept a known-red typecheck until Task 4. **Choose: commit now (view + tests are self-consistent); Task 4 immediately follows and restores typecheck.**

- [ ] **Step 5: Commit**

```bash
git add src/sidebar/index-view.ts test/unit/sidebar-views.test.ts
git commit -m "feat(sidebar): index view behind injected loadIndex"
```

---

## Task 4: Wire `loadIndex`, register the view, add `refreshIndex`

**Files:**
- Modify: `src/extension.ts` (imports ~20-22; `SESSIONS_SQL` block ~36-38; `loadSessions` block ~308-330; `sidebarViews` array ~331-336; refresh commands ~456)
- Test: `test/unit/extension.test.ts`

**Interfaces:**
- Consumes: `parseIndexRow`, `IndexItem` from `./sidebar/index.js`; `createIndexView` (new signature) from `./sidebar/index-view.js`; `connection.client()`, `NimbusClient.queryItems`.
- Produces: a registered `nimbus.indexView` tree provider backed by live `queryItems`, and a `nimbus.refreshIndex` command.

- [ ] **Step 1: Write the failing tests**

Add to `test/unit/extension.test.ts`, in the same `describe` that holds the sessions-provider tests (after the `nimbus.refreshSessions` test ~line 483):

```ts
  test("the registered index provider groups items via queryItems", async () => {
    const queryItems = vi.fn(async () => ({
      items: [
        { id: "a", name: "Doc", service: "gdrive", itemType: "file", url: "https://x" },
        { id: "b", name: "Note", service: "gdrive", itemType: "file" },
      ],
      meta: { limit: 100, total: 2 },
    }));
    const f = makeFixture({
      openClient: makeFakeClient({ queryItems } as unknown as Partial<ClientLike>),
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    const provider = f.treeProviders.get("nimbus.indexView");
    if (provider === undefined) throw new Error("index provider not registered");
    const groups = await provider.getChildren(undefined);
    expect(queryItems).toHaveBeenCalledTimes(1);
    expect(groups[0]).toMatchObject({ label: "gdrive", description: "2" });
  });

  test("the index provider shows an error row when queryItems fails", async () => {
    const queryItems = vi.fn(async () => {
      throw new Error("index offline");
    });
    const f = makeFixture({
      openClient: makeFakeClient({ queryItems } as unknown as Partial<ClientLike>),
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    const provider = f.treeProviders.get("nimbus.indexView");
    if (provider === undefined) throw new Error("index provider not registered");
    const rows = (await provider.getChildren(undefined)) as Array<{ label: string }>;
    expect(rows[0]?.label).toMatch(/failed to load index/i);
  });

  test("nimbus.refreshIndex refreshes the index view without throwing", async () => {
    const f = makeFixture({});
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    expect(() => cmd(f, "nimbus.refreshIndex")()).not.toThrow();
  });
```

Also add `"nimbus.refreshIndex"` to the `expected` command-id array in the "registers ... commands" test (~line 296, after `"nimbus.openSession"`).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bunx vitest run test/unit/extension.test.ts -t "index"`
Expected: FAIL — `nimbus.indexView` provider returns the placeholder "No indexed items yet" / `nimbus.refreshIndex` not registered.

- [ ] **Step 3: Add the import and `INDEX_LIMIT`**

In `src/extension.ts`, add to the sidebar imports (near line 20-22). Import only what Task 4 uses — `buildAskPrompt` is added to this same line in Task 5, when it's first used, to avoid an unused-import lint failure here:

```ts
import { type IndexItem, parseIndexRow } from "./sidebar/index.js";
```

After the `SESSIONS_SQL` constant (line 38), add:

```ts
// Newest-N indexed items pulled for the Index view. The Gateway returns them
// already ordered; we cap to keep the tree responsive (cf. the search handler).
const INDEX_LIMIT = 100;
```

- [ ] **Step 4: Add the `loadIndex` adapter and register the view**

After the `loadSessions` definition / its trailing comment (around line 325-330), add:

```ts
  // Indexed items come from the Gateway via the public queryItems IPC. The
  // schema coupling (field names) is isolated here so the view stays pure; swap
  // for a typed client method once one exists.
  const loadIndex = async (): Promise<IndexItem[]> => {
    const client = connection.client() as NimbusClient | undefined;
    if (client === undefined) return [];
    try {
      const { items } = await client.queryItems({ limit: INDEX_LIMIT });
      const result: IndexItem[] = [];
      for (const row of items) {
        const parsed = parseIndexRow(row);
        if (parsed !== undefined) result.push(parsed);
      }
      return result;
    } catch (e) {
      log.warn(`loadIndex queryItems failed: ${e instanceof Error ? e.message : String(e)}`);
      throw e;
    }
  };
  const indexView = createIndexView({ connection, loadIndex });
```

Then in the `sidebarViews` array (lines 331-336), replace the index entry:

```ts
    ["nimbus.indexView", indexView],
```

(i.e. change `["nimbus.indexView", createIndexView({ connection })]` to use the hoisted `indexView`.)

- [ ] **Step 5: Register `nimbus.refreshIndex`**

Next to the `nimbus.refreshSessions` registration (~line 456):

```ts
  register("nimbus.refreshIndex", () => {
    indexView.refresh();
  });
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bunx vitest run test/unit/extension.test.ts && bun run typecheck`
Expected: PASS and typecheck exits 0 (the Task 3 signature change is now satisfied).

- [ ] **Step 7: Verify the remaining bars**

Run: `bun run lint && bun run test`
Expected: all green (full suite).

- [ ] **Step 8: Commit**

```bash
git add src/extension.ts test/unit/extension.test.ts
git commit -m "feat(sidebar): wire live Index view via queryItems + refreshIndex"
```

---

## Task 5: `openIndexItem` + `askAboutIndexItem` commands

**Files:**
- Modify: `src/vscode-shim.ts` (`WindowApi` ~line 75)
- Modify: `test/unit/vscode-stub.ts`, `test/unit/hitl-surfaces.test.ts` (window literals)
- Modify: `src/extension.ts` (`ActivateDeps` ~40-49; `openSource` default ~347; commands ~460; `createSourceOpener` helper near `createReadonlyJsonOpener` ~560)
- Modify: `test/unit/extension.test.ts` (fixture window ~149; new tests)

**Interfaces:**
- Consumes: `buildAskPrompt`, `parseIndexRow`, `IndexItem` from `./sidebar/index.js`; `ensureChatController()`; `deps.window.showWarningMessage`.
- Produces: `ActivateDeps.openSource?: (item: IndexItem) => Promise<void>` (defaulted by `createSourceOpener()`); commands `nimbus.openIndexItem` (opens `item.url`, warns on failure, no-ops without a url) and `nimbus.askAboutIndexItem` (seeds the chat with `buildAskPrompt`).

- [ ] **Step 1: Add `showWarningMessage` to the shim and all window literals**

In `src/vscode-shim.ts`, add to `WindowApi` right after `showErrorMessage` (line 75):

```ts
  showWarningMessage(msg: string, ...items: string[]): Thenable<string | undefined>;
```

In `test/unit/vscode-stub.ts`, after the `showErrorMessage` line (line 8):

```ts
  showWarningMessage: async () => undefined,
```

In `test/unit/hitl-surfaces.test.ts`, after its `showErrorMessage: vi.fn(),` (line 24):

```ts
    showWarningMessage: vi.fn(),
```

In `test/unit/extension.test.ts`, the fixture's `window` object: add a captured warning sink next to `errorMessages`. Find the `showErrorMessage: vi.fn(...)` (line ~149) and add immediately after it:

```ts
    showWarningMessage: vi.fn(async (m: string) => {
      warnMessages.push(m);
      return undefined;
    }),
```

Three more edits to thread `warnMessages` through the fixture:
1. Add it to the `Captured` interface (line ~51, beside `errorMessages: string[];`): `warnMessages: string[];`
2. Declare the array in `makeFixture` (beside `const errorMessages: string[] = [];` at line ~95): `const warnMessages: string[] = [];`
3. Expose it on the returned fixture object (beside `errorMessages,` in the `return { ... }` block ~line 229): `warnMessages,`

- [ ] **Step 2: Write the failing command tests**

Add to `test/unit/extension.test.ts` (in the sidebar describe). These call the command handlers directly with an `IndexItem`-shaped argument:

```ts
  test("nimbus.openIndexItem opens a url via the injected opener", async () => {
    const opened: string[] = [];
    const f = makeFixture({});
    f.deps.openSource = async (item) => {
      if (item.url !== undefined) opened.push(item.url);
    };
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await cmd(f, "nimbus.openIndexItem")({ id: "a", name: "Doc", service: "s", url: "https://x" });
    expect(opened).toEqual(["https://x"]);
  });

  test("nimbus.openIndexItem is a no-op for an item without a url", async () => {
    const opener = vi.fn(async () => undefined);
    const f = makeFixture({});
    f.deps.openSource = opener;
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await cmd(f, "nimbus.openIndexItem")({ id: "a", name: "Doc", service: "s" });
    expect(opener).not.toHaveBeenCalled();
  });

  test("nimbus.openIndexItem warns (not errors) when the open throws", async () => {
    const f = makeFixture({});
    f.deps.openSource = async () => {
      throw new Error("file is gone");
    };
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await cmd(f, "nimbus.openIndexItem")({ id: "a", name: "Doc", service: "s", url: "file:///x" });
    expect(f.warnMessages.some((m) => m.includes("file is gone"))).toBe(true);
  });

  test("nimbus.askAboutIndexItem seeds the chat from the node payload", async () => {
    const askStream = doneAskStream();
    const f = makeFixture({
      openClient: makeFakeClient({ askStream } as unknown as Partial<ClientLike>),
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    // The argument shape VS Code passes to a context-menu command: the tree
    // NODE (a SidebarItem), carrying the IndexItem on `payload`. A bare
    // IndexItem here would (correctly) fail to extract — that's the bug guard.
    await cmd(f, "nimbus.askAboutIndexItem")({
      label: "Q3 Deck",
      contextValue: "nimbusIndexItem",
      payload: { id: "a", name: "Q3 Deck", service: "gdrive", itemType: "file" },
    });
    const sent = (askStream.mock.calls[0]?.[0] as string | undefined) ?? "";
    expect(sent).toContain("Q3 Deck");
    expect(sent).toContain("- Service: gdrive");
  });

  test("nimbus.askAboutIndexItem is a no-op for a node without a payload", async () => {
    const askStream = doneAskStream();
    const f = makeFixture({
      openClient: makeFakeClient({ askStream } as unknown as Partial<ClientLike>),
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await cmd(f, "nimbus.askAboutIndexItem")({ label: "x", contextValue: "nimbusIndexItem" });
    expect(askStream).not.toHaveBeenCalled();
  });
```

Add `"nimbus.openIndexItem"` and `"nimbus.askAboutIndexItem"` to the `expected` command-id array in the "registers ... commands" test.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `bunx vitest run test/unit/extension.test.ts -t "IndexItem"`
Expected: FAIL — commands not registered; `f.deps.openSource` / `f.warnMessages` undefined.

- [ ] **Step 4: Add `openSource` to `ActivateDeps` and the default factory**

In `src/extension.ts`, extend the Task 4 index import to add `buildAskPrompt` (now used by the ask command):

```ts
import { buildAskPrompt, type IndexItem, parseIndexRow } from "./sidebar/index.js";
```

Add to `ActivateDeps` (after `openReadonlyJson?` line 48):

```ts
  openSource?: (item: IndexItem) => Promise<void>;
```

Near the `openReadonlyJson` default (line 347), add:

```ts
  const openSource = deps.openSource ?? createSourceOpener();
```

At the bottom, beside `createReadonlyJsonOpener`, add the real-`vscode` opener:

```ts
function createSourceOpener(): (item: IndexItem) => Promise<void> {
  return async (item) => {
    const url = item.url;
    if (url === undefined || url.length === 0) return;
    // A Windows drive path (C:\...) is NOT a URI scheme — `C:` would otherwise
    // parse as scheme "c". Treat it, and any bare path, as a file Uri; only a
    // real >=2-char scheme (http/https/file/mailto/...) goes through Uri.parse.
    const isWindowsDrivePath = /^[a-zA-Z]:[\\/]/.test(url);
    const uri =
      !isWindowsDrivePath && /^[a-z][a-z0-9+.-]+:/i.test(url)
        ? vscode.Uri.parse(url)
        : vscode.Uri.file(url);
    if (uri.scheme === "file") {
      await vscode.commands.executeCommand("vscode.open", uri);
    } else {
      // openExternal resolves `false` (it does not throw) when the OS handler
      // declines; surface that through the command's catch -> warning path.
      const ok = await vscode.env.openExternal(uri);
      if (!ok) throw new Error("the system declined to open this URL");
    }
  };
}
```

- [ ] **Step 5: Register the two commands**

Beside the other index command (after `nimbus.refreshIndex`):

```ts
  register("nimbus.openIndexItem", async (...args) => {
    const item = parseIndexRow(args[0]);
    if (item === undefined || item.url === undefined) return;
    try {
      await openSource(item);
    } catch (e) {
      void deps.window.showWarningMessage(
        `Couldn't open ${item.name}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  });

  register("nimbus.askAboutIndexItem", async (...args) => {
    // A view/item/context command receives the tree NODE element (a SidebarItem),
    // NOT the row's command.arguments. The IndexItem rides along on node.payload
    // (see itemToRow). openIndexItem differs: it's the row's primary command, so
    // it gets command.arguments[0] (the IndexItem) directly.
    const node = args[0];
    const payload =
      typeof node === "object" && node !== null
        ? (node as { payload?: unknown }).payload
        : undefined;
    const item = parseIndexRow(payload);
    if (item === undefined) return;
    const ctl = ensureChatController();
    if (ctl === undefined) return;
    await ctl.start(buildAskPrompt(item));
  });
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bunx vitest run test/unit/extension.test.ts && bun run typecheck && bun run lint`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add src/vscode-shim.ts src/extension.ts test/unit/extension.test.ts test/unit/vscode-stub.ts test/unit/hitl-surfaces.test.ts
git commit -m "feat(sidebar): open-source + ask-about commands for index items"
```

---

## Task 6: `package.json` contributions (commands + menus)

**Files:**
- Modify: `package.json` (`contributes.commands` ~94-114; `contributes.menus` ~145-180)

**Interfaces:**
- Consumes: the three command ids registered in Tasks 4-5.
- Produces: a refresh button on the Index view title, an "Ask Nimbus about this" context item on index rows, and palette-hidden item commands.

- [ ] **Step 1: Declare the three commands**

In `contributes.commands`, after the `nimbus.openSession` entry, add:

```json
      {
        "command": "nimbus.refreshIndex",
        "title": "Refresh Index",
        "category": "Nimbus",
        "icon": "$(refresh)"
      },
      {
        "command": "nimbus.openIndexItem",
        "title": "Open Indexed Item",
        "category": "Nimbus"
      },
      {
        "command": "nimbus.askAboutIndexItem",
        "title": "Ask Nimbus about this",
        "category": "Nimbus"
      }
```

(Add a comma after the previous `}` so the array stays valid.)

- [ ] **Step 2: Add the menu entries**

In `contributes.menus.commandPalette`, add (hide the item-scoped commands from the palette, matching the `nimbus.openSession` pattern):

```json
        {
          "command": "nimbus.openIndexItem",
          "when": "false"
        },
        {
          "command": "nimbus.askAboutIndexItem",
          "when": "false"
        }
```

In `contributes.menus.view/title`, after the `nimbus.refreshSessions` entry, add:

```json
        {
          "command": "nimbus.refreshIndex",
          "when": "view == nimbus.indexView",
          "group": "navigation"
        }
```

Add a `view/item/context` block inside `contributes.menus` (sibling of `view/title`); if it already exists, add the entry to it:

```json
      "view/item/context": [
        {
          "command": "nimbus.askAboutIndexItem",
          "when": "view == nimbus.indexView && viewItem == nimbusIndexItem",
          "group": "inline"
        }
      ]
```

- [ ] **Step 3: Validate the JSON and the bars**

Run: `node -e "JSON.parse(require('fs').readFileSync('package.json','utf8')); console.log('package.json OK')"`
Expected: `package.json OK`.

Run: `bun run typecheck && bun run lint && bun run test && bun run build && bun run check-bundle`
Expected: all exit 0.

- [ ] **Step 4: Manual verification (Extension Development Host)**

Launch the extension (F5) against a running Gateway and confirm:
- The Index view lists service groups; expanding one shows its items.
- Clicking an item with a URL opens it; pressing `Enter` on a selected item does the same (default `registerTreeDataProvider` activation — no `TreeViewOptions` are set that could conflict).
- Right-clicking an item shows "Ask Nimbus about this", which opens the chat seeded with the item's details.
- The title-bar refresh icon re-queries.

- [ ] **Step 5: Commit**

```bash
git add package.json
git commit -m "feat(sidebar): contribute Index view commands and menus"
```

---

## Self-review notes (spec coverage)

- **Grouped-by-service two-level tree** → Tasks 1 (nesting), 2 (`groupByService`/`indexToTree`), 3 (wrapper).
- **Eager single `queryItems` fetch, schema isolated in composition root** → Task 4 (`loadIndex`, `INDEX_LIMIT`).
- **Open source by url scheme, try/catch → warning** → Task 5 (`createSourceOpener`, `nimbus.openIndexItem`, `showWarningMessage`). Windows drive paths are excluded from scheme parsing; `openExternal`'s `false` return is converted to a throw so it reaches the warning path.
- **Command argument plumbing (review fix)** → primary-click `openIndexItem` reads `command.arguments[0]` (the `IndexItem`); context-menu `askAboutIndexItem` reads the tree node's `payload` (a `SidebarItem` is what VS Code hands a view/item/context command). `itemToRow` sets both.
- **Item with no url → no command, still Ask-able** → Task 2 (`itemToRow`), Task 5 (open no-op).
- **`itemType` → codicon over the closed enum** → Task 2 (`iconForItemType`).
- **Structured Ask prompt, no excerpt** → Task 2 (`buildAskPrompt`), Task 5 (command).
- **Keyboard activation** → Task 6 manual verification.
- **Field names (name/itemType/createdAt|modifiedAt/url; no SDK import)** → Task 2 (`parseIndexRow`), Global Constraints.
- **States: connection placeholder / empty / error** → inherited from `createDataView` + Task 3 empty/error rows.
- **Deferred (auto-refresh, per-service branding, excerpts, pagination)** → intentionally not in any task; recorded in the spec.
- **100% `src/sidebar` coverage** → every branch in `index.ts`/`index-view.ts`/`tree-view.ts` nesting is exercised by Tasks 1-3 tests.
