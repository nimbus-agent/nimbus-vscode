# Connector Management & Index Health Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the editor a Connectors view that explains *why* a source is
unhealthy and lets the user act on it — sync, pause, configure, re-index,
authenticate, add an MCP source, remove — plus a conditional Sources row in the
ambient context panel.

**Architecture:** A new `src/connectors/` module, pure except for
`commands.ts`, following `src/diagnostics/` and `src/scm/`. Every mutation is
normalised at one adapter (`connector-client.ts`) into a three-variant
`ConnectorOutcome`, because the twelve `connector*` RPCs report failure in four
different wire shapes and two of them mean *denied* rather than *broken*. The
view is a tree over the existing `createDataView` seam with `loadChildren` for
on-expand detail. The health rule already exists (`summarizeConnectorHealth`)
and is moved, not duplicated.

**Tech Stack:** TypeScript (strict, no `any`), Vitest, esbuild, the pinned
`@nimbus-dev/client` `^0.17.0` typed IPC client, VS Code TreeView API reached
only through `src/vscode-shim.ts`.

**Spec:** `docs/superpowers/specs/2026-08-18-connector-management-design.md`
(read it first; the review dispositions are in
`docs/superpowers/specs/2026-08-18-connector-management-review.md`)

## Global Constraints

- TypeScript **strict**, **no `any`** — use `unknown` for external data. Biome
  enforces `noExplicitAny`, `noConsole` in `src/`, `noNonNullAssertion`.
- Log via `logging.ts` only, never `console`.
- `vscode` is touched only through `src/vscode-shim.ts`.
- **No file in `src/connectors/` may name `agentInvoke`, `askStream`, or a
  gated `agents*` call — in code OR in comments.** `test/unit/egress-choke-point.test.ts`
  scans comments too, and `src/connectors/` must never be added to its `ALLOWED`
  list. Write `agents*` in prose if you must mention the family.
- The Gateway client is resolved **per call** — `getClient: () => nimbus()` —
  never captured in a closure at construction time (PR #103).
- `withProgress(options, task)` calls `task(progress, token)` — **reporter
  first**. Getting this backwards broke every workflow run in PR #100.
- No new `nimbus.*` setting: `check-settings-docs` must stay green untouched.
- After every task: `bun run test` and `bun run typecheck` must pass. Before
  the final commit of the branch also run `bun run lint`, `bun run build`,
  `bun run check-bundle`, `bun run check-vsix-contents`.
- Commit messages are Conventional Commits and end with:
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`

---

## File Structure

**Created:**

| File | Responsibility |
| --- | --- |
| `src/connectors/health.ts` | `summarizeConnectorHealth` (moved from `src/status-bar/`) |
| `src/connectors/rows.ts` | `ConnectorSyncStatus[]` → `SidebarItem[]`; icons, sorting, `contextValue`, payloads |
| `src/connectors/outcome.ts` | `ConnectorOutcome` union, its constructors, and its user-facing wording |
| `src/connectors/interval.ts` | `parseInterval("15m")` → ms, with the Gateway's 60s floor |
| `src/connectors/catalog.ts` | `AUTH_CATALOG` and the generic-field fallback |
| `src/connectors/connector-client.ts` | The adapter: `ConnectorClientLike` seam, every mutation → `ConnectorOutcome` |
| `src/connectors/connectors-view.ts` | The tree view + `loadChildren` |
| `src/connectors/commands.ts` | The nine commands over injected shim deps |
| `test/unit/connectors-rows.test.ts`, `connectors-outcome.test.ts`, `connectors-interval.test.ts`, `connectors-catalog.test.ts`, `connectors-client.test.ts`, `connectors-view.test.ts`, `connectors-commands.test.ts`, `manifest-connectors.test.ts` | one per unit |
| `docs/connectors.md` | The surface, the catalog's drift risk, why built-in onboarding is absent |

**Modified:** `src/extension.ts`, `src/vscode-shim.ts`, `src/context/signals.ts`,
`src/context/webview/render.ts`, `package.json`, `docs/architecture.md`,
`docs/ROADMAP.md`, `CLAUDE.md`, `test/unit/connector-health.test.ts` (import path only).

**Deleted:** `src/status-bar/connector-health.ts` (moved).

---

### Task 1: Move the health rule to `src/connectors/`

`summarizeConnectorHealth` already exists and already implements exactly the
rule this feature needs (`enabled && (error || backoff)`). It gains two more
consumers, so it moves out of `src/status-bar/`. **Behaviour must not change.**

**Files:**
- Create: `src/connectors/health.ts`
- Delete: `src/status-bar/connector-health.ts`
- Modify: `src/extension.ts` (import path), `test/unit/connector-health.test.ts` (import path)

**Interfaces:**
- Consumes: nothing.
- Produces: `summarizeConnectorHealth(statuses: readonly ConnectorSyncStatus[]): ConnectorHealthSummary`
  and `export type ConnectorHealthSummary = { count: number; names: string[] }`.
  Tasks 8 and 9 depend on the exported **type name**, which the original file
  did not have — it returned an inline object type.

- [ ] **Step 1: Copy the file to its new home, adding the named return type**

Create `src/connectors/health.ts`:

```ts
import type { ConnectorSyncStatus } from "@nimbus-dev/client";

/** How many connectors are degraded right now, and which. */
export type ConnectorHealthSummary = { count: number; names: string[] };

// A connector is degraded when it is enabled but its scheduler has given up or
// is backing off. paused/syncing are user-intended or transient, not degraded.
export function summarizeConnectorHealth(
  statuses: readonly ConnectorSyncStatus[],
): ConnectorHealthSummary {
  const names = statuses
    .filter((s) => s.enabled && (s.status === "error" || s.status === "backoff"))
    .map((s) => s.serviceId)
    .sort((a, b) => a.localeCompare(b));
  return { count: names.length, names };
}
```

- [ ] **Step 2: Delete the old file and repoint both importers**

```bash
rm src/status-bar/connector-health.ts
```

In `src/extension.ts` change:

```ts
import { summarizeConnectorHealth } from "./status-bar/connector-health.js";
```

to:

```ts
import { summarizeConnectorHealth } from "./connectors/health.js";
```

In `test/unit/connector-health.test.ts` change the import to
`../../src/connectors/health.js`. **Change nothing else in that test file** —
if an assertion needs editing, this was not a move.

- [ ] **Step 3: Run the suite and the typechecker**

Run: `bun run test && bun run typecheck`
Expected: PASS, same test count as before the move.

- [ ] **Step 4: Commit**

```bash
git add src/connectors/health.ts src/status-bar/connector-health.ts src/extension.ts test/unit/connector-health.test.ts
git commit -m "refactor(connectors): move the health rule out of the status bar"
```

---

### Task 2: Rows — statuses to tree items

**Files:**
- Create: `src/connectors/rows.ts`
- Test: `test/unit/connectors-rows.test.ts`

**Interfaces:**
- Consumes: `SidebarItem` from `src/sidebar/tree-view.js`, `formatRelativeTime` from `src/sidebar/relative-time.js`.
- Produces:
  - `CONNECTOR_CONTEXT = { active: "nimbus.connector.active", paused: "nimbus.connector.paused", disabled: "nimbus.connector.disabled", syncing: "nimbus.connector.syncing" } as const`
  - `type ConnectorPayload = { serviceId: string; itemCount: number }`
  - `connectorToItem(s: ConnectorSyncStatus, now: number): SidebarItem`
  - `connectorRows(statuses: readonly ConnectorSyncStatus[], now: number): SidebarItem[]`
  - `telemetryToItem(t: ConnectorSyncTelemetry, now: number): SidebarItem`
  - `healthEntryToItem(e: ConnectorHealthHistoryEntry, now: number): SidebarItem`
  - `connectorPayloadOf(item: SidebarItem): ConnectorPayload | undefined`

- [ ] **Step 1: Write the failing test**

Create `test/unit/connectors-rows.test.ts`:

```ts
import type { ConnectorSyncStatus } from "@nimbus-dev/client";
import { describe, expect, test } from "vitest";

import {
  CONNECTOR_CONTEXT,
  connectorPayloadOf,
  connectorRows,
  connectorToItem,
  healthEntryToItem,
  telemetryToItem,
} from "../../src/connectors/rows.js";

const NOW = 1_000_000_000;

function status(over: Partial<ConnectorSyncStatus> = {}): ConnectorSyncStatus {
  return {
    serviceId: "github",
    status: "ok",
    lastSyncAt: NOW - 180_000,
    nextSyncAt: NOW + 180_000,
    intervalMs: 360_000,
    itemCount: 1204,
    lastError: null,
    consecutiveFailures: 0,
    depth: "summary",
    enabled: true,
    ...over,
  };
}

describe("connectorToItem", () => {
  test("a healthy connector shows its item count and relative last sync", () => {
    const item = connectorToItem(status(), NOW);
    expect(item.label).toBe("github");
    expect(item.description).toBe("1,204 items · synced 3m ago");
    expect(item.iconId).toBe("pass");
    expect(item.contextValue).toBe(CONNECTOR_CONTEXT.active);
    expect(item.collapsible).toBe(true);
  });

  test("a connector that has never synced says so rather than dating from the epoch", () => {
    expect(connectorToItem(status({ lastSyncAt: null }), NOW).description).toBe(
      "1,204 items · never synced",
    );
  });

  test("each status maps to its own icon", () => {
    expect(connectorToItem(status({ status: "error" }), NOW).iconId).toBe("error");
    expect(connectorToItem(status({ status: "backoff" }), NOW).iconId).toBe("warning");
    expect(connectorToItem(status({ status: "paused" }), NOW).iconId).toBe("debug-pause");
    expect(connectorToItem(status({ status: "syncing" }), NOW).iconId).toBe("sync");
  });

  test("disabled overrides the icon and the contextValue whatever the status says", () => {
    const item = connectorToItem(status({ status: "error", enabled: false }), NOW);
    expect(item.iconId).toBe("circle-slash");
    expect(item.contextValue).toBe(CONNECTOR_CONTEXT.disabled);
  });

  test("a syncing connector carries the syncing contextValue, so the sync family hides", () => {
    expect(connectorToItem(status({ status: "syncing" }), NOW).contextValue).toBe(
      CONNECTOR_CONTEXT.syncing,
    );
  });

  test("the tooltip carries the error and the failure count", () => {
    const item = connectorToItem(
      status({ status: "error", lastError: "401 Unauthorized", consecutiveFailures: 3 }),
      NOW,
    );
    expect(item.tooltip).toContain("401 Unauthorized");
    expect(item.tooltip).toContain("3 consecutive failures");
  });

  test("the payload carries what a context-menu command needs", () => {
    expect(connectorPayloadOf(connectorToItem(status(), NOW))).toEqual({
      serviceId: "github",
      itemCount: 1204,
    });
  });

  test("a row we did not build yields no payload", () => {
    expect(connectorPayloadOf({ label: "No connectors registered" })).toBeUndefined();
  });
});

describe("connectorRows", () => {
  test("unhealthy connectors sort above healthy ones, then by id", () => {
    const rows = connectorRows(
      [
        status({ serviceId: "zulip", status: "ok" }),
        status({ serviceId: "slack", status: "backoff" }),
        status({ serviceId: "asana", status: "ok" }),
        status({ serviceId: "github", status: "error" }),
      ],
      NOW,
    );
    expect(rows.map((r) => r.label)).toEqual(["github", "slack", "asana", "zulip"]);
  });
});

describe("detail rows", () => {
  test("a telemetry row reads as a completed sync", () => {
    const item = telemetryToItem(
      {
        startedAt: NOW - 60_000,
        durationMs: 2_500,
        itemsUpserted: 12,
        itemsDeleted: 1,
        bytesTransferred: null,
        hadMore: false,
        errorMsg: null,
      },
      NOW,
    );
    expect(item.label).toBe("1m ago · 2.5s");
    expect(item.description).toBe("+12 / -1");
    expect(item.iconId).toBe("pass");
  });

  test("a failed telemetry row shows the Gateway's message verbatim", () => {
    const item = telemetryToItem(
      {
        startedAt: NOW - 60_000,
        durationMs: 900,
        itemsUpserted: 0,
        itemsDeleted: 0,
        bytesTransferred: null,
        hadMore: false,
        errorMsg: "connect ECONNREFUSED 127.0.0.1:5432",
      },
      NOW,
    );
    expect(item.iconId).toBe("error");
    expect(item.description).toBe("connect ECONNREFUSED 127.0.0.1:5432");
  });

  test("a health transition names both states and its reason", () => {
    const item = healthEntryToItem(
      {
        id: 4,
        connectorId: "github",
        fromState: "healthy",
        toState: "backoff",
        reason: "429 rate limited",
        occurredAtMs: NOW - 3_600_000,
      },
      NOW,
    );
    expect(item.label).toBe("healthy → backoff");
    expect(item.description).toBe("1h ago · 429 rate limited");
  });

  test("a first-ever transition has no from-state to name", () => {
    const item = healthEntryToItem(
      {
        id: 1,
        connectorId: "github",
        fromState: null,
        toState: "healthy",
        reason: null,
        occurredAtMs: NOW - 3_600_000,
      },
      NOW,
    );
    expect(item.label).toBe("→ healthy");
    expect(item.description).toBe("1h ago");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bunx vitest run test/unit/connectors-rows.test.ts`
Expected: FAIL — cannot resolve `../../src/connectors/rows.js`.

- [ ] **Step 3: Implement `rows.ts`**

```ts
import type {
  ConnectorHealthHistoryEntry,
  ConnectorSyncStatus,
  ConnectorSyncTelemetry,
} from "@nimbus-dev/client";

import { formatRelativeTime } from "../sidebar/relative-time.js";
import type { SidebarItem } from "../sidebar/tree-view.js";

/**
 * The contextValues the manifest keys its menus on. A connector is exactly one
 * of these: `disabled` wins over everything (an enabled:false connector is not
 * "paused"), then `syncing`, which is what hides the sync family mid-sync.
 */
export const CONNECTOR_CONTEXT = {
  active: "nimbus.connector.active",
  paused: "nimbus.connector.paused",
  disabled: "nimbus.connector.disabled",
  syncing: "nimbus.connector.syncing",
} as const;

/** What a view/item/context command needs off the node VS Code hands it. */
export type ConnectorPayload = { serviceId: string; itemCount: number };

const STATUS_ICONS: Record<ConnectorSyncStatus["status"], string> = {
  ok: "pass",
  syncing: "sync",
  paused: "debug-pause",
  backoff: "warning",
  error: "error",
};

// Unhealthy first: this is a health surface, and a row that needs attention
// should not sit below four that do not. Ties break on id so the order is total
// and the rendering is deterministic.
const SEVERITY: Record<ConnectorSyncStatus["status"], number> = {
  error: 0,
  backoff: 1,
  paused: 2,
  syncing: 3,
  ok: 4,
};

function iconFor(s: ConnectorSyncStatus): string {
  if (!s.enabled) return "circle-slash";
  return STATUS_ICONS[s.status];
}

function contextValueFor(s: ConnectorSyncStatus): string {
  if (!s.enabled) return CONNECTOR_CONTEXT.disabled;
  if (s.status === "paused") return CONNECTOR_CONTEXT.paused;
  if (s.status === "syncing") return CONNECTOR_CONTEXT.syncing;
  return CONNECTOR_CONTEXT.active;
}

function tooltipFor(s: ConnectorSyncStatus, now: number): string {
  const lines = [
    `${s.serviceId} · ${s.enabled ? s.status : "disabled"}`,
    `Depth: ${s.depth}`,
    `Interval: ${Math.round(s.intervalMs / 1000)}s`,
  ];
  if (s.nextSyncAt !== null) lines.push(`Next sync: ${formatRelativeTime(now, s.nextSyncAt)}`);
  if (s.consecutiveFailures > 0) lines.push(`${s.consecutiveFailures} consecutive failures`);
  // Verbatim, and never logged: it is the user's own error about their own
  // connector, and the host/path detail is what makes it actionable.
  if (s.lastError !== null) lines.push(`Last error: ${s.lastError}`);
  return lines.join("\n");
}

export function connectorToItem(s: ConnectorSyncStatus, now: number): SidebarItem {
  const synced = s.lastSyncAt === null ? "never synced" : `synced ${formatRelativeTime(now, s.lastSyncAt)}`;
  return {
    label: s.serviceId,
    description: `${s.itemCount.toLocaleString("en-US")} items · ${synced}`,
    tooltip: tooltipFor(s, now),
    iconId: iconFor(s),
    contextValue: contextValueFor(s),
    // Detail is fetched on expand, so the row declares no children but must
    // still render a twistie — without one the load can never be triggered.
    children: [],
    collapsible: true,
    payload: { serviceId: s.serviceId, itemCount: s.itemCount } satisfies ConnectorPayload,
  };
}

export function connectorRows(
  statuses: readonly ConnectorSyncStatus[],
  now: number,
): SidebarItem[] {
  return statuses
    .slice()
    .sort((a, b) => SEVERITY[a.status] - SEVERITY[b.status] || a.serviceId.localeCompare(b.serviceId))
    .map((s) => connectorToItem(s, now));
}

export function connectorPayloadOf(item: SidebarItem): ConnectorPayload | undefined {
  const p = item.payload;
  if (typeof p !== "object" || p === null) return undefined;
  const { serviceId, itemCount } = p as { serviceId?: unknown; itemCount?: unknown };
  if (typeof serviceId !== "string" || typeof itemCount !== "number") return undefined;
  return { serviceId, itemCount };
}

export function telemetryToItem(t: ConnectorSyncTelemetry, now: number): SidebarItem {
  const failed = t.errorMsg !== null;
  return {
    label: `${formatRelativeTime(now, t.startedAt)} · ${(t.durationMs / 1000).toFixed(1)}s`,
    description: failed ? t.errorMsg : `+${t.itemsUpserted} / -${t.itemsDeleted}`,
    iconId: failed ? "error" : "pass",
  };
}

export function healthEntryToItem(e: ConnectorHealthHistoryEntry, now: number): SidebarItem {
  const when = formatRelativeTime(now, e.occurredAtMs);
  return {
    label: `${e.fromState ?? ""} → ${e.toState}`.trim(),
    description: e.reason === null ? when : `${when} · ${e.reason}`,
    iconId: "history",
  };
}
```

- [ ] **Step 4: Run the test**

Run: `bunx vitest run test/unit/connectors-rows.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/connectors/rows.ts test/unit/connectors-rows.test.ts
git commit -m "feat(connectors): render connector status as tree rows"
```

---

### Task 3: The outcome type

**Files:**
- Create: `src/connectors/outcome.ts`
- Test: `test/unit/connectors-outcome.test.ts`

**Interfaces:**
- Produces:
  - `type ConnectorOutcome = { kind: "applied"; detail?: string } | { kind: "denied"; reason: string } | { kind: "failed"; message: string }`
  - `fromOk(r: { ok: boolean }, detail?: string): ConnectorOutcome`
  - `fromGated<T extends { ok: true }>(r: T | GatedRejection, detail: (ok: T) => string): ConnectorOutcome`
  - `fromThrown(e: unknown): ConnectorOutcome`
  - `describeOutcome(verb: string, serviceId: string, o: ConnectorOutcome): string`

- [ ] **Step 1: Write the failing test**

Create `test/unit/connectors-outcome.test.ts`:

```ts
import { describe, expect, test } from "vitest";

import {
  type ConnectorOutcome,
  describeOutcome,
  fromGated,
  fromOk,
  fromThrown,
} from "../../src/connectors/outcome.js";

describe("the four wire shapes", () => {
  test("ok:true is applied", () => {
    expect(fromOk({ ok: true }, "sync started")).toEqual({ kind: "applied", detail: "sync started" });
  });

  test("ok:false is a failure, not a denial", () => {
    expect(fromOk({ ok: false })).toEqual({
      kind: "failed",
      message: "The Gateway did not apply the change.",
    });
  });

  test("a resolved GatedRejection is denied, carrying the Gateway's reason verbatim", () => {
    expect(fromGated({ status: "rejected", reason: "consent request expired" }, () => "")).toEqual({
      kind: "denied",
      reason: "consent request expired",
    });
  });

  test("a resolved approval is applied", () => {
    expect(
      fromGated({ ok: true, itemsDeleted: 1204, vaultKeysRemoved: ["github/pat"] }, (r) =>
        `${r.itemsDeleted} items deleted`,
      ),
    ).toEqual({ kind: "applied", detail: "1204 items deleted" });
  });

  test("a thrown denial is denied — reindex rejects where the others resolve", () => {
    expect(fromThrown(new Error("HITL denied: owner rejected the request"))).toEqual({
      kind: "denied",
      reason: "HITL denied: owner rejected the request",
    });
  });

  test("a thrown transport error is a failure", () => {
    expect(fromThrown(new Error("socket hang up"))).toEqual({
      kind: "failed",
      message: "socket hang up",
    });
  });

  test("a non-Error rejection still yields a message", () => {
    expect(fromThrown("boom")).toEqual({ kind: "failed", message: "boom" });
  });
});

describe("describeOutcome", () => {
  test("a denial reads as a decision, never as a breakage", () => {
    const denied: ConnectorOutcome = { kind: "denied", reason: "consent request expired" };
    const text = describeOutcome("Removing", "github", denied);
    expect(text).toBe("Removing github was not approved: consent request expired");
    expect(text.toLowerCase()).not.toContain("failed");
    expect(text.toLowerCase()).not.toContain("error");
  });

  test("an applied outcome names what changed", () => {
    expect(describeOutcome("Removing", "github", { kind: "applied", detail: "1204 items deleted" })).toBe(
      "Removing github: done — 1204 items deleted",
    );
  });

  test("an applied outcome with no detail still reads cleanly", () => {
    expect(describeOutcome("Pausing", "github", { kind: "applied" })).toBe("Pausing github: done");
  });

  test("a failure says so", () => {
    expect(describeOutcome("Syncing", "github", { kind: "failed", message: "socket hang up" })).toBe(
      "Syncing github failed: socket hang up",
    );
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bunx vitest run test/unit/connectors-outcome.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `outcome.ts`**

```ts
import type { GatedRejection } from "@nimbus-dev/client";

import { errMsg } from "../logging.js";

/**
 * One outcome for twelve RPCs that report failure four different ways:
 * `{ok:false}` resolves, a consent denial RESOLVES as GatedRejection for
 * addMcp/remove but REJECTS for a full reindex, and a real error rejects.
 * `denied` is a decision, not a breakage — the distinction the wording relies on.
 */
export type ConnectorOutcome =
  | { kind: "applied"; detail?: string }
  | { kind: "denied"; reason: string }
  | { kind: "failed"; message: string };

// Whether a REJECTED promise is a consent denial rather than a fault. Only the
// full-depth reindex path can produce one, and the client gives us no code to
// key on, so this is a heuristic over the message — deliberately narrow, and
// biased to "failed": mislabelling a genuine error as a denial would tell the
// user a decision was made that nobody made.
const DENIAL = /\b(denied|rejected|not approved|consent (?:expired|timed out))\b/i;

export function fromOk(r: { ok: boolean }, detail?: string): ConnectorOutcome {
  if (!r.ok) return { kind: "failed", message: "The Gateway did not apply the change." };
  return detail === undefined ? { kind: "applied" } : { kind: "applied", detail };
}

export function fromGated<T extends { ok: true }>(
  r: T | GatedRejection,
  detail: (ok: T) => string,
): ConnectorOutcome {
  // Narrow on "status" exactly as the client's JSDoc instructs.
  if ("status" in r) return { kind: "denied", reason: r.reason };
  const text = detail(r);
  return text === "" ? { kind: "applied" } : { kind: "applied", detail: text };
}

export function fromThrown(e: unknown): ConnectorOutcome {
  const message = errMsg(e);
  return DENIAL.test(message) ? { kind: "denied", reason: message } : { kind: "failed", message };
}

/** `verb` is the gerund of the action: "Removing", "Pausing", "Syncing". */
export function describeOutcome(verb: string, serviceId: string, o: ConnectorOutcome): string {
  switch (o.kind) {
    case "applied":
      return o.detail === undefined
        ? `${verb} ${serviceId}: done`
        : `${verb} ${serviceId}: done — ${o.detail}`;
    case "denied":
      return `${verb} ${serviceId} was not approved: ${o.reason}`;
    case "failed":
      return `${verb} ${serviceId} failed: ${o.message}`;
  }
}
```

- [ ] **Step 4: Run the test**

Run: `bunx vitest run test/unit/connectors-outcome.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/connectors/outcome.ts test/unit/connectors-outcome.test.ts
git commit -m "feat(connectors): normalise four wire shapes into one outcome"
```

---

### Task 4: Interval parsing

**Files:**
- Create: `src/connectors/interval.ts`
- Test: `test/unit/connectors-interval.test.ts`

**Interfaces:**
- Produces: `MIN_INTERVAL_MS = 60_000`, `parseInterval(input: string): { ms: number } | { error: string }`, `formatInterval(ms: number): string`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/connectors-interval.test.ts`:

```ts
import { describe, expect, test } from "vitest";

import { formatInterval, MIN_INTERVAL_MS, parseInterval } from "../../src/connectors/interval.js";

describe("parseInterval", () => {
  test("accepts minutes, hours and days", () => {
    expect(parseInterval("15m")).toEqual({ ms: 900_000 });
    expect(parseInterval("2h")).toEqual({ ms: 7_200_000 });
    expect(parseInterval("1d")).toEqual({ ms: 86_400_000 });
  });

  test("accepts seconds at or above the floor, and surrounding whitespace", () => {
    expect(parseInterval(" 90s ")).toEqual({ ms: 90_000 });
  });

  test("rejects anything under the Gateway's minimum before the round trip", () => {
    expect(parseInterval("30s")).toEqual({
      error: "The Gateway enforces a minimum of 60s.",
    });
  });

  test("rejects unparseable input", () => {
    expect(parseInterval("soon")).toEqual({ error: "Use a duration like 15m, 2h or 1d." });
    expect(parseInterval("")).toEqual({ error: "Use a duration like 15m, 2h or 1d." });
    expect(parseInterval("0m")).toEqual({ error: "The Gateway enforces a minimum of 60s." });
  });
});

describe("formatInterval", () => {
  test("round-trips the units it prints", () => {
    expect(formatInterval(900_000)).toBe("15m");
    expect(formatInterval(7_200_000)).toBe("2h");
    expect(formatInterval(86_400_000)).toBe("1d");
    expect(formatInterval(90_000)).toBe("90s");
  });
});

test("the floor matches what the client documents", () => {
  expect(MIN_INTERVAL_MS).toBe(60_000);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bunx vitest run test/unit/connectors-interval.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `interval.ts`**

```ts
/** `MIN_SYNC_INTERVAL_MS` as documented on ConnectorSetConfigParams. */
export const MIN_INTERVAL_MS = 60_000;

const UNITS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };
const PATTERN = /^(\d+)\s*([smhd])$/i;

// Validating the floor here rather than letting the Gateway reject it keeps the
// feedback in the input box, where the user still has the value in hand.
export function parseInterval(input: string): { ms: number } | { error: string } {
  const match = PATTERN.exec(input.trim());
  if (match === null) return { error: "Use a duration like 15m, 2h or 1d." };
  const [, digits, unit] = match;
  const ms = Number(digits) * (UNITS[unit.toLowerCase()] ?? 0);
  if (ms < MIN_INTERVAL_MS) return { error: "The Gateway enforces a minimum of 60s." };
  return { ms };
}

export function formatInterval(ms: number): string {
  if (ms % UNITS.d === 0) return `${ms / UNITS.d}d`;
  if (ms % UNITS.h === 0) return `${ms / UNITS.h}h`;
  if (ms % UNITS.m === 0) return `${ms / UNITS.m}m`;
  return `${Math.round(ms / UNITS.s)}s`;
}
```

- [ ] **Step 4: Run the test**

Run: `bunx vitest run test/unit/connectors-interval.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/connectors/interval.ts test/unit/connectors-interval.test.ts
git commit -m "feat(connectors): parse human sync intervals against the Gateway floor"
```

---

### Task 5: The auth catalog

**Files:**
- Create: `src/connectors/catalog.ts`
- Test: `test/unit/connectors-catalog.test.ts`

**Interfaces:**
- Produces:
  - `type AuthField = { name: string; label: string; secret: boolean; required: boolean; placeholder?: string }`
  - `authFieldsFor(serviceId: string): readonly AuthField[]` — `[]` means "call with `serviceId` alone" (OAuth).
  - `isKnownProvider(serviceId: string): boolean`
  - `GENERIC_FIELD: AuthField`

**Sourcing rule (do not violate):** every field name here must appear in the
pinned client's JSDoc for `ConnectorAuthParams`. Do not invent names, and do not
read the Gateway source — the non-negotiable forbids it.

- [ ] **Step 1: Write the failing test**

Create `test/unit/connectors-catalog.test.ts`:

```ts
import { describe, expect, test } from "vitest";

import { authFieldsFor, GENERIC_FIELD, isKnownProvider } from "../../src/connectors/catalog.js";

describe("authFieldsFor", () => {
  test("a PAT provider asks for one masked token", () => {
    const fields = authFieldsFor("github");
    expect(fields).toHaveLength(1);
    expect(fields[0]).toMatchObject({ name: "personalAccessToken", secret: true, required: true });
  });

  test("Jira asks for its three fields, in order, and masks only the token", () => {
    expect(authFieldsFor("jira").map((f) => [f.name, f.secret])).toEqual([
      ["atlassianEmail", false],
      ["apiBaseUrl", false],
      ["token", true],
    ]);
  });

  test("AWS masks the secret key and not the id", () => {
    expect(authFieldsFor("aws").map((f) => [f.name, f.secret])).toEqual([
      ["awsAccessKeyId", false],
      ["awsSecretAccessKey", true],
    ]);
  });

  test("an OAuth provider needs no fields — the Gateway drives the browser", () => {
    expect(authFieldsFor("google_drive")).toEqual([]);
    expect(isKnownProvider("google_drive")).toBe(true);
  });

  test("an unknown provider is not known, and gets the generic descriptor", () => {
    expect(isKnownProvider("mcp_acme")).toBe(false);
    expect(authFieldsFor("mcp_acme")).toEqual([GENERIC_FIELD]);
    expect(GENERIC_FIELD.secret).toBe(true);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bunx vitest run test/unit/connectors-catalog.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `catalog.ts`**

```ts
/** One credential field to prompt for. `secret` fields use a masked input box. */
export type AuthField = {
  name: string;
  label: string;
  secret: boolean;
  required: boolean;
  placeholder?: string;
};

const PAT = (label: string, name = "personalAccessToken"): AuthField => ({
  name,
  label,
  secret: true,
  required: true,
});

/**
 * Every field name below is taken from the pinned client's JSDoc for
 * ConnectorAuthParams. The Gateway owns the real list and can out-run this one;
 * an unknown serviceId falls back to GENERIC_FIELD rather than failing, and a
 * rejected call reports the Gateway's own message, which names the field it
 * wanted. See docs/connectors.md.
 *
 * An empty array means "call with serviceId alone" — the OAuth (PKCE) shape,
 * where the Gateway opens a browser and listens on a local port.
 */
const AUTH_CATALOG: Record<string, readonly AuthField[]> = {
  github: [PAT("GitHub personal access token")],
  gitlab: [PAT("GitLab personal access token")],
  bitbucket: [PAT("Bitbucket app password")],
  jira: [
    { name: "atlassianEmail", label: "Atlassian account email", secret: false, required: true },
    {
      name: "apiBaseUrl",
      label: "Atlassian site URL",
      secret: false,
      required: true,
      placeholder: "https://your-team.atlassian.net",
    },
    { name: "token", label: "Atlassian API token", secret: true, required: true },
  ],
  confluence: [
    { name: "atlassianEmail", label: "Atlassian account email", secret: false, required: true },
    {
      name: "apiBaseUrl",
      label: "Atlassian site URL",
      secret: false,
      required: true,
      placeholder: "https://your-team.atlassian.net",
    },
    { name: "token", label: "Atlassian API token", secret: true, required: true },
  ],
  aws: [
    { name: "awsAccessKeyId", label: "AWS access key id", secret: false, required: true },
    { name: "awsSecretAccessKey", label: "AWS secret access key", secret: true, required: true },
  ],
  azure: [
    { name: "azureTenantId", label: "Azure tenant id", secret: false, required: true },
    { name: "token", label: "Azure access token", secret: true, required: true },
  ],
  gcp: [
    {
      name: "gcpCredentialsJsonPath",
      label: "Path to the GCP credentials JSON",
      secret: false,
      required: true,
    },
  ],
  google_drive: [],
  slack: [PAT("Slack token", "token")],
};

/** What an unrecognised connector is asked for. Masked: assume it is a secret. */
export const GENERIC_FIELD: AuthField = {
  name: "token",
  label: "Credential",
  secret: true,
  required: true,
};

export function isKnownProvider(serviceId: string): boolean {
  return serviceId in AUTH_CATALOG;
}

export function authFieldsFor(serviceId: string): readonly AuthField[] {
  return AUTH_CATALOG[serviceId] ?? [GENERIC_FIELD];
}
```

- [ ] **Step 4: Run the test**

Run: `bunx vitest run test/unit/connectors-catalog.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/connectors/catalog.ts test/unit/connectors-catalog.test.ts
git commit -m "feat(connectors): catalog the credential fields, with a generic fallback"
```

---

### Task 6: The adapter

**Files:**
- Create: `src/connectors/connector-client.ts`
- Test: `test/unit/connectors-client.test.ts`

**Interfaces:**
- Consumes: `ConnectorOutcome`, `fromOk`, `fromGated`, `fromThrown` (Task 3).
- Produces:
  - `interface ConnectorClientLike` — the eleven methods this surface calls.
  - `createConnectorOps(getClient: () => ConnectorClientLike | undefined): ConnectorOps`
  - `interface ConnectorOps` with: `list()`, `detail(serviceId)`, `history(serviceId)`,
    `pause/resume/sync/fullSync/setConfig/reindex/auth/addMcp/remove` — every
    mutation returning `Promise<ConnectorOutcome>`; `list`/`detail`/`history`
    reject on error so the view can render `errorRow`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/connectors-client.test.ts`:

```ts
import type { ConnectorSyncStatus } from "@nimbus-dev/client";
import { describe, expect, test, vi } from "vitest";

import {
  type ConnectorClientLike,
  createConnectorOps,
} from "../../src/connectors/connector-client.js";

function stub(over: Partial<ConnectorClientLike> = {}): ConnectorClientLike {
  return {
    connectorListStatus: vi.fn(async () => [] as ConnectorSyncStatus[]),
    connectorStatus: vi.fn(async () => ({}) as never),
    connectorHealthHistory: vi.fn(async () => []),
    connectorPause: vi.fn(async () => ({ ok: true })),
    connectorResume: vi.fn(async () => ({ ok: true })),
    connectorSetConfig: vi.fn(async () => ({
      service: "github",
      intervalMs: 900_000,
      depth: null,
      enabled: null,
    })),
    connectorSync: vi.fn(async () => ({ ok: true })),
    connectorReindex: vi.fn(async () => ({ itemsAffected: 12, depth: "full", mode: "deepen" })),
    connectorAuth: vi.fn(async () => ({ ok: true, serviceId: "github", scopesGranted: ["repo"] })),
    connectorAddMcp: vi.fn(async () => ({ ok: true, serviceId: "mcp_acme" })),
    connectorRemove: vi.fn(async () => ({ ok: true, itemsDeleted: 3, vaultKeysRemoved: [] })),
    ...over,
  } as ConnectorClientLike;
}

describe("while disconnected", () => {
  test("a mutation fails without inventing a denial", async () => {
    const ops = createConnectorOps(() => undefined);
    expect(await ops.pause("github")).toEqual({
      kind: "failed",
      message: "Not connected to the Nimbus Gateway.",
    });
  });

  test("a read rejects, so the view renders its own error row", async () => {
    const ops = createConnectorOps(() => undefined);
    await expect(ops.list()).rejects.toThrow("Not connected to the Nimbus Gateway.");
  });
});

describe("health history", () => {
  test("an mcp_* id is skipped, not attempted — the Gateway rejects those", async () => {
    const client = stub();
    const ops = createConnectorOps(() => client);
    expect(await ops.history("mcp_acme")).toEqual([]);
    expect(client.connectorHealthHistory).not.toHaveBeenCalled();
  });

  test("a built-in id is fetched", async () => {
    const client = stub();
    const ops = createConnectorOps(() => client);
    await ops.history("github");
    expect(client.connectorHealthHistory).toHaveBeenCalledWith({ service: "github", limit: 15 });
  });
});

describe("mutations", () => {
  test("a full sync clears the cursor", async () => {
    const client = stub();
    const ops = createConnectorOps(() => client);
    expect(await ops.fullSync("github")).toEqual({ kind: "applied", detail: "full re-sync started" });
    expect(client.connectorSync).toHaveBeenCalledWith({ serviceId: "github", full: true });
  });

  test("setConfig reports only what it asked to change, not the nulls", async () => {
    const ops = createConnectorOps(() => stub());
    expect(await ops.setConfig({ serviceId: "github", intervalMs: 900_000 })).toEqual({
      kind: "applied",
      detail: "interval 15m",
    });
  });

  test("a resolved rejection from remove is a denial carrying the Gateway's reason", async () => {
    const client = stub({
      connectorRemove: vi.fn(async () => ({ status: "rejected", reason: "owner said no" })),
    });
    const ops = createConnectorOps(() => client);
    expect(await ops.remove("github")).toEqual({ kind: "denied", reason: "owner said no" });
  });

  test("an approved remove reports what it deleted", async () => {
    const ops = createConnectorOps(() => stub());
    expect(await ops.remove("github")).toEqual({ kind: "applied", detail: "3 items deleted" });
  });

  test("a full reindex REJECTS on denial, and is still reported as denied", async () => {
    const client = stub({
      connectorReindex: vi.fn(async () => {
        throw new Error("consent denied by owner");
      }),
    });
    const ops = createConnectorOps(() => client);
    expect(await ops.reindex("github", "full")).toEqual({
      kind: "denied",
      reason: "consent denied by owner",
    });
  });

  test("a transport error on the same call is a failure, not a denial", async () => {
    const client = stub({
      connectorReindex: vi.fn(async () => {
        throw new Error("socket hang up");
      }),
    });
    const ops = createConnectorOps(() => client);
    expect(await ops.reindex("github", "full")).toEqual({
      kind: "failed",
      message: "socket hang up",
    });
  });

  test("auth forwards the collected fields verbatim alongside the serviceId", async () => {
    const client = stub();
    const ops = createConnectorOps(() => client);
    expect(await ops.auth("github", { personalAccessToken: "ghp_x" })).toEqual({
      kind: "applied",
      detail: "scopes: repo",
    });
    expect(client.connectorAuth).toHaveBeenCalledWith({
      serviceId: "github",
      personalAccessToken: "ghp_x",
    });
  });
});

test("the client is resolved per call, never captured", async () => {
  let current: ConnectorClientLike | undefined;
  const ops = createConnectorOps(() => current);
  expect(await ops.pause("github")).toMatchObject({ kind: "failed" });
  current = stub();
  expect(await ops.pause("github")).toEqual({ kind: "applied" });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bunx vitest run test/unit/connectors-client.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `connector-client.ts`**

```ts
import type {
  ConnectorAddMcpResult,
  ConnectorAuthResult,
  ConnectorHealthHistoryEntry,
  ConnectorReindexResult,
  ConnectorRemoveResult,
  ConnectorSetConfigParams,
  ConnectorSetConfigResult,
  ConnectorStatusResult,
  ConnectorSyncStatus,
} from "@nimbus-dev/client";

import { formatInterval } from "./interval.js";
import { type ConnectorOutcome, fromGated, fromOk, fromThrown } from "./outcome.js";

/**
 * The Gateway capability this surface needs, as a structural seam. None of
 * these RPCs takes a prompt or returns a completion — they reach no model, so
 * this surface sits outside the pre-flight gate exactly as searchRanked does.
 */
export interface ConnectorClientLike {
  connectorListStatus(params?: { serviceId?: string }): Promise<ConnectorSyncStatus[]>;
  connectorStatus(params: { serviceId: string; includeStats?: boolean }): Promise<ConnectorStatusResult>;
  connectorHealthHistory(params: { service: string; limit?: number }): Promise<ConnectorHealthHistoryEntry[]>;
  connectorPause(params: { serviceId: string }): Promise<{ ok: boolean }>;
  connectorResume(params: { serviceId: string }): Promise<{ ok: boolean }>;
  connectorSetConfig(params: ConnectorSetConfigParams): Promise<ConnectorSetConfigResult>;
  connectorSync(params: { serviceId: string; full?: boolean }): Promise<{ ok: boolean }>;
  connectorReindex(params: {
    service: string;
    depth?: "metadata_only" | "summary" | "full";
  }): Promise<ConnectorReindexResult>;
  connectorAuth(params: { serviceId: string } & Record<string, unknown>): Promise<ConnectorAuthResult>;
  connectorAddMcp(params: { serviceId: string; commandLine: string }): Promise<ConnectorAddMcpResult>;
  connectorRemove(params: { serviceId: string }): Promise<ConnectorRemoveResult>;
}

export type ReindexDepth = "metadata_only" | "summary" | "full";

export interface ConnectorOps {
  list(): Promise<ConnectorSyncStatus[]>;
  detail(serviceId: string): Promise<ConnectorStatusResult>;
  history(serviceId: string): Promise<ConnectorHealthHistoryEntry[]>;
  pause(serviceId: string): Promise<ConnectorOutcome>;
  resume(serviceId: string): Promise<ConnectorOutcome>;
  sync(serviceId: string): Promise<ConnectorOutcome>;
  fullSync(serviceId: string): Promise<ConnectorOutcome>;
  setConfig(params: ConnectorSetConfigParams): Promise<ConnectorOutcome>;
  reindex(serviceId: string, depth: ReindexDepth): Promise<ConnectorOutcome>;
  auth(serviceId: string, fields: Record<string, unknown>): Promise<ConnectorOutcome>;
  addMcp(serviceId: string, commandLine: string): Promise<ConnectorOutcome>;
  remove(serviceId: string): Promise<ConnectorOutcome>;
}

const NOT_CONNECTED = "Not connected to the Nimbus Gateway.";

/** One screenful of history; the Gateway clamps to 1..500. */
const HISTORY_LIMIT = 15;

// connectorHealthHistory takes built-in connector ids only — the client says so,
// and the Gateway rejects a user MCP id. Skipping beats surfacing an error the
// user cannot act on.
const MCP_ID = /^mcp_/;

export function createConnectorOps(
  getClient: () => ConnectorClientLike | undefined,
): ConnectorOps {
  // Resolved per call, never captured: a Gateway restart replaces the client,
  // and a captured one would be stranded (PR #103).
  const need = (): ConnectorClientLike => {
    const client = getClient();
    if (client === undefined) throw new Error(NOT_CONNECTED);
    return client;
  };

  const mutate = async (run: (c: ConnectorClientLike) => Promise<ConnectorOutcome>) => {
    try {
      return await run(need());
    } catch (e) {
      return fromThrown(e);
    }
  };

  const configDetail = (p: ConnectorSetConfigParams): string =>
    [
      p.intervalMs === undefined ? undefined : `interval ${formatInterval(p.intervalMs)}`,
      p.depth === undefined ? undefined : `depth ${p.depth}`,
      p.enabled === undefined ? undefined : p.enabled ? "enabled" : "disabled",
    ]
      .filter((s): s is string => s !== undefined)
      .join(", ");

  return {
    list: async () => await need().connectorListStatus(),
    detail: async (serviceId) => await need().connectorStatus({ serviceId, includeStats: true }),
    history: async (serviceId) =>
      MCP_ID.test(serviceId)
        ? []
        : await need().connectorHealthHistory({ service: serviceId, limit: HISTORY_LIMIT }),

    pause: (serviceId) => mutate(async (c) => fromOk(await c.connectorPause({ serviceId }))),
    resume: (serviceId) => mutate(async (c) => fromOk(await c.connectorResume({ serviceId }))),
    sync: (serviceId) =>
      mutate(async (c) => fromOk(await c.connectorSync({ serviceId }), "sync started")),
    fullSync: (serviceId) =>
      mutate(async (c) =>
        fromOk(await c.connectorSync({ serviceId, full: true }), "full re-sync started"),
      ),
    setConfig: (params) =>
      mutate(async (c) => {
        await c.connectorSetConfig(params);
        // The result reads null for anything not requested — that means "not
        // part of this call", NOT "cleared", so we report the request instead.
        return { kind: "applied", detail: configDetail(params) };
      }),
    reindex: (serviceId, depth) =>
      mutate(async (c) => {
        const r = await c.connectorReindex({ service: serviceId, depth });
        return { kind: "applied", detail: `${r.itemsAffected} items · ${r.mode}` };
      }),
    auth: (serviceId, fields) =>
      mutate(async (c) => {
        const r = await c.connectorAuth({ serviceId, ...fields });
        return { kind: "applied", detail: `scopes: ${r.scopesGranted.join(", ")}` };
      }),
    addMcp: (serviceId, commandLine) =>
      mutate(async (c) =>
        fromGated(await c.connectorAddMcp({ serviceId, commandLine }), (r) => `added ${r.serviceId}`),
      ),
    remove: (serviceId) =>
      mutate(async (c) =>
        fromGated(await c.connectorRemove({ serviceId }), (r) => `${r.itemsDeleted} items deleted`),
      ),
  };
}
```

- [ ] **Step 4: Run the test**

Run: `bunx vitest run test/unit/connectors-client.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the choke-point guard explicitly**

Run: `bunx vitest run test/unit/egress-choke-point.test.ts`
Expected: PASS, **with no edit to that file**. If it fails, a comment or symbol
in `src/connectors/` named a gated call — reword it, do not widen `ALLOWED`.

- [ ] **Step 6: Commit**

```bash
git add src/connectors/connector-client.ts test/unit/connectors-client.test.ts
git commit -m "feat(connectors): one adapter over the connector RPC suite"
```

---

### Task 7: The view

**Files:**
- Create: `src/connectors/connectors-view.ts`
- Test: `test/unit/connectors-view.test.ts`

**Interfaces:**
- Consumes: `ConnectorOps` (Task 6), `connectorRows` / `connectorPayloadOf` / `telemetryToItem` / `healthEntryToItem` (Task 2), `createDataView` / `errorRow` / `SidebarConnection` / `SidebarView`.
- Produces: `createConnectorsView(deps: { connection: SidebarConnection; ops: ConnectorOps; now?: () => number }): SidebarView`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/connectors-view.test.ts`:

```ts
import type { ConnectorSyncStatus } from "@nimbus-dev/client";
import { describe, expect, test, vi } from "vitest";

import type { ConnectorOps } from "../../src/connectors/connector-client.js";
import { createConnectorsView } from "../../src/connectors/connectors-view.js";
import type { SidebarItem } from "../../src/sidebar/tree-view.js";

const NOW = 1_000_000_000;
const connection = { current: () => ({ kind: "connected" }) as never, onState: () => ({ dispose: () => {} }) };

function status(over: Partial<ConnectorSyncStatus> = {}): ConnectorSyncStatus {
  return {
    serviceId: "github",
    status: "ok",
    lastSyncAt: NOW,
    nextSyncAt: null,
    intervalMs: 60_000,
    itemCount: 2,
    lastError: null,
    consecutiveFailures: 0,
    depth: "summary",
    enabled: true,
    ...over,
  };
}

function ops(over: Partial<ConnectorOps> = {}): ConnectorOps {
  return {
    list: vi.fn(async () => [status()]),
    detail: vi.fn(async () => ({ ...status(), telemetry: [] })),
    history: vi.fn(async () => []),
    // Spread LAST: a helper that drops its override makes every test that
    // passes one assert nothing at all.
    ...over,
  } as unknown as ConnectorOps;
}

describe("the connectors view", () => {
  test("renders a row per connector", async () => {
    const view = createConnectorsView({ connection, ops: ops(), now: () => NOW });
    const rows = await view.getChildren();
    expect(rows.map((r) => r.label)).toEqual(["github"]);
  });

  test("an empty Gateway offers the one source the extension can register", async () => {
    const view = createConnectorsView({
      connection,
      ops: ops({ list: vi.fn(async () => []) }),
      now: () => NOW,
    });
    const rows = await view.getChildren();
    expect(rows[0]?.label).toBe("No connectors registered");
    expect(rows[1]?.command?.command).toBe("nimbus.addMcpConnector");
  });

  test("a failed load renders one error row rather than throwing", async () => {
    const view = createConnectorsView({
      connection,
      ops: ops({
        list: vi.fn(async () => {
          throw new Error("Method not found");
        }),
      }),
      now: () => NOW,
    });
    const rows = await view.getChildren();
    expect(rows[0]?.iconId).toBe("error");
    expect(rows[0]?.tooltip).toContain("Method not found");
  });

  test("expanding fetches telemetry and history under group rows", async () => {
    const o = ops({
      detail: vi.fn(async () => ({
        ...status(),
        telemetry: [
          {
            startedAt: NOW - 1000,
            durationMs: 500,
            itemsUpserted: 1,
            itemsDeleted: 0,
            bytesTransferred: null,
            hadMore: false,
            errorMsg: null,
          },
        ],
      })),
      history: vi.fn(async () => [
        { id: 1, connectorId: "github", fromState: null, toState: "healthy", reason: null, occurredAtMs: NOW },
      ]),
    });
    const view = createConnectorsView({ connection, ops: o, now: () => NOW });
    const [row] = await view.getChildren();
    const children = await view.getChildren(row);
    expect(children.map((c) => c.label)).toEqual(["Recent syncs", "Health history"]);
    expect(children[0]?.children).toHaveLength(1);
    expect(children[1]?.children).toHaveLength(1);
  });

  test("a connector with no history at all shows only the syncs group", async () => {
    const view = createConnectorsView({ connection, ops: ops(), now: () => NOW });
    const [row] = await view.getChildren();
    const children = await view.getChildren(row);
    expect(children.map((c) => c.label)).toEqual(["Recent syncs"]);
    expect(children[0]?.children?.[0]?.label).toBe("Never synced");
  });

  test("one connector's unreadable detail does not blank the view", async () => {
    const view = createConnectorsView({
      connection,
      ops: ops({
        detail: vi.fn(async () => {
          throw new Error("nope");
        }),
      }),
      now: () => NOW,
    });
    const [row] = await view.getChildren();
    const children = await view.getChildren(row);
    expect(children[0]?.iconId).toBe("error");
  });

  test("a row we did not build has nothing to expand", async () => {
    const view = createConnectorsView({ connection, ops: ops(), now: () => NOW });
    const foreign: SidebarItem = { label: "No connectors registered" };
    expect(await view.getChildren(foreign)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bunx vitest run test/unit/connectors-view.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `connectors-view.ts`**

```ts
import {
  createDataView,
  errorRow,
  type SidebarConnection,
  type SidebarItem,
  type SidebarView,
} from "../sidebar/tree-view.js";
import type { ConnectorOps } from "./connector-client.js";
import {
  connectorPayloadOf,
  connectorRows,
  healthEntryToItem,
  telemetryToItem,
} from "./rows.js";

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
```

- [ ] **Step 4: Run the test**

Run: `bunx vitest run test/unit/connectors-view.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/connectors/connectors-view.ts test/unit/connectors-view.test.ts
git commit -m "feat(connectors): a Connectors view with detail on expand"
```

---

### Task 8: The commands

**Files:**
- Create: `src/connectors/commands.ts`
- Modify: `src/vscode-shim.ts` (widen `showInputBox`)
- Test: `test/unit/connectors-commands.test.ts`

**Interfaces:**
- Consumes: `ConnectorOps` (Task 6), `authFieldsFor` / `GENERIC_FIELD` (Task 5), `parseInterval` (Task 4), `describeOutcome` (Task 3), `connectorPayloadOf` (Task 2).
- Produces: `createConnectorCommands(deps: ConnectorCommandDeps): Record<string, (node?: unknown) => Promise<void>>`
  keyed by command id — `nimbus.syncConnector`, `nimbus.fullResyncConnector`,
  `nimbus.pauseConnector`, `nimbus.resumeConnector`, `nimbus.configureConnector`,
  `nimbus.reindexConnector`, `nimbus.authenticateConnector`,
  `nimbus.addMcpConnector`, `nimbus.removeConnector`.
- `ConnectorCommandDeps = { window: WindowApi; ops: ConnectorOps; refresh: () => void; log: Logger }`

- [ ] **Step 1: Widen the shim's `showInputBox`**

In `src/vscode-shim.ts`, extend the existing declaration — the real
`vscode.window.showInputBox` already accepts both options; the shim simply did
not declare them, so a masked prompt is currently inexpressible:

```ts
  showInputBox(opts?: {
    prompt?: string;
    value?: string;
    placeHolder?: string;
    /** Masks the input. Set for every credential field; never logged. */
    password?: boolean;
    /** Keeps a half-entered credential alive when focus wanders. */
    ignoreFocusOut?: boolean;
    validateInput?: (value: string) => string | undefined;
  }): Thenable<string | undefined>;
```

- [ ] **Step 2: Write the failing test**

Create `test/unit/connectors-commands.test.ts`:

```ts
import { describe, expect, test, vi } from "vitest";

import { createConnectorCommands } from "../../src/connectors/commands.js";
import type { ConnectorOps } from "../../src/connectors/connector-client.js";
import { CONNECTOR_CONTEXT } from "../../src/connectors/rows.js";

const SENTINEL = "ghp_SUPER_SECRET_VALUE";

function node(serviceId = "github", itemCount = 1204) {
  return { label: serviceId, contextValue: CONNECTOR_CONTEXT.active, payload: { serviceId, itemCount } };
}

function harness(over: { ops?: Partial<ConnectorOps>; window?: Record<string, unknown> } = {}) {
  const logged: string[] = [];
  const ops = {
    list: vi.fn(async () => [
      {
        serviceId: "github",
        status: "ok",
        lastSyncAt: null,
        nextSyncAt: null,
        intervalMs: 60_000,
        itemCount: 1204,
        lastError: null,
        consecutiveFailures: 0,
        depth: "summary",
        enabled: true,
      },
    ]),
    pause: vi.fn(async () => ({ kind: "applied" }) as const),
    sync: vi.fn(async () => ({ kind: "applied", detail: "sync started" }) as const),
    fullSync: vi.fn(async () => ({ kind: "applied" }) as const),
    setConfig: vi.fn(async () => ({ kind: "applied", detail: "interval 15m" }) as const),
    reindex: vi.fn(async () => ({ kind: "applied" }) as const),
    auth: vi.fn(async () => ({ kind: "applied", detail: "scopes: repo" }) as const),
    remove: vi.fn(async () => ({ kind: "applied", detail: "1204 items deleted" }) as const),
    addMcp: vi.fn(async () => ({ kind: "applied" }) as const),
    ...over.ops,
  } as unknown as ConnectorOps;
  const window = {
    showInformationMessage: vi.fn(async () => undefined),
    showWarningMessage: vi.fn(async () => "Remove"),
    showErrorMessage: vi.fn(async () => undefined),
    showInputBox: vi.fn(async () => SENTINEL),
    showQuickPick: vi.fn(async () => undefined),
    withProgress: vi.fn(async (_o: unknown, task: (p: unknown, t: unknown) => Promise<unknown>) =>
      task({ report: () => {} }, { onCancellationRequested: () => ({ dispose: () => {} }) }),
    ),
    ...over.window,
  };
  const refresh = vi.fn();
  const log = {
    info: (m: string) => logged.push(m),
    warn: (m: string) => logged.push(m),
    error: (m: string) => logged.push(m),
    debug: (m: string) => logged.push(m),
  };
  const commands = createConnectorCommands({
    window: window as never,
    ops,
    refresh,
    log: log as never,
  });
  return { commands, ops, window, refresh, logged };
}

describe("remove", () => {
  test("confirms modally, naming the item count, before calling", async () => {
    const h = harness();
    await h.commands["nimbus.removeConnector"](node());
    const [message, options] = h.window.showWarningMessage.mock.calls[0];
    expect(message).toContain("1,204 indexed items");
    expect(options).toMatchObject({ modal: true });
    expect(h.ops.remove).toHaveBeenCalledWith("github");
  });

  test("a declined confirmation calls nothing", async () => {
    const h = harness({ window: { showWarningMessage: vi.fn(async () => undefined) } });
    await h.commands["nimbus.removeConnector"](node());
    expect(h.ops.remove).not.toHaveBeenCalled();
  });

  test("the consent wait is non-cancellable, and gets the reporter first", async () => {
    const h = harness();
    await h.commands["nimbus.removeConnector"](node());
    const [options, task] = h.window.withProgress.mock.calls[0];
    expect(options).toMatchObject({ cancellable: false });
    expect(typeof task).toBe("function");
  });

  test("a denial is reported as a decision, not as an error", async () => {
    const h = harness({
      ops: { remove: vi.fn(async () => ({ kind: "denied", reason: "consent expired" }) as const) },
    });
    await h.commands["nimbus.removeConnector"](node());
    expect(h.window.showErrorMessage).not.toHaveBeenCalled();
    expect(h.window.showInformationMessage.mock.calls[0][0]).toBe(
      "Removing github was not approved: consent expired",
    );
  });
});

describe("credentials", () => {
  test("a secret field is masked and survives focus loss", async () => {
    const h = harness();
    await h.commands["nimbus.authenticateConnector"](node());
    expect(h.window.showInputBox.mock.calls[0][0]).toMatchObject({
      password: true,
      ignoreFocusOut: true,
    });
  });

  test("no credential value ever reaches the log", async () => {
    const h = harness();
    await h.commands["nimbus.authenticateConnector"](node());
    expect(h.ops.auth).toHaveBeenCalledWith("github", { personalAccessToken: SENTINEL });
    expect(h.logged.join("\n")).not.toContain(SENTINEL);
  });

  test("cancelling any prompt sends nothing", async () => {
    const h = harness({ window: { showInputBox: vi.fn(async () => undefined) } });
    await h.commands["nimbus.authenticateConnector"](node());
    expect(h.ops.auth).not.toHaveBeenCalled();
  });

  test("a blank required field is rejected in the box, before any call", async () => {
    const h = harness();
    await h.commands["nimbus.authenticateConnector"](node());
    const validate = h.window.showInputBox.mock.calls[0][0].validateInput as (v: string) => string | undefined;
    expect(validate("   ")).toBe("This field is required.");
    expect(validate("ghp_x")).toBeUndefined();
  });
});

describe("interval", () => {
  test("an interval under the floor never reaches the Gateway", async () => {
    const h = harness({
      window: {
        showQuickPick: vi.fn(async () => ({ label: "Sync interval" })),
        showInputBox: vi.fn(async () => "30s"),
      },
    });
    await h.commands["nimbus.configureConnector"](node());
    const validate = h.window.showInputBox.mock.calls[0][0].validateInput as (v: string) => string | undefined;
    expect(validate("30s")).toBe("The Gateway enforces a minimum of 60s.");
  });
});

describe("concurrency", () => {
  test("a second invocation while the first is in flight issues no RPC", async () => {
    let release = (): void => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const h = harness({
      ops: {
        sync: vi.fn(async () => {
          await gate;
          return { kind: "applied" } as const;
        }),
      },
    });
    const first = h.commands["nimbus.syncConnector"](node());
    await h.commands["nimbus.syncConnector"](node());
    expect(h.ops.sync).toHaveBeenCalledTimes(1);
    release();
    await first;
    // and the key is released, so the next click works
    await h.commands["nimbus.syncConnector"](node());
    expect(h.ops.sync).toHaveBeenCalledTimes(2);
  });

  test("the in-flight key is released even when the op throws", async () => {
    const h = harness({
      ops: {
        sync: vi.fn(async () => {
          throw new Error("boom");
        }),
      },
    });
    await h.commands["nimbus.syncConnector"](node());
    await h.commands["nimbus.syncConnector"](node());
    expect(h.ops.sync).toHaveBeenCalledTimes(2);
  });
});

describe("invoked without a row", () => {
  test("the palette path picks a connector rather than doing nothing", async () => {
    const h = harness({
      window: { showQuickPick: vi.fn(async () => ({ serviceId: "github", itemCount: 1204 })) },
    });
    await h.commands["nimbus.pauseConnector"](undefined);
    expect(h.window.showQuickPick).toHaveBeenCalled();
    expect(h.ops.pause).toHaveBeenCalledWith("github");
  });

  test("a dismissed picker calls nothing", async () => {
    const h = harness({ window: { showQuickPick: vi.fn(async () => undefined) } });
    await h.commands["nimbus.pauseConnector"](undefined);
    expect(h.ops.pause).not.toHaveBeenCalled();
  });

  test("with no connectors at all it says so instead of opening an empty picker", async () => {
    const h = harness({ ops: { list: vi.fn(async () => []) } });
    await h.commands["nimbus.pauseConnector"](undefined);
    expect(h.window.showQuickPick).not.toHaveBeenCalled();
    expect(h.window.showInformationMessage.mock.calls[0][0]).toContain("no connectors registered");
  });

  test("an unlistable Gateway reports the error rather than a silent no-op", async () => {
    const h = harness({
      ops: {
        list: vi.fn(async () => {
          throw new Error("Method not found");
        }),
      },
    });
    await h.commands["nimbus.pauseConnector"](undefined);
    expect(h.window.showErrorMessage.mock.calls[0][0]).toContain("Method not found");
    expect(h.ops.pause).not.toHaveBeenCalled();
  });

  test("a non-object argument falls through to the picker without throwing", async () => {
    const h = harness({
      window: { showQuickPick: vi.fn(async () => ({ serviceId: "github", itemCount: 1204 })) },
    });
    await h.commands["nimbus.pauseConnector"]("not-a-node");
    expect(h.ops.pause).toHaveBeenCalledWith("github");
  });
});

test("every applied mutation refreshes the view", async () => {
  const h = harness();
  await h.commands["nimbus.pauseConnector"](node());
  expect(h.refresh).toHaveBeenCalled();
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `bunx vitest run test/unit/connectors-commands.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `commands.ts`**

```ts
import { errMsg, type Logger } from "../logging.js";
import type { WindowApi } from "../vscode-shim.js";
import { PROGRESS_LOCATION_NOTIFICATION } from "../vscode-shim.js";
import { type AuthField, authFieldsFor } from "./catalog.js";
import type { ConnectorOps, ReindexDepth } from "./connector-client.js";
import { parseInterval } from "./interval.js";
import { type ConnectorOutcome, describeOutcome } from "./outcome.js";
import { connectorPayloadOf } from "./rows.js";

export interface ConnectorCommandDeps {
  window: WindowApi;
  ops: ConnectorOps;
  refresh: () => void;
  log: Logger;
}

type Target = { serviceId: string; itemCount: number };

export function createConnectorCommands(
  deps: ConnectorCommandDeps,
): Record<string, (node?: unknown) => Promise<void>> {
  // Guards a double-click, or a click on a menu built from a stale row. Keyed
  // per connector AND per command, so pausing one while another syncs is fine.
  const inFlight = new Set<string>();

  /**
   * The row VS Code passed, or — when there is none — a picker over the
   * registered connectors. These commands are palette-visible, so `node` is
   * undefined whenever one is run from the palette, a keybinding, or another
   * extension's executeCommand. Returning silently there would look broken;
   * this mirrors what the workflow commands already do with a missing target.
   */
  const resolveTarget = async (node?: unknown): Promise<Target | undefined> => {
    if (typeof node === "object" && node !== null) {
      const payload = connectorPayloadOf(node as { label: string; payload?: unknown });
      if (payload !== undefined) return payload;
    }
    let statuses;
    try {
      statuses = await deps.ops.list();
    } catch (e) {
      void deps.window.showErrorMessage(`Nimbus: could not list connectors: ${errMsg(e)}`);
      return undefined;
    }
    if (statuses.length === 0) {
      // An empty picker looks broken; say what is actually true.
      void deps.window.showInformationMessage(
        "Nimbus: no connectors registered. Register one with the Nimbus CLI, or add an MCP connector.",
      );
      return undefined;
    }
    const chosen = await deps.window.showQuickPick(
      statuses.map((s) => ({
        label: s.serviceId,
        description: `${s.enabled ? s.status : "disabled"} · ${s.itemCount.toLocaleString("en-US")} items`,
        serviceId: s.serviceId,
        itemCount: s.itemCount,
      })),
      { placeHolder: "Pick a connector", matchOnDescription: true },
    );
    if (chosen === undefined) return undefined;
    return { serviceId: chosen.serviceId, itemCount: chosen.itemCount };
  };

  const report = (verb: string, serviceId: string, outcome: ConnectorOutcome): void => {
    const text = describeOutcome(verb, serviceId, outcome);
    // A denial is a decision, so it is information, not an error dialog.
    if (outcome.kind === "failed") void deps.window.showErrorMessage(text);
    else void deps.window.showInformationMessage(text);
    deps.refresh();
  };

  const run = async (
    key: string,
    verb: string,
    serviceId: string,
    op: () => Promise<ConnectorOutcome>,
  ): Promise<void> => {
    const guard = `${serviceId}:${key}`;
    if (inFlight.has(guard)) return;
    inFlight.add(guard);
    try {
      report(verb, serviceId, await op());
    } catch (e) {
      // ConnectorOps normalises its own failures, so this is unreachable in
      // production — but a command handler that can reject is worse than a
      // branch that never fires.
      void deps.window.showErrorMessage(`${verb} ${serviceId} failed: ${errMsg(e)}`);
    } finally {
      // Released on every path: a guard that leaked on failure would wedge the
      // command until the window reloaded.
      inFlight.delete(guard);
    }
  };

  // The two HITL-gated calls block until the owner answers. The Gateway bounds
  // that wait and reports an expiry through the same denial shape, so we add no
  // timer of our own — and offer no Cancel, because there is nothing to cancel.
  const awaitingConsent = async <T>(title: string, task: () => Promise<T>): Promise<T> =>
    await deps.window.withProgress(
      { location: PROGRESS_LOCATION_NOTIFICATION, title, cancellable: false },
      // Reporter FIRST — the argument order that broke every workflow run once.
      async (_progress, _token) => await task(),
    );

  const promptField = async (field: AuthField): Promise<string | undefined> =>
    await deps.window.showInputBox({
      prompt: field.label,
      password: field.secret,
      ignoreFocusOut: true,
      ...(field.placeholder === undefined ? {} : { placeHolder: field.placeholder }),
      validateInput: (value) =>
        field.required && value.trim() === "" ? "This field is required." : undefined,
    });

  return {
    "nimbus.syncConnector": async (node) => {
      const t = await resolveTarget(node);
      if (t === undefined) return;
      await run("sync", "Syncing", t.serviceId, () => deps.ops.sync(t.serviceId));
    },

    "nimbus.fullResyncConnector": async (node) => {
      const t = await resolveTarget(node);
      if (t === undefined) return;
      const answer = await deps.window.showWarningMessage(
        `Full re-sync of ${t.serviceId}? This clears its sync cursor and re-reads everything from the source.`,
        { modal: true },
        "Full re-sync",
      );
      if (answer !== "Full re-sync") return;
      await run("full-resync", "Re-syncing", t.serviceId, () => deps.ops.fullSync(t.serviceId));
    },

    "nimbus.pauseConnector": async (node) => {
      const t = await resolveTarget(node);
      if (t === undefined) return;
      await run("pause", "Pausing", t.serviceId, () => deps.ops.pause(t.serviceId));
    },

    "nimbus.resumeConnector": async (node) => {
      const t = await resolveTarget(node);
      if (t === undefined) return;
      await run("resume", "Resuming", t.serviceId, () => deps.ops.resume(t.serviceId));
    },

    "nimbus.configureConnector": async (node) => {
      const t = await resolveTarget(node);
      if (t === undefined) return;
      const choice = await deps.window.showQuickPick(
        [
          { label: "Sync interval" },
          { label: "Index depth" },
          { label: "Enable" },
          { label: "Disable" },
        ],
        { placeHolder: `Configure ${t.serviceId}` },
      );
      if (choice === undefined) return;
      if (choice.label === "Sync interval") {
        const raw = await deps.window.showInputBox({
          prompt: `Sync interval for ${t.serviceId}`,
          placeHolder: "15m",
          ignoreFocusOut: true,
          validateInput: (value) => {
            const parsed = parseInterval(value);
            return "error" in parsed ? parsed.error : undefined;
          },
        });
        if (raw === undefined) return;
        const parsed = parseInterval(raw);
        if ("error" in parsed) return;
        await run("config", "Configuring", t.serviceId, () =>
          deps.ops.setConfig({ serviceId: t.serviceId, intervalMs: parsed.ms }),
        );
        return;
      }
      if (choice.label === "Index depth") {
        const depth = await deps.window.showQuickPick(
          [{ label: "metadata_only" }, { label: "summary" }, { label: "full" }],
          { placeHolder: `Index depth for ${t.serviceId}` },
        );
        if (depth === undefined) return;
        await run("config", "Configuring", t.serviceId, () =>
          deps.ops.setConfig({ serviceId: t.serviceId, depth: depth.label as ReindexDepth }),
        );
        return;
      }
      const enabled = choice.label === "Enable";
      await run("config", "Configuring", t.serviceId, () =>
        deps.ops.setConfig({ serviceId: t.serviceId, enabled }),
      );
    },

    "nimbus.reindexConnector": async (node) => {
      const t = await resolveTarget(node);
      if (t === undefined) return;
      const depth = await deps.window.showQuickPick(
        [{ label: "metadata_only" }, { label: "summary" }, { label: "full" }],
        { placeHolder: `Re-index ${t.serviceId} at which depth?` },
      );
      if (depth === undefined) return;
      const chosen = depth.label as ReindexDepth;
      if (chosen === "full") {
        const answer = await deps.window.showWarningMessage(
          `Re-index ${t.serviceId} at full depth? This needs your approval and can take a while.`,
          { modal: true },
          "Re-index",
        );
        if (answer !== "Re-index") return;
        await run("reindex", "Re-indexing", t.serviceId, () =>
          awaitingConsent(`Re-indexing ${t.serviceId} — waiting for your consent…`, () =>
            deps.ops.reindex(t.serviceId, chosen),
          ),
        );
        return;
      }
      await run("reindex", "Re-indexing", t.serviceId, () => deps.ops.reindex(t.serviceId, chosen));
    },

    "nimbus.authenticateConnector": async (node) => {
      const t = await resolveTarget(node);
      if (t === undefined) return;
      const fields = authFieldsFor(t.serviceId);
      const collected: Record<string, unknown> = {};
      for (const field of fields) {
        const value = await promptField(field);
        // Cancelling any prompt abandons the flow: nothing partial is sent.
        if (value === undefined) return;
        collected[field.name] = value.trim();
      }
      if (fields.length === 0) {
        void deps.window.showInformationMessage(
          `${t.serviceId} authenticates in the browser — the Gateway will open it and listen locally.`,
        );
      }
      // Field VALUES never reach the log; the field names are safe to name.
      deps.log.info(`connector auth: ${t.serviceId} (${Object.keys(collected).join(", ") || "no fields"})`);
      await run("auth", "Authenticating", t.serviceId, () => deps.ops.auth(t.serviceId, collected));
    },

    "nimbus.addMcpConnector": async () => {
      const serviceId = await deps.window.showInputBox({
        prompt: "Connector id",
        placeHolder: "mcp_acme",
        ignoreFocusOut: true,
        validateInput: (value) =>
          /^mcp_[a-z0-9_]{1,62}$/.test(value.trim())
            ? undefined
            : "Must look like mcp_name (lowercase letters, digits, underscores).",
      });
      if (serviceId === undefined) return;
      const commandLine = await deps.window.showInputBox({
        prompt: "Command line the Gateway will run",
        placeHolder: "npx -y @acme/mcp-server",
        ignoreFocusOut: true,
        validateInput: (value) => (value.trim() === "" ? "This field is required." : undefined),
      });
      if (commandLine === undefined) return;
      const id = serviceId.trim();
      await run("add-mcp", "Adding", id, () =>
        awaitingConsent(`Adding ${id} — waiting for your consent…`, () =>
          deps.ops.addMcp(id, commandLine.trim()),
        ),
      );
    },

    "nimbus.removeConnector": async (node) => {
      const t = await resolveTarget(node);
      if (t === undefined) return;
      const count = t.itemCount.toLocaleString("en-US");
      const answer = await deps.window.showWarningMessage(
        `Remove ${t.serviceId}? This deletes its ${count} indexed items and clears its stored credentials.`,
        { modal: true },
        "Remove",
      );
      if (answer !== "Remove") return;
      await run("remove", "Removing", t.serviceId, () =>
        awaitingConsent(`Removing ${t.serviceId} — waiting for your consent…`, () =>
          deps.ops.remove(t.serviceId),
        ),
      );
    },
  };
}
```

- [ ] **Step 5: Run the test**

Run: `bunx vitest run test/unit/connectors-commands.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/connectors/commands.ts src/vscode-shim.ts test/unit/connectors-commands.test.ts
git commit -m "feat(connectors): commands for sync, config, credentials and removal"
```

---

### Task 9: Manifest and wiring

**Files:**
- Modify: `package.json`, `src/extension.ts`
- Test: `test/unit/manifest-connectors.test.ts`

**Interfaces:**
- Consumes: `createConnectorsView` (Task 7), `createConnectorCommands` (Task 8), `createConnectorOps` (Task 6), `CONNECTOR_CONTEXT` (Task 2).
- Produces: a registered `nimbus.connectorsView` and ten commands.

- [ ] **Step 1: Write the failing manifest test**

Create `test/unit/manifest-connectors.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { CONNECTOR_CONTEXT } from "../../src/connectors/rows.js";

type Command = { command: string; title: string; category?: string; icon?: string };
type MenuEntry = { command: string; when?: string; group?: string };
type View = { id: string; name: string };

const manifest = JSON.parse(readFileSync(join(__dirname, "..", "..", "package.json"), "utf8")) as {
  contributes?: {
    commands?: Command[];
    views?: { nimbus?: View[] };
    viewsWelcome?: Array<{ view: string; contents: string; when?: string }>;
    menus?: { "view/title"?: MenuEntry[]; "view/item/context"?: MenuEntry[] };
  };
};

const commands = manifest.contributes?.commands ?? [];
const views = manifest.contributes?.views?.nimbus ?? [];
const welcome = manifest.contributes?.viewsWelcome ?? [];
const viewTitle = manifest.contributes?.menus?.["view/title"] ?? [];
const itemContext = manifest.contributes?.menus?.["view/item/context"] ?? [];
const VIEW = "nimbus.connectorsView";

const ALL = [
  "nimbus.syncConnector",
  "nimbus.fullResyncConnector",
  "nimbus.pauseConnector",
  "nimbus.resumeConnector",
  "nimbus.configureConnector",
  "nimbus.reindexConnector",
  "nimbus.authenticateConnector",
  "nimbus.addMcpConnector",
  "nimbus.removeConnector",
  "nimbus.refreshConnectors",
];

describe("extension manifest: connectors", () => {
  test("the view is contributed to the nimbus container", () => {
    expect(views.find((v) => v.id === VIEW)?.name).toBe("Connectors");
  });

  test("it has a disconnected welcome, like every other Nimbus view", () => {
    expect(welcome.find((w) => w.view === VIEW)?.when).toBe("!nimbus.connected");
  });

  test("every command is declared under the Nimbus category", () => {
    for (const id of ALL) {
      const entry = commands.find((c) => c.command === id);
      expect(entry, id).toBeDefined();
      expect(entry?.category).toBe("Nimbus");
    }
  });

  test("refresh sits in the view's title bar", () => {
    const entry = viewTitle.find((m) => m.command === "nimbus.refreshConnectors");
    expect(entry?.when).toBe(`view == ${VIEW}`);
    expect(entry?.group).toBe("navigation");
  });

  // A `when` clause carries either `viewItem == <value>` or `viewItem =~ /re/`.
  // Substring-matching it is wrong in both directions — "nimbus.connector.syncing"
  // does not occur inside "/nimbus.connector.(active|syncing)/", and a substring
  // test would also accept "nimbus.connector.syncingXYZ". Evaluate the clause
  // against the contextValue instead, which is what VS Code itself does.
  function offeredOn(when: string | undefined, contextValue: string): boolean {
    const clause = when ?? "";
    const re = /viewItem =~ \/(.+?)\//.exec(clause);
    if (re !== null) return new RegExp(re[1]).test(contextValue);
    return clause.includes(`viewItem == ${contextValue}`);
  }

  test("Pause and Resume never both appear on one row", () => {
    const pause = itemContext.find((m) => m.command === "nimbus.pauseConnector");
    const resume = itemContext.find((m) => m.command === "nimbus.resumeConnector");
    expect(offeredOn(pause?.when, CONNECTOR_CONTEXT.active)).toBe(true);
    expect(offeredOn(pause?.when, CONNECTOR_CONTEXT.paused)).toBe(false);
    expect(offeredOn(resume?.when, CONNECTOR_CONTEXT.paused)).toBe(true);
    expect(offeredOn(resume?.when, CONNECTOR_CONTEXT.active)).toBe(false);
  });

  test("the sync family is hidden while a connector is syncing", () => {
    for (const id of ["nimbus.syncConnector", "nimbus.fullResyncConnector", "nimbus.reindexConnector"]) {
      const entry = itemContext.find((m) => m.command === id);
      expect(offeredOn(entry?.when, CONNECTOR_CONTEXT.syncing), id).toBe(false);
    }
  });

  test("Pause and Remove stay reachable on a syncing row, on purpose", () => {
    for (const id of ["nimbus.pauseConnector", "nimbus.removeConnector"]) {
      const entry = itemContext.find((m) => m.command === id);
      expect(offeredOn(entry?.when, CONNECTOR_CONTEXT.syncing), id).toBe(true);
    }
  });

  test("no connector command is hidden from the palette — each prompts when it has no row", () => {
    const palette =
      (manifest.contributes?.menus as { commandPalette?: MenuEntry[] } | undefined)
        ?.commandPalette ?? [];
    for (const id of ALL) {
      expect(palette.find((m) => m.command === id)?.when, id).not.toBe("false");
    }
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bunx vitest run test/unit/manifest-connectors.test.ts`
Expected: FAIL — the view and commands are not in `package.json`.

- [ ] **Step 3: Add the manifest contributions**

In `package.json` → `contributes.views.nimbus`, after the `nimbus.indexView` entry:

```json
{ "id": "nimbus.connectorsView", "name": "Connectors" }
```

In `contributes.viewsWelcome`, mirroring the other views' entry:

```json
{
  "view": "nimbus.connectorsView",
  "when": "!nimbus.connected",
  "contents": "Connect to the Nimbus Gateway to manage your sources.\n[Start Gateway](command:nimbus.startGateway)\n[Troubleshoot](command:nimbus.troubleshootConnection)"
}
```

In `contributes.commands`, ten entries with `"category": "Nimbus"`:

```json
{ "command": "nimbus.refreshConnectors", "title": "Refresh Connectors", "category": "Nimbus", "icon": "$(refresh)" },
{ "command": "nimbus.syncConnector", "title": "Sync Now", "category": "Nimbus", "icon": "$(sync)" },
{ "command": "nimbus.fullResyncConnector", "title": "Full Re-sync", "category": "Nimbus" },
{ "command": "nimbus.pauseConnector", "title": "Pause Connector", "category": "Nimbus" },
{ "command": "nimbus.resumeConnector", "title": "Resume Connector", "category": "Nimbus" },
{ "command": "nimbus.configureConnector", "title": "Configure Connector", "category": "Nimbus" },
{ "command": "nimbus.reindexConnector", "title": "Re-index Connector", "category": "Nimbus" },
{ "command": "nimbus.authenticateConnector", "title": "Authenticate Connector", "category": "Nimbus" },
{ "command": "nimbus.addMcpConnector", "title": "Add MCP Connector", "category": "Nimbus" },
{ "command": "nimbus.removeConnector", "title": "Remove Connector", "category": "Nimbus" }
```

In `contributes.menus["view/title"]`:

```json
{ "command": "nimbus.refreshConnectors", "when": "view == nimbus.connectorsView", "group": "navigation" }
```

In `contributes.menus["view/item/context"]` — note which `contextValue`s each
`when` includes; the sync family omits `.syncing`, Pause and Remove include it:

```json
{ "command": "nimbus.syncConnector", "when": "view == nimbus.connectorsView && viewItem =~ /nimbus.connector.(active|paused)/", "group": "inline" },
{ "command": "nimbus.fullResyncConnector", "when": "view == nimbus.connectorsView && viewItem =~ /nimbus.connector.(active|paused)/", "group": "nimbus@1" },
{ "command": "nimbus.reindexConnector", "when": "view == nimbus.connectorsView && viewItem =~ /nimbus.connector.(active|paused|disabled)/", "group": "nimbus@2" },
{ "command": "nimbus.pauseConnector", "when": "view == nimbus.connectorsView && viewItem =~ /nimbus.connector.(active|syncing)/", "group": "nimbus@3" },
{ "command": "nimbus.resumeConnector", "when": "view == nimbus.connectorsView && viewItem == nimbus.connector.paused", "group": "nimbus@3" },
{ "command": "nimbus.configureConnector", "when": "view == nimbus.connectorsView && viewItem =~ /nimbus.connector./", "group": "nimbus@4" },
{ "command": "nimbus.authenticateConnector", "when": "view == nimbus.connectorsView && viewItem =~ /nimbus.connector./", "group": "nimbus@5" },
{ "command": "nimbus.removeConnector", "when": "view == nimbus.connectorsView && viewItem =~ /nimbus.connector./", "group": "nimbus@6" }
```

**Add nothing to `contributes.menus.commandPalette`.** The repo hides a command
from the palette (`"when": "false"`) only when it *cannot* work without its
node — `nimbus.openIndexItem`, `nimbus.openAuditEntry`, the diagnostic actions.
`nimbus.runWorkflow` is not hidden, because it prompts for a target when it has
none, and Task 8's `resolveTarget` gives these commands the same fallback. So
they stay palette-visible, which is also the only way to reach them by
keybinding.

- [ ] **Step 4: Run the manifest test**

Run: `bunx vitest run test/unit/manifest-connectors.test.ts`
Expected: PASS. (`viewItem =~ /nimbus.connector./` matches every connector row;
the test asserts `.syncing` is absent from the sync family's `when` and present
in Pause's and Remove's.)

- [ ] **Step 5: Wire it in `src/extension.ts`**

Add the imports:

```ts
import { createConnectorCommands } from "./connectors/commands.js";
import { createConnectorOps } from "./connectors/connector-client.js";
import { createConnectorsView } from "./connectors/connectors-view.js";
```

Build the ops and view beside the other views (`nimbus()` is the existing
per-call client resolver):

```ts
  const connectorOps = createConnectorOps(() => nimbus());
  const connectorsView = createConnectorsView({ connection, ops: connectorOps });
```

Add it to the `sidebarViews` array, after the Index view:

```ts
    ["nimbus.connectorsView", connectorsView],
```

Register the commands, plus refresh:

```ts
  const connectorCommands = createConnectorCommands({
    window: deps.window,
    ops: connectorOps,
    refresh: () => connectorsView.refresh(),
    log,
  });
  for (const [id, handler] of Object.entries(connectorCommands)) {
    ctx.subscriptions.push(deps.commands.registerCommand(id, (node?: unknown) => void handler(node)));
  }
  ctx.subscriptions.push(
    deps.commands.registerCommand("nimbus.refreshConnectors", () => connectorsView.refresh()),
  );
```

In `pollConnectorHealth`, refresh the view when the degraded summary changes —
this is what replaces a second timer:

```ts
      const previous = connectorHealth;
      connectorHealth = summarizeConnectorHealth(statuses);
      if (
        previous.count !== connectorHealth.count ||
        previous.names.join(",") !== connectorHealth.names.join(",")
      ) {
        connectorsView.refresh();
      }
```

Bind the config-changed subscription beside the HITL one, debounced so a burst
of mutations costs one refresh:

```ts
import { createDebouncer } from "./context/debounce.js";

  // Debouncer is { trigger(): void; dispose(): void }, so it already satisfies
  // DisposableLike ({ dispose(): void }) structurally — push it directly, no
  // wrapper object needed, and its pending timer is cleared on deactivate.
  const connectorRefresh = createDebouncer(250, () => connectorsView.refresh());
  ctx.subscriptions.push(connectorRefresh);
```

and, where the client subscriptions are (re-)bound on connect:

```ts
      connectorConfigSubscription = client.subscribeConnectorConfigChanged(() =>
        connectorRefresh.trigger(),
      );
```

disposing it on disconnect exactly as `hitlSubscription` is.

- [ ] **Step 6: Run the full suite and the typechecker**

Run: `bun run test && bun run typecheck`
Expected: PASS. `test/unit/extension.test.ts` must still pass — if it asserts a
command count, update that number and nothing else.

- [ ] **Step 7: Commit**

```bash
git add package.json src/extension.ts test/unit/manifest-connectors.test.ts
git commit -m "feat(connectors): register the view, its commands and its refresh paths"
```

---

### Task 10: The Sources row in the context panel

**Files:**
- Modify: `src/context/signals.ts`, `src/context/webview/render.ts`, `src/extension.ts`
- Test: `test/unit/context-signals-connectors.test.ts`, `test/unit/context-render.test.ts` (add cases)

**Interfaces:**
- Consumes: `ConnectorHealthSummary` (Task 1).
- Produces: `SignalId` gains `"connectors"`; `SignalDeps` gains
  `connectorHealth: () => ConnectorHealthSummary`; `SignalSection` gains
  `suppressWhenEmpty?: true`.

- [ ] **Step 1: Write the failing collector test**

Create `test/unit/context-signals-connectors.test.ts`:

```ts
import { describe, expect, test } from "vitest";

import { connectorsSection } from "../../src/context/signals.js";
import type { ContextSnapshot } from "../../src/context/snapshot.js";

const snapshot = { path: "src/a.ts", diagnostics: [] } as unknown as ContextSnapshot;

function deps(summary: { count: number; names: string[] }) {
  return {
    connectorHealth: () => summary,
    // If the collector ever reaches the Gateway, this throws and the test fails.
    client: () => {
      throw new Error("the Sources row must make no Gateway call");
    },
    now: () => 0,
    searchLimit: () => 5,
  } as never;
}

describe("the Sources section", () => {
  test("is empty and suppressed when every connector is healthy", async () => {
    const section = await connectorsSection(snapshot, deps({ count: 0, names: [] }));
    expect(section.rows).toEqual([]);
    expect(section.suppressWhenEmpty).toBe(true);
  });

  test("names the degraded connectors when there are any", async () => {
    const section = await connectorsSection(snapshot, deps({ count: 2, names: ["github", "slack"] }));
    expect(section.title).toBe("Sources");
    expect(section.rows.map((r) => r.label)).toEqual(["github", "slack"]);
    expect(section.rows[0]?.iconId).toBe("warning");
    expect(section.rows[0]?.detail).toBe("sync failing");
  });

  test("makes no Gateway call at all", async () => {
    await expect(connectorsSection(snapshot, deps({ count: 1, names: ["github"] }))).resolves.toBeDefined();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bunx vitest run test/unit/context-signals-connectors.test.ts`
Expected: FAIL — `connectorsSection` is not exported.

- [ ] **Step 3: Implement the signal**

In `src/context/signals.ts`:

1. Import the summary type: `import type { ConnectorHealthSummary } from "../connectors/health.js";`
2. Widen the id: `export type SignalId = "problems" | "git" | "blame" | "related" | "connectors";`
3. Add the title: `connectors: "Sources",` in `SECTION_TITLES`.
4. Add to `SignalDeps`:

```ts
  /**
   * The degraded-connector summary the status-bar poll already computed. Read,
   * not fetched: this signal costs no round trip, which is why it is `local`.
   */
  readonly connectorHealth: () => ConnectorHealthSummary;
```

5. Add to `SignalSection`:

```ts
  /**
   * Render nothing at all — no heading, no empty line — when `rows` is empty.
   * A healthy setup should not carry a "Sources: all fine" row on every tick,
   * the same judgement that omits the git row on a clean tree.
   */
  readonly suppressWhenEmpty?: true;
```

6. Add the collector:

```ts
export async function connectorsSection(
  _snapshot: ContextSnapshot,
  deps: SignalDeps,
): Promise<SignalSection> {
  const { names } = deps.connectorHealth();
  return {
    id: "connectors",
    title: SECTION_TITLES.connectors,
    suppressWhenEmpty: true,
    rows: names.map((name) => ({ label: name, detail: "sync failing", iconId: "warning" })),
  };
}
```

7. Register it in `SIGNAL_CATALOG`, as a local signal with no cache key:

```ts
  { id: "connectors", needsGateway: false, collect: connectorsSection, cacheKey: () => undefined },
```

- [ ] **Step 4: Run the collector test**

Run: `bunx vitest run test/unit/context-signals-connectors.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing renderer test**

Add to `test/unit/context-render.test.ts`:

```ts
test("a suppressWhenEmpty section with no rows renders nothing at all", () => {
  const html = renderSections([
    { id: "connectors", title: "Sources", rows: [], suppressWhenEmpty: true },
  ]);
  expect(html).toBe("");
});

test("a section without the flag still renders its empty text", () => {
  const html = renderSections([{ id: "git", title: "Git", rows: [], empty: "No git repository here." }]);
  expect(html).toContain("No git repository here.");
});

test("a suppressWhenEmpty section WITH rows renders normally", () => {
  const html = renderSections([
    {
      id: "connectors",
      title: "Sources",
      rows: [{ label: "github", detail: "sync failing" }],
      suppressWhenEmpty: true,
    },
  ]);
  expect(html).toContain("Sources");
  expect(html).toContain("github");
});
```

- [ ] **Step 6: Run it and watch it fail**

Run: `bunx vitest run test/unit/context-render.test.ts`
Expected: FAIL — the suppressed section still renders a heading.

- [ ] **Step 7: Filter in the renderer**

In `src/context/webview/render.ts`, at the top of `renderSections`:

```ts
export function renderSections(sections: readonly SignalSection[]): string {
  return sections
    // A suppressed section with nothing to say renders nothing — not a heading
    // over an empty state. Filtered here rather than in the controller so the
    // rule is one pure line with no state behind it.
    .filter((section) => !(section.suppressWhenEmpty === true && section.rows.length === 0))
    .map((section) => {
```

(the rest of the function is unchanged).

- [ ] **Step 8: Run the renderer test**

Run: `bunx vitest run test/unit/context-render.test.ts`
Expected: PASS.

- [ ] **Step 9: Feed the summary in from `extension.ts`**

Where `registerContextView` is called, add to the deps it forwards into
`SignalDeps` — `connectorHealth` is the mutable summary the poll maintains:

```ts
      connectorHealth: () => connectorHealth,
```

Follow the existing wiring in `src/context/real-context-view.ts` for how
`signalDeps` is assembled; add the field there in the same shape as `now` and
`searchLimit`.

- [ ] **Step 10: Run the full suite, typecheck, and the choke-point guard**

Run: `bun run test && bun run typecheck`
Expected: PASS, including `egress-choke-point.test.ts` **unmodified** —
`src/context/` still names only its two model-free calls.

- [ ] **Step 11: Commit**

```bash
git add src/context/signals.ts src/context/webview/render.ts src/context/real-context-view.ts src/extension.ts test/unit/context-signals-connectors.test.ts test/unit/context-render.test.ts
git commit -m "feat(context): show unhealthy sources in the context panel"
```

---

### Task 11: Docs and the full local gate

**Files:**
- Create: `docs/connectors.md`
- Modify: `docs/architecture.md`, `docs/README.md`, `docs/ROADMAP.md`, `CLAUDE.md`

- [ ] **Step 1: Write `docs/connectors.md`**

It must cover, in prose: what the view shows and what each action does; that
**built-in connector onboarding is absent because no RPC registers one**, and
that `connectorAddMcp` is the only registration path; that the credential
catalog's field names are sourced from the pinned client's JSDoc and **will
drift** when the Gateway adds or renames a provider, with the generic fallback
as the escape hatch; that credentials are never stored, cached or logged by the
extension; that a denial and an expiry both arrive as the same shape, so the
Gateway's reason is shown verbatim; and that `connectorHealthHistory` is
built-in-connectors-only, which is why an `mcp_*` row shows no history group.

- [ ] **Step 2: Update the other docs**

- `docs/README.md` — add `connectors.md` to the index.
- `docs/architecture.md` — add `src/connectors/` to the module map, noting the
  adapter's role and that this surface reaches no model.
- `docs/ROADMAP.md` — move **Connector management** and **Index write ops** from
  Phase 3 to *Already shipped*, and add a Phase 4 row for exposing an MCP
  connector's command line (`commandLine` is input-only in the current client).
- `CLAUDE.md` — add the surface to the *Surface today* paragraph and
  `src/connectors/` to *Layout*.

- [ ] **Step 3: Run the complete local gate**

Run each, in order, and paste the output into the PR description:

```bash
bun run test
bun run typecheck
bun run lint
bun run build
bun run check-bundle
bun run check-vsix-contents
bun run check-settings-docs
```

Expected: all PASS. `check-settings-docs` passes **because no setting was
added** — if it fails, a setting crept in that the spec says should not exist.

- [ ] **Step 4: Commit**

```bash
git add docs CLAUDE.md
git commit -m "docs: record the connector management surface"
```

- [ ] **Step 5: Verify in a real editor**

**The unit suite does not prove this works.** Follow the `verify-extension`
skill: launch the Extension Development Host against a live Gateway with at
least one healthy connector, one deliberately broken one, and one `mcp_*`
connector, and walk the eleven checks in the spec's *Verification* section.
Two of them test claims that rest on a JSDoc sentence rather than observed
behaviour, and matter most:

- **check 10** — leave a consent request unanswered. It must settle on its own,
  and its reason must read differently from an active denial. If it never
  settles, the "no extension-side timeout" decision is wrong: say so, and add
  the defensive timeout back.
- **check 11** — the `.syncing` menu guard, and a double-click issuing one RPC.

Write the findings to
`docs/superpowers/plans/2026-08-18-connector-f5-findings.md` — the date is the
day the pass actually runs, so rename it if that is not today — and **fix what
it finds on this branch** before calling the work done.

---

## Self-Review

**Spec coverage:** view (Task 7) · rows and icons (2) · on-expand telemetry and
history with the `mcp_*` skip (6, 7) · liveness off the existing poll plus the
debounced subscription (9) · the four wire shapes (3) · concurrency, both
guards (8, 9) · the two blocking calls and no local timeout (8) · credentials,
catalog, fallback, masking, no logging (5, 8) · validation stopping at emptiness
(4, 8) · Sources row and `suppressWhenEmpty` (10) · error text verbatim and
unlogged (2) · the health-rule move (1) · docs and roadmap (11) · verification
(11). Every spec section maps to a task.

**Known deviations from the spec, deliberate:**
- The spec's *Delivery* lists five commits; this plan lands eleven, one per
  independently reviewable unit. Squash at PR time if a five-commit history is
  wanted.
- `connectorSetInterval` is **not** wrapped by the adapter. The spec's open
  question 3 allowed dropping it; `setConfig` covers the same ground, and a seam
  method nothing calls is dead code the choke-point discipline would rather not
  carry.

**Type consistency:** `ConnectorHealthSummary` (1) is consumed by 10;
`ConnectorPayload`/`connectorPayloadOf` (2) by 7 and 8; `ConnectorOutcome` and
`describeOutcome` (3) by 6 and 8; `parseInterval`/`formatInterval` (4) by 6 and
8; `authFieldsFor`/`GENERIC_FIELD` (5) by 8; `ConnectorOps` (6) by 7 and 8;
`CONNECTOR_CONTEXT` (2) by 9's manifest test. `ReindexDepth` is declared once,
in Task 6, and imported by Task 8.
