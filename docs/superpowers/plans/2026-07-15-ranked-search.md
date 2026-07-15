# Ranked Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the broken `nimbus.search` (which ignores the query and dumps 50 recent items) with a live, type-to-search surface backed by `searchRanked`, fix Search Selection to prefill the query, and open the chosen result via the existing `openSource` seam.

**Architecture:** A pure module (`src/search.ts`) parses/normalizes/formats ranked rows into Quick Pick view-models; `extension.ts` drives a live `vscode.window.createQuickPick()` that re-queries the Gateway per debounced keystroke (latest-wins), opening results through a lightly widened `openSource` seam. A new `createQuickPick` shim seam keeps `vscode` out of the pure code and the tests.

**Tech Stack:** TypeScript (strict), esbuild bundle, Vitest (`vscode` aliased to `test/unit/vscode-stub.ts`), Biome, `@nimbus-dev/client@0.4.0` IPC.

## Global Constraints

Copied verbatim from the spec — every task must honour these:

- TypeScript **strict**; **no `any`** (external data is `unknown`, then parsed).
- **No `console`** in `src/` — log via `logging.ts` (`log.error`, `errMsg`). Biome enforces `noConsole`, `noExplicitAny`, `noNonNullAssertion`.
- `tsconfig` has **`exactOptionalPropertyTypes`** — never assign `undefined` to an optional field; build objects incrementally / conditional-spread.
- The `@nimbus-dev/client` dependency stays a **published** `^0.4.0` (no bump — `searchRanked` is already present).
- The `vscode` API is touched only through `vscode-shim.ts` interfaces or an injected seam — never imported into `src/search.ts` or the tests.
- `bun run check-bundle` must still show **`vscode` as the sole bundle external**.
- Coverage stays at ledger parity (~current levels).
- Import paths use the `.js` extension (NodeNext), even for `.ts` sources.
- **`QuickPickItem.alwaysShow = true` on every result** — VS Code's built-in label filter cannot be disabled, and without `alwaysShow` it silently hides semantic results whose label lacks the query substring.

Verification gate for every task's final step (and the whole feature):
`bun run typecheck && bun run lint && bun run test && bun run build && bun run check-bundle`

---

### Task 1: Pure search module (`src/search.ts`)

Mirrors the sidebar parse modules. No `vscode` imports. Reuses `src/sidebar/parse-helpers.ts`.

**Files:**
- Create: `src/search.ts`
- Test: `test/unit/search.test.ts`

**Interfaces:**
- Consumes: `asFiniteNumber`, `asNonEmptyString`, `asRecord` from `./sidebar/parse-helpers.js`.
- Produces:
  - `normalizeInline(s: string, max?: number): string`
  - `interface RankedResult { name: string; service: string; itemType?: string; score: number; url?: string; snippet?: string }`
  - `parseRankedItem(raw: unknown): RankedResult | undefined`
  - `interface SearchPick { label: string; description: string; detail: string; alwaysShow: true; url?: string; canOpen: boolean; isStatus?: boolean }`
  - `rankedResultToPick(r: RankedResult): SearchPick`
  - `buildPicks(rawRows: unknown[]): SearchPick[]`
  - `statusPick(label: string): SearchPick`

- [ ] **Step 1: Write the failing test**

Create `test/unit/search.test.ts`:

```ts
import { describe, expect, test } from "vitest";

import {
  buildPicks,
  normalizeInline,
  parseRankedItem,
  rankedResultToPick,
  statusPick,
} from "../../src/search.js";

function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "Q3 report.pdf",
    service: "gdrive",
    itemType: "file",
    indexedType: "gdrive_file",
    score: 0.912345,
    url: "https://drive/x",
    canonicalUrl: "https://canonical/x",
    semanticSnippet: "line one\nline two",
    ...over,
  };
}

describe("normalizeInline", () => {
  test("collapses whitespace/newlines and trims", () => {
    expect(normalizeInline("  a\n\tb   c  ")).toBe("a b c");
  });
  test("truncates to max with an ellipsis, trimming trailing space", () => {
    expect(normalizeInline("abcdef ghij", 5)).toBe("abcde…");
    expect(normalizeInline("abc de", 4)).toBe("abc…");
  });
  test("no truncation when short or max omitted", () => {
    expect(normalizeInline("abc", 10)).toBe("abc");
    expect(normalizeInline("a b c")).toBe("a b c");
  });
});

describe("parseRankedItem", () => {
  test("coerces a full row, preferring canonicalUrl and normalizing the snippet", () => {
    const r = parseRankedItem(row());
    expect(r).toEqual({
      name: "Q3 report.pdf",
      service: "gdrive",
      itemType: "file",
      score: 0.912345,
      url: "https://canonical/x",
      snippet: "line one line two",
    });
  });
  test("falls back to url when canonicalUrl is absent", () => {
    expect(parseRankedItem(row({ canonicalUrl: undefined }))?.url).toBe("https://drive/x");
  });
  test("falls back itemType to indexedType", () => {
    expect(parseRankedItem(row({ itemType: undefined }))?.itemType).toBe("gdrive_file");
  });
  test("omits url/itemType/snippet when none are present", () => {
    const r = parseRankedItem({ name: "x", service: "s", score: 1 });
    expect(r).toEqual({ name: "x", service: "s", score: 1 });
    expect("url" in (r as object)).toBe(false);
    expect("itemType" in (r as object)).toBe(false);
    expect("snippet" in (r as object)).toBe(false);
  });
  test("rejects rows without a name, and non-objects", () => {
    expect(parseRankedItem(row({ name: undefined }))).toBeUndefined();
    expect(parseRankedItem(row({ name: "" }))).toBeUndefined();
    expect(parseRankedItem("nope")).toBeUndefined();
    expect(parseRankedItem(null)).toBeUndefined();
  });
  test("defaults a missing/non-numeric score to 0 and missing service to ''", () => {
    const r = parseRankedItem({ name: "x", score: "nope" });
    expect(r).toMatchObject({ score: 0, service: "" });
  });
});

describe("rankedResultToPick", () => {
  test("builds label/description/detail with alwaysShow and a 2-dp score", () => {
    const pick = rankedResultToPick(parseRankedItem(row()) as never);
    expect(pick).toMatchObject({
      label: "Q3 report.pdf",
      description: "gdrive · file · score 0.91",
      detail: "line one line two",
      alwaysShow: true,
      url: "https://canonical/x",
      canOpen: true,
    });
  });
  test("omits the itemType segment when absent", () => {
    const pick = rankedResultToPick({ name: "n", service: "s", score: 0.5 });
    expect(pick.description).toBe("s · score 0.50");
  });
  test("no url → canOpen false and a placeholder detail", () => {
    const pick = rankedResultToPick({ name: "n", service: "s", score: 0.5 });
    expect(pick.canOpen).toBe(false);
    expect(pick.detail).toBe("No source URL available");
    expect("url" in pick).toBe(false);
  });
  test("detail falls back to url when there is no snippet", () => {
    const pick = rankedResultToPick({ name: "n", service: "s", score: 1, url: "u" });
    expect(pick.detail).toBe("u");
  });
});

describe("buildPicks", () => {
  test("maps rows, drops malformed, preserves order", () => {
    const picks = buildPicks([row({ name: "A" }), "garbage", row({ name: "B" })]);
    expect(picks.map((p) => p.label)).toEqual(["A", "B"]);
  });
});

describe("statusPick", () => {
  test("is a non-selectable always-shown row", () => {
    expect(statusPick("No matching index records")).toEqual({
      label: "No matching index records",
      description: "",
      detail: "",
      alwaysShow: true,
      canOpen: false,
      isStatus: true,
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bunx vitest run test/unit/search.test.ts`
Expected: FAIL — cannot resolve `../../src/search.js`.

- [ ] **Step 3: Write the implementation**

Create `src/search.ts`:

```ts
import { asFiniteNumber, asNonEmptyString, asRecord } from "./sidebar/parse-helpers.js";

// Collapse all whitespace (incl. newlines/tabs) to single spaces and trim;
// optionally truncate to `max` chars with a trailing ellipsis. Keeps multi-line
// snippets and large selections on the single-line QuickPick surfaces.
export function normalizeInline(s: string, max?: number): string {
  const collapsed = s.replace(/\s+/g, " ").trim();
  if (max === undefined || collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, max).trimEnd()}…`;
}

export interface RankedResult {
  name: string;
  service: string;
  itemType?: string;
  score: number;
  url?: string;
  snippet?: string;
}

// Coerce one searchRanked row (typed by the client, parsed defensively like the
// Audit/Egress views). Requires a name; drops rows without one. itemType prefers
// the user-facing NimbusItem.itemType and falls back to the index's indexedType.
export function parseRankedItem(raw: unknown): RankedResult | undefined {
  const rec = asRecord(raw);
  if (rec === undefined) return undefined;
  const name = asNonEmptyString(rec["name"]);
  if (name === undefined) return undefined;
  const result: RankedResult = {
    name,
    service: asNonEmptyString(rec["service"]) ?? "",
    score: asFiniteNumber(rec["score"]) ?? 0,
  };
  const itemType = asNonEmptyString(rec["itemType"]) ?? asNonEmptyString(rec["indexedType"]);
  if (itemType !== undefined) result.itemType = itemType;
  const url = asNonEmptyString(rec["canonicalUrl"]) ?? asNonEmptyString(rec["url"]);
  if (url !== undefined) result.url = url;
  const snippet = asNonEmptyString(rec["semanticSnippet"]);
  if (snippet !== undefined) result.snippet = normalizeInline(snippet);
  return result;
}

export interface SearchPick {
  label: string;
  description: string;
  detail: string;
  alwaysShow: true;
  url?: string;
  canOpen: boolean;
  isStatus?: boolean;
}

// Build the QuickPick view-model for one result. alwaysShow keeps the Gateway
// ranking authoritative (VS Code cannot disable its own label filtering).
export function rankedResultToPick(r: RankedResult): SearchPick {
  const parts = [r.service, r.itemType].filter(
    (x): x is string => typeof x === "string" && x.length > 0,
  );
  parts.push(`score ${r.score.toFixed(2)}`);
  const canOpen = r.url !== undefined && r.url.length > 0;
  const pick: SearchPick = {
    label: r.name,
    description: parts.join(" · "),
    detail: r.snippet ?? r.url ?? "No source URL available",
    alwaysShow: true,
    canOpen,
  };
  if (r.url !== undefined) pick.url = r.url;
  return pick;
}

// Map rows to picks, dropping malformed rows, preserving order.
export function buildPicks(rawRows: unknown[]): SearchPick[] {
  const picks: SearchPick[] = [];
  for (const raw of rawRows) {
    const r = parseRankedItem(raw);
    if (r !== undefined) picks.push(rankedResultToPick(r));
  }
  return picks;
}

// A non-selectable status row shown instead of a blank list (e.g. "No results").
export function statusPick(label: string): SearchPick {
  return { label, description: "", detail: "", alwaysShow: true, canOpen: false, isStatus: true };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bunx vitest run test/unit/search.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Lint + typecheck**

Run: `bun run lint && bun run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/search.ts test/unit/search.test.ts
git commit -m "feat(search): ranked-result parsing and quick-pick formatting"
```

---

### Task 2: Live search wiring (`extension.ts` + shim + tests)

Adds the `createQuickPick` shim seam, widens `openSource`, and replaces the two
Search command handlers with a live, debounced `searchRanked` orchestration.

**Files:**
- Modify: `src/vscode-shim.ts` (add `QuickPickLike`, `WindowApi.createQuickPick`)
- Modify: `test/unit/vscode-stub.ts` (minimal `createQuickPick`)
- Modify: `src/extension.ts` (widen `openSource`/`ActivateDeps.openSource`, add `ActivateDeps.searchDebounceMs`, `SEARCH_*` consts, `runSearch`, both command handlers, import from `./search.js`)
- Modify: `test/unit/extension.test.ts` (fixture `createQuickPick` fake + helpers; replace obsolete search tests; add orchestration tests)

**Interfaces:**
- Consumes: `buildPicks`, `normalizeInline`, `statusPick`, `type SearchPick` from `./search.js`; `QuickPickItemLike`, `DisposableLike` from `./vscode-shim.js`.
- Produces:
  - `interface QuickPickLike<T>` and `WindowApi.createQuickPick<T extends QuickPickItemLike>(): QuickPickLike<T>`.
  - `ActivateDeps.openSource?: (item: { url?: string }) => Promise<void>` (widened).
  - `ActivateDeps.searchDebounceMs?: number`.
  - Rewired command ids `nimbus.search` (live) and `nimbus.searchSelection` (prefill).

- [ ] **Step 1: Add the `QuickPickLike` seam to `src/vscode-shim.ts`**

After the `QuickPickItemLike` interface (around line 27), add:

```ts
export interface QuickPickLike<T> {
  value: string;
  placeholder: string | undefined;
  items: readonly T[];
  busy: boolean;
  matchOnDescription: boolean;
  matchOnDetail: boolean;
  readonly selectedItems: readonly T[];
  onDidChangeValue(cb: (value: string) => void): DisposableLike;
  onDidAccept(cb: () => void): DisposableLike;
  onDidHide(cb: () => void): DisposableLike;
  show(): void;
  hide(): void;
  dispose(): void;
}
```

In the `WindowApi` interface, after the `showQuickPick<...>(...)` member, add:

```ts
  createQuickPick<T extends QuickPickItemLike>(): QuickPickLike<T>;
```

- [ ] **Step 2: Add a minimal `createQuickPick` to `test/unit/vscode-stub.ts`**

In the `window` object (after `showQuickPick`), add (no test drives it; it exists
so the aliased `vscode` surface is complete):

```ts
  createQuickPick: () => {
    const sub = () => ({ dispose: () => undefined });
    return {
      value: "",
      placeholder: undefined,
      items: [],
      busy: false,
      matchOnDescription: false,
      matchOnDetail: false,
      selectedItems: [],
      onDidChangeValue: sub,
      onDidAccept: sub,
      onDidHide: sub,
      show: () => undefined,
      hide: () => undefined,
      dispose: () => undefined,
    };
  },
```

- [ ] **Step 3: Typecheck the seam**

Run: `bun run typecheck`
Expected: PASS (real `vscode.window.createQuickPick` structurally satisfies the new member via the existing `vscode.window as unknown as WindowApi` bridge).

- [ ] **Step 4: Widen the `openSource` seam in `src/extension.ts`**

Change the `ActivateDeps` member:

```ts
  openSource?: (item: IndexItem) => Promise<void>;
```

to:

```ts
  openSource?: (item: { url?: string }) => Promise<void>;
```

Change the `createSourceOpener` signature:

```ts
export function createSourceOpener(): (item: IndexItem) => Promise<void> {
```

to:

```ts
export function createSourceOpener(): (item: { url?: string }) => Promise<void> {
```

(The body is unchanged — it already reads only `item.url`. `IndexItem` still
satisfies `{ url?: string }`, so the Index view wiring is untouched.)

- [ ] **Step 5: Add `searchDebounceMs` to `ActivateDeps`**

In `ActivateDeps`, after `saveJson?:`, add:

```ts
  searchDebounceMs?: number;
```

- [ ] **Step 6: Add the import and constants in `src/extension.ts`**

Add to the imports (alphabetical among the sidebar imports is not required; place
after the `createEgressView` import):

```ts
import { buildPicks, normalizeInline, type SearchPick, statusPick } from "./search.js";
```

Near `INDEX_LIMIT` (top-of-file consts), add:

```ts
// Search result cap (a sensible picker size; the Gateway clamps to 1..500) and
// the type-to-search debounce.
const SEARCH_LIMIT = 50;
const SEARCH_DEBOUNCE_MS = 200;
const SELECTION_PREFILL_MAX = 150;
```

- [ ] **Step 7: Add fixture support in `test/unit/extension.test.ts`**

7a. Import `QuickPickLike` — extend the existing `vscode-shim` type import to include it (add `QuickPickLike` to the imported names).

7b. At top level (near the other test helpers), add the fake Quick Pick and async
helpers:

```ts
interface FakeQuickPick {
  value: string;
  placeholder: string | undefined;
  items: readonly unknown[];
  busy: boolean;
  matchOnDescription: boolean;
  matchOnDetail: boolean;
  selectedItems: readonly unknown[];
  onDidChangeValue(cb: (v: string) => void): { dispose(): void };
  onDidAccept(cb: () => void): { dispose(): void };
  onDidHide(cb: () => void): { dispose(): void };
  show(): void;
  hide(): void;
  dispose(): void;
  shown: boolean;
  disposed: boolean;
  setValueAndFire(v: string): void;
  accept(sel: readonly unknown[]): void;
}

function makeFakeQuickPick(): FakeQuickPick {
  const changeCbs: Array<(v: string) => void> = [];
  const acceptCbs: Array<() => void> = [];
  const hideCbs: Array<() => void> = [];
  const qp: FakeQuickPick = {
    value: "",
    placeholder: undefined,
    items: [],
    busy: false,
    matchOnDescription: false,
    matchOnDetail: false,
    selectedItems: [],
    onDidChangeValue: (cb) => {
      changeCbs.push(cb);
      return { dispose: () => undefined };
    },
    onDidAccept: (cb) => {
      acceptCbs.push(cb);
      return { dispose: () => undefined };
    },
    onDidHide: (cb) => {
      hideCbs.push(cb);
      return { dispose: () => undefined };
    },
    show: () => {
      qp.shown = true;
    },
    hide: () => {
      for (const cb of hideCbs) cb();
    },
    dispose: () => {
      qp.disposed = true;
    },
    shown: false,
    disposed: false,
    setValueAndFire: (v) => {
      qp.value = v;
      for (const cb of changeCbs) cb(v);
    },
    accept: (sel) => {
      qp.selectedItems = sel;
      for (const cb of acceptCbs) cb();
    },
  };
  return qp;
}

const flush = async (): Promise<void> => {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
};

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}
```

7c. In `makeFixture`, near the other capture arrays, add:

```ts
  const quickPicks: FakeQuickPick[] = [];
```

7d. In the `window` object, after the `showQuickPick` fake, add the
`createQuickPick` fake:

```ts
    createQuickPick: (<T>() => {
      const qp = makeFakeQuickPick();
      quickPicks.push(qp);
      return qp as unknown as QuickPickLike<T>;
    }) as WindowApi["createQuickPick"],
```

7e. After the `deps` object literal (next to the existing `if (opts.realProofSave …)`
mutation), add:

```ts
  if (opts.openSource !== undefined) deps.openSource = opts.openSource;
  if (opts.searchDebounceMs !== undefined) deps.searchDebounceMs = opts.searchDebounceMs;
```

7f. Extend the `opts` type with:

```ts
  openSource?: (item: { url?: string }) => Promise<void>;
  searchDebounceMs?: number;
```

7g. Add `quickPicks` to the returned object and to the `Captured` interface:
`quickPicks,` in the return, and `quickPicks: FakeQuickPick[];` on `Captured`.

- [ ] **Step 8: Replace the obsolete search tests with the new suite (failing)**

In `test/unit/extension.test.ts`, delete the five obsolete tests (they assert the
old `queryItems`/`showInputBox` flow):
- `"nimbus.search reads NimbusItem fields (name/url), coercing and falling back"`
- `"nimbus.search is a no-op for a blank query"`
- `"nimbus.search reports an error when the query fails"`
- `"nimbus.search errors when not connected to the Gateway"`
- `"nimbus.searchSelection delegates to nimbus.search when text is selected"`

Keep `"nimbus.searchSelection errors when there is no selection"` (the empty-selection
guard is unchanged).

In their place, add:

```ts
  test("typing runs a ranked search and lists results with alwaysShow", async () => {
    const calls: Array<{ name?: string; limit?: number }> = [];
    const f = makeFixture({
      searchDebounceMs: 0,
      openClient: makeFakeClient({
        searchRanked: async (p: { name?: string; limit?: number }) => {
          calls.push(p);
          return [{ name: "Report.pdf", service: "gdrive", itemType: "file", score: 0.91, url: "https://x/r" }];
        },
      } as never),
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    cmd(f, "nimbus.search")();
    const qp = f.quickPicks[0] as FakeQuickPick;
    qp.setValueAndFire("report");
    await flush();
    expect(calls).toEqual([{ name: "report", limit: 50 }]);
    expect(qp.items).toHaveLength(1);
    expect((qp.items[0] as { label: string; alwaysShow?: boolean }).label).toBe("Report.pdf");
    expect((qp.items[0] as { alwaysShow?: boolean }).alwaysShow).toBe(true);
    expect(qp.shown).toBe(true);
  });

  test("an empty value never calls the Gateway", async () => {
    let searchCalls = 0;
    const f = makeFixture({
      searchDebounceMs: 0,
      openClient: makeFakeClient({
        searchRanked: async () => {
          searchCalls += 1;
          return [];
        },
      } as never),
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    cmd(f, "nimbus.search")();
    (f.quickPicks[0] as FakeQuickPick).setValueAndFire("   ");
    await flush();
    expect(searchCalls).toBe(0);
  });

  test("a slow earlier query does not overwrite a newer one (latest wins)", async () => {
    const d1 = deferred<unknown[]>();
    const d2 = deferred<unknown[]>();
    const queue = [d1, d2];
    const f = makeFixture({
      searchDebounceMs: 0,
      openClient: makeFakeClient({
        searchRanked: async () => (queue.shift() as { promise: Promise<unknown[]> }).promise,
      } as never),
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    cmd(f, "nimbus.search")();
    const qp = f.quickPicks[0] as FakeQuickPick;
    qp.setValueAndFire("a");
    await flush();
    qp.setValueAndFire("ab");
    await flush();
    d2.resolve([{ name: "New", service: "s", score: 1, url: "u2" }]);
    await flush();
    d1.resolve([{ name: "Old", service: "s", score: 1, url: "u1" }]);
    await flush();
    expect((qp.items as Array<{ label: string }>).map((i) => i.label)).toEqual(["New"]);
  });

  test("zero results shows a non-selectable status row", async () => {
    const f = makeFixture({
      searchDebounceMs: 0,
      openClient: makeFakeClient({ searchRanked: async () => [] } as never),
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    cmd(f, "nimbus.search")();
    const qp = f.quickPicks[0] as FakeQuickPick;
    qp.setValueAndFire("zzz");
    await flush();
    expect(qp.items).toHaveLength(1);
    expect((qp.items[0] as { isStatus?: boolean }).isStatus).toBe(true);
    qp.accept([qp.items[0]]);
    expect(f.infoMessages.some((m) => /No source to open/.test(m))).toBe(false);
  });

  test("accepting an openable result opens it via openSource", async () => {
    const opened: Array<{ url?: string }> = [];
    const f = makeFixture({
      searchDebounceMs: 0,
      openSource: async (item) => {
        opened.push(item);
      },
      openClient: makeFakeClient({
        searchRanked: async () => [{ name: "R", service: "s", score: 1, url: "https://x" }],
      } as never),
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    cmd(f, "nimbus.search")();
    const qp = f.quickPicks[0] as FakeQuickPick;
    qp.setValueAndFire("r");
    await flush();
    qp.accept([qp.items[0]]);
    expect(opened).toEqual([{ url: "https://x" }]);
    expect(qp.disposed).toBe(true);
  });

  test("accepting a result with no source shows an info toast, not openSource", async () => {
    const opened: Array<{ url?: string }> = [];
    const f = makeFixture({
      searchDebounceMs: 0,
      openSource: async (item) => {
        opened.push(item);
      },
      openClient: makeFakeClient({
        searchRanked: async () => [{ name: "NoUrl", service: "s", score: 1 }],
      } as never),
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    cmd(f, "nimbus.search")();
    const qp = f.quickPicks[0] as FakeQuickPick;
    qp.setValueAndFire("n");
    await flush();
    qp.accept([qp.items[0]]);
    expect(opened).toHaveLength(0);
    expect(f.infoMessages.some((m) => /No source to open/.test(m))).toBe(true);
  });

  test("Search Selection prefills the box with the normalized selection and searches", async () => {
    const calls: Array<{ name?: string }> = [];
    const f = makeFixture({
      searchDebounceMs: 0,
      activeEditor: { empty: false, text: "  multi\nline   selection  " },
      openClient: makeFakeClient({
        searchRanked: async (p: { name?: string }) => {
          calls.push(p);
          return [];
        },
      } as never),
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    cmd(f, "nimbus.searchSelection")();
    const qp = f.quickPicks[0] as FakeQuickPick;
    expect(qp.value).toBe("multi line selection");
    await flush();
    expect(calls[0]?.name).toBe("multi line selection");
  });

  test("results arriving after the pick is hidden do not mutate it", async () => {
    const d = deferred<unknown[]>();
    const f = makeFixture({
      searchDebounceMs: 0,
      openClient: makeFakeClient({ searchRanked: async () => d.promise } as never),
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    cmd(f, "nimbus.search")();
    const qp = f.quickPicks[0] as FakeQuickPick;
    qp.setValueAndFire("r");
    await flush(); // search in-flight
    qp.hide(); // onDidHide → disposed = true, dispose()
    expect(qp.disposed).toBe(true);
    d.resolve([{ name: "Late", service: "s", score: 1, url: "u" }]);
    await flush();
    expect(qp.items).toHaveLength(0); // guard blocked the post-dispose write
  });

  test("search warns and opens no QuickPick when disconnected", async () => {
    const f = makeFixture({ openClient: disconnectedClient() });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    cmd(f, "nimbus.search")();
    expect(f.errorMessages.some((m) => /not connected/i.test(m))).toBe(true);
    expect(f.quickPicks).toHaveLength(0);
  });

  test("a searchRanked rejection shows an error toast and clears busy", async () => {
    const f = makeFixture({
      searchDebounceMs: 0,
      openClient: makeFakeClient({
        searchRanked: async () => {
          throw new Error("idx down");
        },
      } as never),
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    cmd(f, "nimbus.search")();
    const qp = f.quickPicks[0] as FakeQuickPick;
    qp.setValueAndFire("x");
    await flush();
    expect(f.errorMessages.some((m) => /search failed: idx down/i.test(m))).toBe(true);
    expect(qp.busy).toBe(false);
  });
```

- [ ] **Step 9: Run the tests to verify they fail**

Run: `bunx vitest run test/unit/extension.test.ts`
Expected: FAIL — the handlers still use the old `queryItems`/`showInputBox` flow;
`searchRanked` is never called and no QuickPick is created.

- [ ] **Step 10: Implement `runSearch` and rewrite the command handlers**

In `src/extension.ts`, replace the entire `register("nimbus.search", …)` and
`register("nimbus.searchSelection", …)` blocks with:

```ts
  const runSearch = (initialValue?: string): void => {
    const client = nimbus();
    if (client === undefined) {
      void deps.window.showErrorMessage("Nimbus: not connected to Gateway.");
      return;
    }
    const qp = deps.window.createQuickPick<SearchPick>();
    qp.placeholder = "Search the local Nimbus index";
    // alwaysShow on every result makes these largely moot (VS Code can't filter
    // out our rows), but set both for parity with the intended UX.
    qp.matchOnDescription = true;
    qp.matchOnDetail = true;
    const debounceMs = deps.searchDebounceMs ?? SEARCH_DEBOUNCE_MS;
    let seq = 0;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const runQuery = async (value: string): Promise<void> => {
      const q = value.trim();
      if (q.length === 0) {
        qp.items = [];
        qp.busy = false;
        return;
      }
      const mine = ++seq;
      qp.busy = true;
      try {
        const rows = await client.searchRanked({ name: q, limit: SEARCH_LIMIT });
        if (disposed || mine !== seq) return; // pick closed, or a newer keystroke won
        const picks = buildPicks(rows);
        qp.items = picks.length > 0 ? picks : [statusPick("No matching index records")];
      } catch (e) {
        if (disposed || mine !== seq) return;
        log.error(`nimbus.search failed: ${errMsg(e)}`);
        qp.items = [];
        void deps.window.showErrorMessage(`Nimbus search failed: ${errMsg(e)}`);
      } finally {
        if (!disposed && mine === seq) qp.busy = false;
      }
    };

    qp.onDidChangeValue((value) => {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => void runQuery(value), debounceMs);
    });

    qp.onDidAccept(() => {
      const pick = qp.selectedItems[0];
      if (pick === undefined || pick.isStatus === true) return;
      if (pick.canOpen && pick.url !== undefined) {
        void openSource({ url: pick.url });
      } else {
        void deps.window.showInformationMessage(`No source to open for "${pick.label}".`);
      }
      qp.hide();
    });

    qp.onDidHide(() => {
      disposed = true; // guard in-flight runQuery from writing to a disposed pick
      if (timer !== undefined) clearTimeout(timer);
      qp.dispose();
    });

    if (initialValue !== undefined) {
      const seed = normalizeInline(initialValue, SELECTION_PREFILL_MAX);
      qp.value = seed;
      void runQuery(seed);
    }
    qp.show();
  };

  register("nimbus.search", () => {
    runSearch();
  });

  register("nimbus.searchSelection", () => {
    const editor = deps.window.activeTextEditor;
    if (editor === undefined || editor.selection.isEmpty) {
      void deps.window.showErrorMessage("Nimbus: select text first.");
      return;
    }
    runSearch(editor.document.getText(editor.selection));
  });
```

Note: `openSource` is the already-resolved seam (`deps.openSource ?? createSourceOpener()`),
in scope here exactly as the old handler used it.

- [ ] **Step 11: Run the tests to verify they pass**

Run: `bunx vitest run test/unit/extension.test.ts test/unit/search.test.ts`
Expected: PASS — all new orchestration + pure-module tests green, no regressions.

- [ ] **Step 12: Lint + typecheck**

Run: `bun run lint && bun run typecheck`
Expected: PASS. (If Biome reformats long lines, re-run `bunx biome check --write src/ test/` and re-lint.)

- [ ] **Step 13: Commit**

```bash
git add src/vscode-shim.ts test/unit/vscode-stub.ts src/extension.ts test/unit/extension.test.ts
git commit -m "feat(search): live ranked search with result-open and selection prefill"
```

---

### Task 3: Docs + full verification gate

**Files:**
- Modify: `CHANGELOG.md` (Unreleased)
- Modify: `README.md` (Search bullet)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing (docs only).

- [ ] **Step 1: Update CHANGELOG.md**

Under the `## Unreleased` heading, add a bullet after the sidebar/egress entries:

```markdown
- **Search** now queries the local index for real via the Gateway's ranked
  search (semantic + keyword), updating results live as you type; picking a
  result opens it, and **Search Selection** seeds the query with the selected
  text.
```

- [ ] **Step 2: Update README.md**

Replace the existing Search bullet:

```markdown
- **Search** — query your local Nimbus index across every connected service from the command palette.
```

with:

```markdown
- **Search** — live ranked (semantic + keyword) search over your local Nimbus index; results update as you type and open on select. **Search Selection** seeds it from the editor.
```

- [ ] **Step 3: Full verification gate**

Run: `bun run typecheck && bun run lint && bun run test && bun run build && bun run check-bundle`
Expected: PASS at every stage; `check-bundle` still reports `vscode` as the only external.

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md README.md
git commit -m "docs: ranked search is live (client 0.4.0 searchRanked)"
```

---

## Self-Review

**Spec coverage:**
- Live `createQuickPick` re-query per debounced keystroke → Task 2 Step 10. ✅
- `alwaysShow: true` on every result (+ status row) → Task 1 `rankedResultToPick`/`statusPick`. ✅
- `parseRankedItem` (canonicalUrl pref, itemType→indexedType fallback, defensive) → Task 1. ✅
- `normalizeInline` for snippet + selection prefill → Task 1 + Task 2 Step 10 (`SELECTION_PREFILL_MAX`). ✅
- Result-open via widened `openSource` `{ url }` → Task 2 Steps 4, 10. ✅
- No-URL result: marked + info toast, not silent → Task 1 (`canOpen`/detail) + Task 2 accept handler + test. ✅
- Empty results status row (review #8) → Task 1 `statusPick` + Task 2 `runQuery` + test. ✅
- itemType in description (review #7) → Task 1 `rankedResultToPick` + test. ✅
- Score labeled + 2-dp (review #6) → Task 1 + test; exact wording for an unbounded range is the one deferred item (inspect a live response during rollout). ✅
- Latest-wins stale guard → Task 2 `seq` + test. ✅
- Disconnected / RPC-error paths → Task 2 handlers + tests. ✅
- Deferred (#9 duplicate badges, #10 config limit) → not implemented, by design (spec non-goals). ✅
- Docs (CHANGELOG, README) → Task 3. ✅

**Placeholder scan:** No TBD/TODO; every code step shows complete code. The only
deferred detail is the score-label *wording* for an unbounded-range score, called
out explicitly (needs a live response to confirm) — not a placeholder in the code.

**Plan-review disposition:**
- **#1 (mutating a disposed QuickPick)** — fixed: a `disposed` flag set in
  `onDidHide` guards both `runQuery` resolution paths and the `busy` write; a new
  test ("results arriving after the pick is hidden do not mutate it") exercises it.
- **#2 (missing `matchOnDescription`)** — fixed for parity, with a caveat: because
  every result sets `alwaysShow: true`, VS Code's local filter is bypassed, so
  `matchOnDescription`/`matchOnDetail` have no functional effect on our rows.
- **#3 (`setTimeout` typing)** — rejected. `ReturnType<typeof setTimeout>` already
  compiles cleanly in this repo (`connection-manager.ts:39` uses the identical
  pattern), and the proposed `any`/cast remedy would violate the no-`any`
  non-negotiable (Biome `noExplicitAny`). Task 1/2 typecheck steps cover it.

**Type consistency:** `SearchPick`/`RankedResult` identical across Tasks 1–2.
`QuickPickLike<T>` used by the shim (Task 2 Step 1), the stub (Step 2), the
fixture (Step 7), and `createQuickPick<SearchPick>()` (Step 10). `openSource`'s
`{ url?: string }` param matches `IndexItem` and the `{ url }` call site. Command
ids `nimbus.search`/`nimbus.searchSelection` match the manifest (already
registered; no manifest change needed). `searchRanked({ name, limit })` matches
`RankedSearchParams`.
