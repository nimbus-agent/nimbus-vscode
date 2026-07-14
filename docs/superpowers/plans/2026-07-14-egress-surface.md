# Egress Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an Egress sidebar view plus "Verify Egress Ledger" and "Prove Egress Window" commands, backed by the egress-ledger RPCs in `@nimbus-dev/client@0.4.0`.

**Architecture:** A pure logic module (`src/sidebar/egress.ts`) parses ledger rows and formats detail/proof documents; a thin view (`src/sidebar/egress-view.ts`) wraps the shared `createDataView` seam exactly like the Audit view; `extension.ts` registers the view and four commands, calling the typed client through `connection.client()`. File I/O goes through a new injected `saveJson` seam so command logic stays testable without `vscode`.

**Tech Stack:** TypeScript (strict), esbuild bundle, Vitest (with `vscode` aliased to `test/unit/vscode-stub.ts`), Biome, `@nimbus-dev/client` IPC.

## Global Constraints

Copied verbatim from the spec — every task must honour these:

- TypeScript **strict**; **no `any`** (external data is `unknown`, then parsed).
- **No `console`** in `src/` — log via `logging.ts` (`log.warn(...)`). Biome enforces `noConsole`, `noExplicitAny`, `noNonNullAssertion`.
- `tsconfig` has **`exactOptionalPropertyTypes`** — never assign `undefined` to an optional field; build objects incrementally.
- The `@nimbus-dev/client` dependency is a **published** `^x.y.z` version, never `workspace:*`.
- The `vscode` API is touched only through `vscode-shim.ts` interfaces or an injected seam (like `createReadonlyJsonOpener`) — never imported into `src/sidebar/*` pure modules or tests.
- `bun run check-bundle` must still show **`vscode` as the sole bundle external** after the client bump.
- Coverage stays at the current ~95%.
- Import paths use the `.js` extension (NodeNext), even for `.ts` sources.

Verification gate for every task's final step (and the whole feature):
`bun run typecheck && bun run lint && bun run test && bun run build && bun run check-bundle`

---

### Task 1: Bump `@nimbus-dev/client` to `^0.4.0`

**Files:**
- Modify: `package.json` (dependencies)

**Interfaces:**
- Consumes: nothing.
- Produces: `NimbusClient` with `egressHead()`, `egressList(params?)`, `egressVerify()`, `egressProveWindow(params?)` and the exported types `EgressRow`, `EgressVerifyResult`, `EgressProveWindowResult` available to later tasks.

- [ ] **Step 1: Edit the dependency version**

In `package.json`, change:

```json
    "@nimbus-dev/client": "^0.2.4",
```

to:

```json
    "@nimbus-dev/client": "^0.4.0",
```

- [ ] **Step 2: Install**

Run: `bun install`
Expected: lockfile updates; `node_modules/@nimbus-dev/client` resolves to `0.4.0`.

- [ ] **Step 3: Verify the new RPCs are typed**

Run: `bun run typecheck`
Expected: PASS (no code uses the new methods yet; this confirms the bump doesn't break existing types).

- [ ] **Step 4: Verify the bundling invariant still holds**

Run: `bun run build && bun run check-bundle`
Expected: PASS — `check-bundle` reports `vscode` as the only external; the client is inlined.

- [ ] **Step 5: Commit**

```bash
git add package.json bun.lockb
git commit -m "chore(deps): bump @nimbus-dev/client to ^0.4.0 (egress RPCs)"
```

---

### Task 2: Pure egress module (`src/sidebar/egress.ts`)

Mirrors `src/sidebar/audit.ts`. No `vscode` imports.

**Files:**
- Create: `src/sidebar/egress.ts`
- Test: `test/unit/egress.test.ts`

**Interfaces:**
- Consumes: `formatRelativeTime(now, timestamp)` from `./relative-time.js`; `SidebarItem` from `./tree-view.js`.
- Produces:
  - `interface EgressRow { id: number; timestamp: number; sourceType: string; sourceId: string | null; destination: string; method: string; payloadSummary: string; hitlStatus: string; resultStatus: string; rowHash: string; prevHash: string }`
  - `parseEgressRow(raw: unknown): EgressRow | undefined`
  - `iconForResult(resultStatus: string): string`
  - `egressRowToItem(row: EgressRow, now: number): SidebarItem`
  - `formatEgressDetail(raw: unknown): { title: string; content: string } | undefined`
  - `interface EgressWindowPreset { label: string; since?: number; until?: number }`
  - `egressWindowPresets(now: number): EgressWindowPreset[]`
  - `buildProofDocument(result: unknown, now: number): { filename: string; content: string }`

- [ ] **Step 1: Write the failing test**

Create `test/unit/egress.test.ts`:

```ts
import { describe, expect, test } from "vitest";

import {
  buildProofDocument,
  egressRowToItem,
  egressWindowPresets,
  formatEgressDetail,
  iconForResult,
  parseEgressRow,
} from "../../src/sidebar/egress.js";

function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 7,
    timestamp: 5_000,
    sourceType: "agent",
    sourceId: "sess-1",
    destination: "gmail",
    method: "send",
    payloadSummary: "to: a@b.c",
    hitlStatus: "approved",
    resultStatus: "authorized",
    rowHash: "hh",
    prevHash: "pp",
    ...over,
  };
}

describe("parseEgressRow", () => {
  test("coerces a full row", () => {
    const r = parseEgressRow(row());
    expect(r).toMatchObject({
      id: 7,
      destination: "gmail",
      method: "send",
      resultStatus: "authorized",
      hitlStatus: "approved",
      sourceId: "sess-1",
      rowHash: "hh",
      prevHash: "pp",
    });
  });

  test("preserves a null sourceId", () => {
    expect(parseEgressRow(row({ sourceId: null }))?.sourceId).toBeNull();
  });

  test("rejects rows missing destination, method, or a numeric timestamp", () => {
    expect(parseEgressRow(row({ destination: 1 }))).toBeUndefined();
    expect(parseEgressRow(row({ method: undefined }))).toBeUndefined();
    expect(parseEgressRow(row({ timestamp: "nope" }))).toBeUndefined();
    expect(parseEgressRow("garbage")).toBeUndefined();
    expect(parseEgressRow(null)).toBeUndefined();
  });

  test("defaults missing optional fields safely", () => {
    const r = parseEgressRow({ destination: "d", method: "m", timestamp: 1 });
    expect(r).toMatchObject({
      id: 0,
      sourceId: null,
      sourceType: "",
      payloadSummary: "",
      hitlStatus: "not_required",
      resultStatus: "blocked",
      rowHash: "",
      prevHash: "",
    });
  });
});

describe("iconForResult", () => {
  test("maps known and unknown statuses", () => {
    expect(iconForResult("authorized")).toBe("pass");
    expect(iconForResult("blocked")).toBe("error");
    expect(iconForResult("weird")).toBe("dash");
  });
});

describe("egressRowToItem", () => {
  test("builds label, description, icon, tooltip, and command", () => {
    const item = egressRowToItem(parseEgressRow(row()) as never, 65_000);
    expect(item).toMatchObject({
      label: "gmail.send",
      description: "1m ago",
      iconId: "pass",
      command: { command: "nimbus.openEgressEntry", title: "Open Egress Entry" },
    });
    expect(item.tooltip).toContain("authorized");
    expect(item.tooltip).toContain("approved");
    expect(item.command?.arguments?.[0]).toMatchObject({ id: 7 });
  });

  test("blocked rows get the error icon", () => {
    const item = egressRowToItem(parseEgressRow(row({ resultStatus: "blocked" })) as never, 5_000);
    expect(item.iconId).toBe("error");
  });
});

describe("formatEgressDetail", () => {
  test("titles by id and includes hashes plus an ISO timestamp", () => {
    const detail = formatEgressDetail(row({ id: 42, timestamp: 0 }));
    expect(detail?.title).toBe("egress-42.json");
    const parsed = JSON.parse(detail?.content ?? "{}");
    expect(parsed).toMatchObject({
      id: 42,
      rowHash: "hh",
      prevHash: "pp",
      timestampIso: "1970-01-01T00:00:00.000Z",
    });
  });

  test("returns undefined for an unparseable row", () => {
    expect(formatEgressDetail("garbage")).toBeUndefined();
  });
});

describe("egressWindowPresets", () => {
  test("computes preset lower bounds relative to now; All time has none", () => {
    const now = 1_000_000_000;
    const presets = egressWindowPresets(now);
    expect(presets.map((p) => p.label)).toEqual([
      "Last hour",
      "Last 24 hours",
      "Last 7 days",
      "All time",
    ]);
    expect(presets[0]).toEqual({ label: "Last hour", since: now - 3_600_000 });
    expect(presets[1]?.since).toBe(now - 86_400_000);
    expect(presets[2]?.since).toBe(now - 604_800_000);
    expect(presets[3]).toEqual({ label: "All time" });
    expect("since" in (presets[3] as object)).toBe(false);
  });
});

describe("buildProofDocument", () => {
  test("names the file with the epoch-ms stamp and round-trips the result", () => {
    const result = { rows: [{ id: 1 }], completeness: { tier: "authorized-actions" } };
    const doc = buildProofDocument(result, 1_700_000_000_000);
    expect(doc.filename).toBe("egress-proof-1700000000000.json");
    expect(JSON.parse(doc.content)).toEqual(result);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bunx vitest run test/unit/egress.test.ts`
Expected: FAIL — cannot resolve `../../src/sidebar/egress.js`.

- [ ] **Step 3: Write the implementation**

Create `src/sidebar/egress.ts`:

```ts
import { formatRelativeTime } from "./relative-time.js";
import type { SidebarItem } from "./tree-view.js";

// The client types egress rows, but we parse defensively — consistent with the
// Audit view and resilient to shape drift. Mirrors the Gateway's EgressRow.
export interface EgressRow {
  id: number;
  timestamp: number;
  sourceType: string;
  sourceId: string | null;
  destination: string;
  method: string;
  payloadSummary: string;
  hitlStatus: string;
  resultStatus: string;
  rowHash: string;
  prevHash: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function str(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

// Coerce one unknown ledger row into a typed row, or undefined when it lacks the
// fields a row needs to render (a destination + method and a numeric timestamp).
export function parseEgressRow(raw: unknown): EgressRow | undefined {
  const rec = asRecord(raw);
  if (rec === undefined) return undefined;
  const destination = rec["destination"];
  const method = rec["method"];
  const timestamp = rec["timestamp"];
  if (typeof destination !== "string" || typeof method !== "string") return undefined;
  if (typeof timestamp !== "number") return undefined;
  return {
    id: typeof rec["id"] === "number" ? rec["id"] : 0,
    timestamp,
    sourceType: str(rec["sourceType"], ""),
    sourceId: typeof rec["sourceId"] === "string" ? rec["sourceId"] : null,
    destination,
    method,
    payloadSummary: str(rec["payloadSummary"], ""),
    hitlStatus: str(rec["hitlStatus"], "not_required"),
    resultStatus: str(rec["resultStatus"], "blocked"),
    rowHash: str(rec["rowHash"], ""),
    prevHash: str(rec["prevHash"], ""),
  };
}

// Icon keys off resultStatus — the security-relevant signal. Per the 0.4.0
// client types resultStatus is "authorized" | "blocked"; "dash" is only a
// defensive fallback for an unexpected value.
export function iconForResult(resultStatus: string): string {
  if (resultStatus === "authorized") return "pass";
  if (resultStatus === "blocked") return "error";
  return "dash";
}

export function egressRowToItem(row: EgressRow, now: number): SidebarItem {
  return {
    label: `${row.destination}.${row.method}`,
    description: formatRelativeTime(now, row.timestamp),
    tooltip: `${row.destination}.${row.method} · ${row.resultStatus} · consent ${row.hitlStatus}`,
    iconId: iconForResult(row.resultStatus),
    command: {
      command: "nimbus.openEgressEntry",
      title: "Open Egress Entry",
      arguments: [row],
    },
  };
}

// Read-only detail document for one row: a stable title and the full row
// (hashes included) with an added ISO timestamp. Accepts unknown so the command
// handler can pass a tree-item argument straight through.
export function formatEgressDetail(raw: unknown): { title: string; content: string } | undefined {
  const row = parseEgressRow(raw);
  if (row === undefined) return undefined;
  const body = { ...row, timestampIso: new Date(row.timestamp).toISOString() };
  return { title: `egress-${row.id}.json`, content: JSON.stringify(body, null, 2) };
}

export interface EgressWindowPreset {
  label: string;
  since?: number;
  until?: number;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const WEEK_MS = 604_800_000;

// Ordered prove-window presets. `until` is left open; "All time" has no bounds.
export function egressWindowPresets(now: number): EgressWindowPreset[] {
  return [
    { label: "Last hour", since: now - HOUR_MS },
    { label: "Last 24 hours", since: now - DAY_MS },
    { label: "Last 7 days", since: now - WEEK_MS },
    { label: "All time" },
  ];
}

// The proof artifact: the egressProveWindow result verbatim, named with an
// epoch-ms stamp (deterministic, filesystem-safe, sortable).
export function buildProofDocument(
  result: unknown,
  now: number,
): { filename: string; content: string } {
  return {
    filename: `egress-proof-${now}.json`,
    content: JSON.stringify(result, null, 2),
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bunx vitest run test/unit/egress.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Lint + typecheck the new file**

Run: `bun run lint && bun run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/sidebar/egress.ts test/unit/egress.test.ts
git commit -m "feat(sidebar): egress ledger parsing, detail, and proof helpers"
```

---

### Task 3: Egress view (`src/sidebar/egress-view.ts`)

Mirrors `src/sidebar/audit-view.ts`.

**Files:**
- Create: `src/sidebar/egress-view.ts`
- Test: `test/unit/egress-view.test.ts`

**Interfaces:**
- Consumes: `parseEgressRow`, `egressRowToItem`, `EgressRow` from `./egress.js`; `createDataView`, `errorRow`, `SidebarConnection`, `SidebarItem`, `SidebarView` from `./tree-view.js`.
- Produces:
  - `interface EgressClientLike { egressList(params?: { since?: number; until?: number; limit?: number }): Promise<{ rows: unknown[] }> }`
  - `createEgressView(deps: { connection: SidebarConnection; getClient: () => EgressClientLike | undefined; limit?: number; now?: () => number }): SidebarView`

- [ ] **Step 1: Write the failing test**

Create `test/unit/egress-view.test.ts`:

```ts
import { describe, expect, test } from "vitest";

import type { ConnectionState } from "../../src/connection/connection-manager.js";
import { createEgressView, type EgressClientLike } from "../../src/sidebar/egress-view.js";
import type { SidebarConnection } from "../../src/sidebar/tree-view.js";

function makeConnection(initial: ConnectionState): { connection: SidebarConnection } {
  let state = initial;
  const listeners = new Set<(s: ConnectionState) => void>();
  return {
    connection: {
      current: () => state,
      onState: (l) => {
        listeners.add(l);
        return { dispose: () => listeners.delete(l) };
      },
    },
  };
}

const connected: ConnectionState = { kind: "connected", socketPath: "/s" };

function egressRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    timestamp: 1_000,
    destination: "gmail",
    method: "send",
    resultStatus: "authorized",
    hitlStatus: "approved",
    ...over,
  };
}

describe("createEgressView", () => {
  test("shows a not-connected row and never calls the client when the client is missing", async () => {
    let calls = 0;
    const c = makeConnection(connected);
    const view = createEgressView({
      connection: c.connection,
      getClient: () => {
        calls += 1;
        return undefined;
      },
    });
    const rows = await view.getChildren();
    expect(rows[0]?.label).toMatch(/reconnect/i);
    expect(calls).toBe(1);
  });

  test("maps ledger rows to items when connected, dropping unparseable rows", async () => {
    const client: EgressClientLike = {
      egressList: async () => ({
        rows: [
          egressRow({ id: 1, resultStatus: "authorized", timestamp: 1_000 }),
          egressRow({ id: 2, resultStatus: "blocked", timestamp: 2_000 }),
          "garbage",
        ],
      }),
    };
    const c = makeConnection(connected);
    const view = createEgressView({
      connection: c.connection,
      getClient: () => client,
      now: () => 61_000,
    });
    const rows = await view.getChildren();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ label: "gmail.send", iconId: "pass", description: "1m ago" });
    expect(rows[1]).toMatchObject({ iconId: "error" });
  });

  test("shows an empty-state row when connected with no rows", async () => {
    const c = makeConnection(connected);
    const view = createEgressView({
      connection: c.connection,
      getClient: () => ({ egressList: async () => ({ rows: [] }) }),
    });
    expect((await view.getChildren())[0]?.label).toBe("No egress entries yet");
  });

  test("surfaces an error row when egressList rejects", async () => {
    const c = makeConnection(connected);
    const view = createEgressView({
      connection: c.connection,
      getClient: () => ({
        egressList: async () => {
          throw new Error("ipc boom");
        },
      }),
    });
    const rows = await view.getChildren();
    expect(rows[0]?.label).toMatch(/failed to load the egress ledger/i);
    expect(rows[0]?.tooltip).toContain("ipc boom");
    expect(rows[0]?.iconId).toBe("error");
  });

  test("passes the configured limit through to egressList", async () => {
    let seen: number | undefined;
    const c = makeConnection(connected);
    const view = createEgressView({
      connection: c.connection,
      limit: 25,
      getClient: () => ({
        egressList: async (params) => {
          seen = params?.limit;
          return { rows: [] };
        },
      }),
    });
    await view.getChildren();
    expect(seen).toBe(25);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bunx vitest run test/unit/egress-view.test.ts`
Expected: FAIL — cannot resolve `../../src/sidebar/egress-view.js`.

- [ ] **Step 3: Write the implementation**

Create `src/sidebar/egress-view.ts`:

```ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bunx vitest run test/unit/egress-view.test.ts`
Expected: PASS.

- [ ] **Step 5: Lint + typecheck**

Run: `bun run lint && bun run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/sidebar/egress-view.ts test/unit/egress-view.test.ts
git commit -m "feat(sidebar): live Egress ledger tree view"
```

---

### Task 4: Manifest contributions (`package.json`)

Registers the view, four commands, and their menus. No unit test (manifest config); validated by JSON parse + build.

**Files:**
- Modify: `package.json` (`contributes.commands`, `contributes.views.nimbus`, `contributes.menus`)

**Interfaces:**
- Consumes: nothing.
- Produces: command ids `nimbus.refreshEgress`, `nimbus.openEgressEntry`, `nimbus.verifyEgress`, `nimbus.proveEgressWindow` and view id `nimbus.egressView` for Task 5 to register handlers against.

- [ ] **Step 1: Add the four commands**

In `contributes.commands`, after the `nimbus.openAgentChat` entry, add:

```json
      {
        "command": "nimbus.refreshEgress",
        "title": "Refresh Egress",
        "category": "Nimbus",
        "icon": "$(refresh)"
      },
      {
        "command": "nimbus.openEgressEntry",
        "title": "Open Egress Entry",
        "category": "Nimbus"
      },
      {
        "command": "nimbus.verifyEgress",
        "title": "Verify Egress Ledger",
        "category": "Nimbus"
      },
      {
        "command": "nimbus.proveEgressWindow",
        "title": "Prove Egress Window",
        "category": "Nimbus"
      }
```

(Add a comma after the `nimbus.openAgentChat` closing brace so the array stays valid.)

- [ ] **Step 2: Register the view immediately after Audit**

In `contributes.views.nimbus`, insert after the `nimbus.auditView` entry:

```json
        {
          "id": "nimbus.egressView",
          "name": "Egress"
        },
```

- [ ] **Step 3: Add the title-bar menus**

In `contributes.menus.view/title`, add:

```json
        {
          "command": "nimbus.refreshEgress",
          "when": "view == nimbus.egressView",
          "group": "navigation"
        },
        {
          "command": "nimbus.verifyEgress",
          "when": "view == nimbus.egressView",
          "group": "1_egress"
        },
        {
          "command": "nimbus.proveEgressWindow",
          "when": "view == nimbus.egressView",
          "group": "1_egress"
        }
```

(`refresh` shows inline via its icon in the `navigation` group; verify/prove go into the `···` overflow via the `1_egress` group.)

- [ ] **Step 4: Hide the row-detail command from the palette**

In `contributes.menus.commandPalette`, add:

```json
        {
          "command": "nimbus.openEgressEntry",
          "when": "false"
        }
```

- [ ] **Step 5: Validate the manifest**

Run: `node -e "JSON.parse(require('fs').readFileSync('package.json','utf8')); console.log('ok')"`
Expected: prints `ok` (no JSON syntax error from the edits).

- [ ] **Step 6: Commit**

```bash
git add package.json
git commit -m "feat(sidebar): register Egress view + verify/prove commands (manifest)"
```

---

### Task 5: Wire the view and commands into `extension.ts`

**Files:**
- Modify: `src/extension.ts` (imports, `ActivateDeps`, view creation, `sidebarViews`, command registrations, new `createProofSaver` seam)
- Modify: `test/unit/vscode-stub.ts` (add `showSaveDialog`, `workspace.fs`, `workspace.workspaceFolders`)
- Modify: `test/unit/extension.test.ts` (fixture support + new tests)

**Interfaces:**
- Consumes: `createEgressView` from `./sidebar/egress-view.js`; `formatEgressDetail`, `buildProofDocument`, `egressWindowPresets` from `./sidebar/egress.js`; `connection.client()`; `deps.window.showQuickPick/showInformationMessage/showWarningMessage/showErrorMessage`; `deps.commands.executeCommand`; `openReadonlyJson`.
- Produces: a running Egress view registered as `["nimbus.egressView", egressView]` and command handlers for `nimbus.refreshEgress`, `nimbus.openEgressEntry`, `nimbus.verifyEgress`, `nimbus.proveEgressWindow`; a new injectable `deps.saveJson` seam.

- [ ] **Step 1: Write the failing tests (fixture support first)**

In `test/unit/extension.test.ts`, extend the fixture and add tests.

1a. Add capture fields and options. In the `makeFixture` `opts` object type, add:

```ts
  quickPickAnswers?: Array<{ label: string } | undefined>;
  infoMessageClicks?: Array<string | undefined>;
  saveJsonResult?: { fsPath: string } | undefined;
```

1b. Near the other capture arrays in `makeFixture`, add:

```ts
  const quickPickAnswers = [...(opts.quickPickAnswers ?? [])];
  const infoClicks = [...(opts.infoMessageClicks ?? [])];
  const saveJsonCalls: Array<{ defaultName: string; content: string }> = [];
```

1c. Replace the `showQuickPick` and `showInformationMessage` fakes in the `window` object with answer-aware versions:

```ts
    showInformationMessage: vi.fn(async (m: string) => {
      infoMessages.push(m);
      return infoClicks.shift();
    }),
```
```ts
    showQuickPick: vi.fn(async () => quickPickAnswers.shift()),
```

1d. In the `deps` object, add a `saveJson` fake and expose it (only when the test provides `saveJsonResult`, so existing tests are unaffected):

```ts
    saveJson: async (defaultName: string, content: string) => {
      saveJsonCalls.push({ defaultName, content });
      return opts.saveJsonResult;
    },
```

1e. Return `saveJsonCalls` from `makeFixture` (add to the returned object): `saveJsonCalls,` and add `saveJsonCalls: Array<{ defaultName: string; content: string }>;` to the `Captured` interface.

1f. Add the tests (inside the `describe("activateWithDeps", ...)` block):

```ts
  test("verifyEgress reports an intact ledger", async () => {
    const f = makeFixture({
      openClient: makeFakeClient({
        egressVerify: async () => ({ ok: true, verifiedRows: 12 }),
      } as never),
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await cmd(f, "nimbus.verifyEgress")();
    expect(f.infoMessages.some((m) => /intact — 12 rows/.test(m))).toBe(true);
  });

  test("verifyEgress reports a broken chain with the row and reason", async () => {
    const f = makeFixture({
      openClient: makeFakeClient({
        egressVerify: async () => ({ ok: false, verifiedRows: 3, brokenAt: 4, reason: "hash" }),
      } as never),
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await cmd(f, "nimbus.verifyEgress")();
    expect(f.errorMessages.some((m) => /broke at row 4: hash/.test(m))).toBe(true);
  });

  test("verifyEgress warns when disconnected", async () => {
    const f = makeFixture({ openClient: disconnectedClient() });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await cmd(f, "nimbus.verifyEgress")();
    expect(f.warnMessages.some((m) => /not connected/i.test(m))).toBe(true);
  });

  test("proveEgressWindow saves a proof and offers to open it", async () => {
    const savedUri = { fsPath: "/tmp/egress-proof.json" };
    const f = makeFixture({
      quickPickAnswers: [{ label: "Last hour" }],
      infoMessageClicks: ["Open File"],
      saveJsonResult: savedUri,
      openClient: makeFakeClient({
        egressProveWindow: async (params: unknown) => ({ params, rows: [], verify: { ok: true } }),
      } as never),
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await cmd(f, "nimbus.proveEgressWindow")();
    expect(f.saveJsonCalls).toHaveLength(1);
    expect(f.saveJsonCalls[0]?.defaultName).toMatch(/^egress-proof-\d+\.json$/);
    expect(f.infoMessages.some((m) => /proof saved/i.test(m))).toBe(true);
    expect(commands.executeCommand).toHaveBeenCalledWith("vscode.open", savedUri);
  });

  test("proveEgressWindow does nothing when the window picker is cancelled", async () => {
    let proveCalls = 0;
    const f = makeFixture({
      quickPickAnswers: [undefined],
      openClient: makeFakeClient({
        egressProveWindow: async () => {
          proveCalls += 1;
          return { rows: [] };
        },
      } as never),
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await cmd(f, "nimbus.proveEgressWindow")();
    expect(proveCalls).toBe(0);
    expect(f.saveJsonCalls).toHaveLength(0);
  });

  test("proveEgressWindow is silent when the save dialog is cancelled", async () => {
    const f = makeFixture({
      quickPickAnswers: [{ label: "All time" }],
      saveJsonResult: undefined,
      openClient: makeFakeClient({
        egressProveWindow: async () => ({ rows: [] }),
      } as never),
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await cmd(f, "nimbus.proveEgressWindow")();
    expect(f.saveJsonCalls).toHaveLength(1);
    expect(f.infoMessages.some((m) => /proof saved/i.test(m))).toBe(false);
    expect(commands.executeCommand).not.toHaveBeenCalledWith("vscode.open", expect.anything());
  });

  test("openEgressEntry opens the row detail as read-only JSON", async () => {
    const f = makeFixture({});
    activateWithDeps(f.ctx, f.deps);
    await cmd(f, "nimbus.openEgressEntry")({
      id: 9,
      timestamp: 0,
      destination: "gmail",
      method: "send",
      resultStatus: "authorized",
      hitlStatus: "approved",
    });
    expect(f.openedDocs.some((d) => d.title === "egress-9.json")).toBe(true);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bunx vitest run test/unit/extension.test.ts`
Expected: FAIL — the `nimbus.verifyEgress` / `nimbus.proveEgressWindow` / `nimbus.openEgressEntry` commands are not registered yet.

- [ ] **Step 3: Add the imports and the `saveJson` dep**

In `src/extension.ts`, extend the existing sidebar imports:

```ts
import { formatAuditDetail } from "./sidebar/audit.js";
import { createAuditView } from "./sidebar/audit-view.js";
import { buildProofDocument, egressWindowPresets, formatEgressDetail } from "./sidebar/egress.js";
import { createEgressView } from "./sidebar/egress-view.js";
```

In `ActivateDeps`, after `openSource?:`, add:

```ts
  saveJson?: (defaultName: string, content: string) => Promise<{ fsPath: string } | undefined>;
```

- [ ] **Step 4: Create the view and register it**

After the `const auditView = createAuditView({ ... });` block, add:

```ts
  const egressView = createEgressView({
    connection,
    getClient: () => connection.client() as NimbusClient | undefined,
  });
```

In the `sidebarViews` array, add the egress entry right after the audit entry:

```ts
  const sidebarViews: ReadonlyArray<[string, SidebarView]> = [
    ["nimbus.auditView", auditView],
    ["nimbus.egressView", egressView],
    ["nimbus.agentsView", agentsView],
    ["nimbus.indexView", indexView],
    ["nimbus.sessionsView", sessionsView],
  ];
```

- [ ] **Step 5: Resolve the `saveJson` seam**

Next to `const openReadonlyJson = ...`, add:

```ts
  const saveJson = deps.saveJson ?? createProofSaver();
```

- [ ] **Step 6: Register the commands**

After the `register("nimbus.refreshAudit", ...)` block, add:

```ts
  register("nimbus.refreshEgress", () => {
    egressView.refresh();
  });
```

After the `register("nimbus.openAuditEntry", ...)` block, add:

```ts
  register("nimbus.openEgressEntry", async (...args) => {
    const detail = formatEgressDetail(args[0]);
    if (detail === undefined) return;
    await openReadonlyJson(detail.title, detail.content);
  });

  register("nimbus.verifyEgress", async () => {
    const client = connection.client() as NimbusClient | undefined;
    if (client === undefined) {
      void deps.window.showWarningMessage("Nimbus: not connected to the Gateway.");
      return;
    }
    try {
      const result = await client.egressVerify();
      if (result.ok) {
        void deps.window.showInformationMessage(
          `Egress ledger intact — ${result.verifiedRows} rows verified.`,
          {},
        );
      } else {
        const at = result.brokenAt ?? "?";
        const reason = result.reason !== undefined ? `: ${result.reason}` : "";
        void deps.window.showErrorMessage(`Egress chain broke at row ${at}${reason}.`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log.warn(`egress verify failed: ${msg}`);
      void deps.window.showErrorMessage(`Nimbus: egress verify failed: ${msg}`);
    }
  });

  register("nimbus.proveEgressWindow", async () => {
    const client = connection.client() as NimbusClient | undefined;
    if (client === undefined) {
      void deps.window.showWarningMessage("Nimbus: not connected to the Gateway.");
      return;
    }
    const presets = egressWindowPresets(Date.now());
    const pick = await deps.window.showQuickPick(
      presets.map((p) => ({ label: p.label })),
      { placeHolder: "Prove egress for which window?" },
    );
    if (pick === undefined) return;
    const preset = presets.find((p) => p.label === pick.label);
    if (preset === undefined) return;
    try {
      const params: { since?: number; until?: number; sign: boolean } = { sign: true };
      if (preset.since !== undefined) params.since = preset.since;
      if (preset.until !== undefined) params.until = preset.until;
      const result = await client.egressProveWindow(params);
      const doc = buildProofDocument(result, Date.now());
      const saved = await saveJson(doc.filename, doc.content);
      if (saved === undefined) return;
      const action = await deps.window.showInformationMessage("Egress proof saved.", {}, "Open File");
      if (action === "Open File") {
        await deps.commands.executeCommand("vscode.open", saved);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log.warn(`egress prove failed: ${msg}`);
      void deps.window.showErrorMessage(`Nimbus: egress prove failed: ${msg}`);
    }
  });
```

- [ ] **Step 7: Add the default `createProofSaver` seam**

At the bottom of `src/extension.ts`, after `createSourceOpener`, add:

```ts
// Save a JSON document to disk via a native Save dialog; returns the chosen Uri
// (with fsPath) or undefined when cancelled. Injectable as deps.saveJson so
// tests don't touch vscode.
function createProofSaver(): (
  defaultName: string,
  content: string,
) => Promise<{ fsPath: string } | undefined> {
  return async (defaultName, content) => {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
    const defaultUri =
      folder !== undefined
        ? vscode.Uri.joinPath(folder, defaultName)
        : vscode.Uri.file(defaultName);
    const target = await vscode.window.showSaveDialog({
      defaultUri,
      filters: { JSON: ["json"] },
    });
    if (target === undefined) return undefined;
    await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(content));
    return target;
  };
}
```

- [ ] **Step 8: Add the stub surface for the default seam**

In `test/unit/vscode-stub.ts`, add `showSaveDialog` to `window`:

```ts
  showSaveDialog: async (_opts?: unknown) => ({ fsPath: "/tmp/egress-proof.json", scheme: "file" }),
```

Add `workspaceFolders` and `fs` to `workspace`:

```ts
export const workspace = {
  // ...existing members...
  workspaceFolders: undefined as Array<{ uri: unknown }> | undefined,
  fs: {
    writeFile: async (_uri: unknown, _content: Uint8Array) => undefined,
  },
};
```

(Keep the existing `getConfiguration`, `onDidChangeConfiguration`, `registerTextDocumentContentProvider`, `openTextDocument` members.)

- [ ] **Step 9: Add a test that exercises the default `createProofSaver`**

In `test/unit/extension.test.ts`, add a focused unit test for the exported-by-fallback path. First export the fixture flag by dropping the injected `saveJson` when a `realProofSave` opt is set — add to `makeFixture`, after the existing `realAuditDetail` drop:

```ts
  if (opts.realProofSave === true) delete deps.saveJson;
```

Add `realProofSave?: boolean;` to the `opts` type. Then the test:

```ts
  test("the default proof saver writes through the save dialog", async () => {
    const f = makeFixture({
      realProofSave: true,
      quickPickAnswers: [{ label: "Last 7 days" }],
      infoMessageClicks: [undefined],
      openClient: makeFakeClient({
        egressProveWindow: async () => ({ rows: [], verify: { ok: true } }),
      } as never),
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await cmd(f, "nimbus.proveEgressWindow")();
    // The stub's showSaveDialog returns a fsPath, so a success toast is shown.
    expect(f.infoMessages.some((m) => /proof saved/i.test(m))).toBe(true);
  });
```

- [ ] **Step 10: Run the full unit suite**

Run: `bunx vitest run`
Expected: PASS — all new tests green, no regressions.

- [ ] **Step 11: Full verification gate**

Run: `bun run typecheck && bun run lint && bun run test && bun run build && bun run check-bundle`
Expected: PASS at every stage; `check-bundle` still reports `vscode` as the only external.

- [ ] **Step 12: Commit**

```bash
git add src/extension.ts test/unit/vscode-stub.ts test/unit/extension.test.ts
git commit -m "feat(sidebar): wire Egress view + verify/prove-window commands"
```

---

### Task 6: Documentation

**Files:**
- Modify: `CLAUDE.md` (the "Surface today" paragraph)
- Modify: `docs/architecture.md` (surface list)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing (docs only).

- [ ] **Step 1: Update CLAUDE.md**

In the "Surface today" paragraph, move egress from blocked to shipped. Replace:

```
plus a status-bar quick menu and connection + HITL plumbing. Workflow / share / egress surfaces are **not implemented yet** — they are blocked upstream, not deferred by choice: no published `@nimbus-dev/client` exposes those RPCs (checked through `0.3.0`), and the non-negotiable below forbids reaching past the typed client. Building them starts with the Gateway shipping the RPCs and the client surfacing them typed.
```

with:

```
plus an **Egress** ledger viewer (with Verify-ledger and Prove-window commands); a status-bar quick menu and connection + HITL plumbing. Workflow / share surfaces are **not implemented yet** — they are blocked upstream, not deferred by choice: no published `@nimbus-dev/client` exposes those RPCs (checked through `0.4.0`, which added the egress RPCs this surface now uses), and the non-negotiable below forbids reaching past the typed client. Building them starts with the Gateway shipping the RPCs and the client surfacing them typed.
```

- [ ] **Step 2: Update docs/architecture.md**

Add the Egress view + verify/prove commands to the surface/sidebar description (match the existing wording style; add "Egress" alongside Audit/Sessions/Index/Agents and note the two commands). Read the file first to match its exact phrasing, then edit the relevant sentence.

- [ ] **Step 3: Verify docs don't break any doc checks**

Run: `bun run lint`
Expected: PASS (lint only covers `src/`, but run it to confirm nothing else regressed).

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md docs/architecture.md
git commit -m "docs: egress surface is shipped (client 0.4.0)"
```

---

## Self-Review

**Spec coverage:**
- Client bump → Task 1. ✅
- `egress.ts` (parse, item, detail, presets, proof doc) → Task 2. ✅
- `egress-view.ts` → Task 3. ✅
- Manifest (view, 4 commands, menus, palette-hide) → Task 4. ✅
- Extension wiring (view registration, refresh/open/verify/prove commands, `saveJson` seam, success toast + Open File) → Task 5. ✅
- Review-feedback fixes: #2 success toast + Open File (Task 5 Step 6), `saveJson` returns Uri (Task 5 Step 3/7); #5 both cancel paths tested (Task 5 Step 1 tests) + native overwrite via `showSaveDialog` (Task 5 Step 7). ✅
- Review deferrals: #1 inspect-row and #4 auto-refresh are out of scope (spec Non-goals) — no task, by design. ✅
- Review pushback: #3 icon mapping unchanged, `dash` fallback only — Task 2 `iconForResult`. ✅
- Tests (egress, egress-view, extension commands, stub) → Tasks 2, 3, 5. ✅
- Docs (CLAUDE.md, architecture.md) → Task 6. ✅

**Placeholder scan:** No TBD/TODO; every code step shows complete code. Task 6 Step 2 says "read the file first to match phrasing" — this is a deliberate instruction (docs prose must match the existing voice), not a placeholder; the exact CLAUDE.md replacement is given verbatim.

**Type consistency:** `EgressRow`, `EgressWindowPreset`, `EgressClientLike`, and the `{ fsPath: string }` saveJson return type are used identically across Tasks 2/3/5. Command ids match between Task 4 (manifest) and Task 5 (handlers). `egressWindowPresets` returns `{ label, since? }` and the prove command reads `preset.since`/`preset.until` — consistent. `iconForResult` returns `pass`/`error`/`dash` matching the tests.
