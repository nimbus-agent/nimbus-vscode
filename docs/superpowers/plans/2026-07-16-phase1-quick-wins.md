# Phase 1 Quick Wins Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the four Phase 1 "quick wins" — egress status-bar badge, Stop-cancel webview reset, connection troubleshooter, and Find related — as one branch / one PR with four independent, individually-revertable commits.

**Architecture:** Each feature isolates pure, unit-tested core logic (a format function, a report builder, a predicate) from thin `extension.ts` / `vscode-shim` wiring, mirroring existing modules (`status-bar-item.ts`, `search.ts`, the sidebar views). No new Gateway capability: the batch uses `egressHead`, the already-consumed `cancelStream` (via `AskStreamHandle.cancel()`), and `searchRanked`, all present in `@nimbus-dev/client@0.5.0`.

**Tech Stack:** TypeScript (strict), Vitest (+ jsdom for the webview), Biome, esbuild. `vscode` is reached only through `src/vscode-shim.ts` and stubbed in tests.

**Spec:** [docs/superpowers/specs/2026-07-16-phase1-quick-wins-design.md](../specs/2026-07-16-phase1-quick-wins-design.md)

## Global Constraints

- **No reaching past `@nimbus-dev/client`** — Gateway data rides typed RPCs only. No imports from Nimbus gateway source.
- **No `any`.** Use `unknown` for external data. TypeScript strict; Biome enforces `noExplicitAny`, `noConsole` (log via `logging.ts`), `noNonNullAssertion`.
- **`vscode` only through `src/vscode-shim.ts`.**
- **Committed `@nimbus-dev/client` stays a published `^x.y.z`** (currently `^0.5.0`), never `workspace:*`.
- **Docs-sync guard:** the one new setting (`nimbus.egress.showStatusBarBadge`) must land in `package.json` (`contributes.configuration`), `docs/settings.md`, **and** `README.md` in the same commit.
- **Branch:** `feat/phase1-quick-wins` (already created). One commit per task, in task order.
- **Local gate** (run before each commit): `bun run test && bun run typecheck && bun run lint && bun run build && bun run check-bundle`.

---

## File Structure

- **Task 1 — Egress badge** — create `src/status-bar/egress-status-bar-item.ts` (pure format + controller); create `test/unit/egress-status-bar-item.test.ts`; modify `src/settings.ts` (+ `test/unit/settings.test.ts`), `src/extension.ts` (item + poll + `refreshEgress`), `package.json`, `docs/settings.md`, `README.md`.
- **Task 2 — Stop reset** — modify `src/chat/chat-protocol.ts` (new `cancelled` message), `src/chat/chat-controller.ts` (`stop()` posts it), `src/chat/webview/main.ts` (handle it + Stopping… state), `src/chat/webview/styles.css` (marker); extend `test/unit/chat-controller.test.ts`, `test/unit/webview-interactions.test.ts`.
- **Task 3 — Troubleshooter** — create `src/connection/troubleshooter.ts`; create `test/unit/troubleshooter.test.ts`; modify `src/extension.ts` (command), `package.json` (command).
- **Task 4 — Find related** — modify `src/search.ts` (`buildPicks` exclude + `sameName`); extend `test/unit/search.test.ts`; modify `src/extension.ts` (`runSearch` opts + two commands), `package.json` (commands + menus).

---

## Task 1: Egress status-bar badge

**Files:**
- Create: `src/status-bar/egress-status-bar-item.ts`
- Test: `test/unit/egress-status-bar-item.test.ts`
- Modify: `src/settings.ts`, `test/unit/settings.test.ts`, `src/extension.ts`, `package.json`, `docs/settings.md`, `README.md`

**Interfaces:**
- Consumes: `StatusBarItemHandle` from `src/vscode-shim.ts`; `NimbusClient.egressHead(): Promise<{ head: string; count: number }>`; `connection.current()`, `nimbus()`, `settings`, `log`, `errMsg` (all already in `extension.ts`).
- Produces: `formatEgressBadge(inp: EgressBadgeInputs): EgressBadgeRender | undefined`, `createEgressStatusBarController(item): EgressStatusBarController`, `EgressBadgeInputs`, `Settings.showEgressStatusBarBadge(): boolean`, and an `extension.ts`-local `refreshEgress(): void` co-refresh helper.

- [ ] **Step 1: Write the failing test for the pure format function**

Create `test/unit/egress-status-bar-item.test.ts`:

```ts
import { describe, expect, test } from "vitest";

import { formatEgressBadge } from "../../src/status-bar/egress-status-bar-item.js";

const base = {
  head: undefined,
  lastKnownCount: undefined,
  error: undefined,
  connected: true,
  showBadge: true,
} as const;

describe("formatEgressBadge", () => {
  test("hidden when the badge setting is off", () => {
    expect(
      formatEgressBadge({ ...base, showBadge: false, head: { head: "abc123", count: 3 } }),
    ).toBeUndefined();
  });

  test("hidden when disconnected", () => {
    expect(
      formatEgressBadge({ ...base, connected: false, head: { head: "abc123", count: 3 } }),
    ).toBeUndefined();
  });

  test("hidden on read error before any successful read", () => {
    expect(formatEgressBadge({ ...base, error: "boom" })).toBeUndefined();
  });

  test("success render: count, short head, check icon, focus command", () => {
    const r = formatEgressBadge({ ...base, head: { head: "3f9a1b2c4d", count: 128 } });
    expect(r?.text).toBe("$(shield) 128 $(check)");
    expect(r?.tooltip).toContain("128 rows");
    expect(r?.tooltip).toContain("3f9a1b");
    expect(r?.tooltip).toContain("Verify ledger");
    expect(r?.command).toBe("nimbus.egressView.focus");
  });

  test("stale render after error keeps last-known count with a warning icon", () => {
    const r = formatEgressBadge({
      ...base,
      head: undefined,
      lastKnownCount: 128,
      error: "ECONNRESET",
    });
    expect(r?.text).toBe("$(shield) 128 $(warning)");
    expect(r?.tooltip).toContain("last known 128");
    expect(r?.tooltip).toContain("ECONNRESET");
    expect(r?.text).not.toMatch(/egress/i);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test -- egress-status-bar-item`
Expected: FAIL — cannot find module `../../src/status-bar/egress-status-bar-item.js`.

- [ ] **Step 3: Implement the pure module + controller**

Create `src/status-bar/egress-status-bar-item.ts`:

```ts
import type { StatusBarItemHandle } from "../vscode-shim.js";

export interface EgressBadgeInputs {
  // Set on a fresh successful egressHead() read.
  head: { head: string; count: number } | undefined;
  // Last successful count, tracked by the controller across polls; drives the
  // stale render when a later poll errors.
  lastKnownCount: number | undefined;
  // Message from the last failed poll (undefined on success / first read).
  error: string | undefined;
  connected: boolean;
  showBadge: boolean;
}

export interface EgressBadgeRender {
  text: string;
  tooltip: string;
  command: string | undefined;
}

// Pure view-model for the egress badge. Returns undefined when the item should
// be hidden: badge disabled, not connected, or an error before any good read.
// The count is NEVER replaced by a literal word — always a number or nothing.
export function formatEgressBadge(inp: EgressBadgeInputs): EgressBadgeRender | undefined {
  if (!inp.showBadge || !inp.connected) return undefined;
  if (inp.head !== undefined) {
    const shortHead = inp.head.head.slice(0, 6);
    return {
      text: `$(shield) ${inp.head.count} $(check)`,
      tooltip: `Egress ledger: ${inp.head.count} rows · head ${shortHead}… · click to open · run "Verify ledger" for a cryptographic check`,
      command: "nimbus.egressView.focus",
    };
  }
  if (inp.lastKnownCount !== undefined) {
    const suffix = inp.error !== undefined ? ` (${inp.error})` : "";
    return {
      text: `$(shield) ${inp.lastKnownCount} $(warning)`,
      tooltip: `Egress ledger: couldn't refresh — showing last known ${inp.lastKnownCount} rows${suffix}`,
      command: "nimbus.egressView.focus",
    };
  }
  return undefined;
}

export interface EgressStatusBarController {
  update(inp: EgressBadgeInputs): void;
  dispose(): void;
}

export function createEgressStatusBarController(
  item: StatusBarItemHandle,
): EgressStatusBarController {
  return {
    update(inp): void {
      const r = formatEgressBadge(inp);
      if (r === undefined) {
        item.hide();
        return;
      }
      item.text = r.text;
      item.tooltip = r.tooltip;
      item.command = r.command;
      item.show();
    },
    dispose(): void {
      item.dispose();
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run test -- egress-status-bar-item`
Expected: PASS (5 tests).

- [ ] **Step 5: Add the setting getter + its test**

In `src/settings.ts`, add to the `Settings` interface (after `quickAskPresets(): unknown;`):

```ts
  showEgressStatusBarBadge(): boolean;
```

And to the returned object in `createSettings` (after the `quickAskPresets` line):

```ts
    showEgressStatusBarBadge: () => cfg().get<boolean>("egress.showStatusBarBadge", true),
```

In `test/unit/settings.test.ts`, add to the "returns defaults" test:

```ts
    expect(s.showEgressStatusBarBadge()).toBe(true);
```

And to the "returns user-set values" test — add `"egress.showStatusBarBadge": false,` to the `makeWorkspace({...})` object and this assertion:

```ts
    expect(s.showEgressStatusBarBadge()).toBe(false);
```

- [ ] **Step 6: Run the settings test to verify it passes**

Run: `bun run test -- settings`
Expected: PASS.

- [ ] **Step 7: Wire the badge into `extension.ts`**

Add the import near the existing status-bar import (`src/extension.ts:39`):

```ts
import {
  createEgressStatusBarController,
  type EgressBadgeInputs,
} from "./status-bar/egress-status-bar-item.js";
```

After the existing status-bar controller block (`src/extension.ts:128-131`, ending `ctx.subscriptions.push(statusBar);`), add:

```ts
  const egressStatusItem = deps.window.createStatusBarItem(2, 99);
  ctx.subscriptions.push(egressStatusItem);
  const egressBadge = createEgressStatusBarController(egressStatusItem);
  ctx.subscriptions.push(egressBadge);
  let egressLastKnownCount: number | undefined;

  const pollEgressBadge = async (): Promise<void> => {
    const connected = connection.current().kind === "connected";
    const showBadge = settings.showEgressStatusBarBadge();
    const base: EgressBadgeInputs = {
      head: undefined,
      lastKnownCount: egressLastKnownCount,
      error: undefined,
      connected,
      showBadge,
    };
    if (!connected || !showBadge) {
      egressBadge.update(base);
      return;
    }
    const client = nimbus();
    if (client === undefined) {
      egressBadge.update({ ...base, connected: false });
      return;
    }
    try {
      const head = await client.egressHead();
      egressLastKnownCount = head.count;
      egressBadge.update({ ...base, head, lastKnownCount: head.count });
    } catch (e) {
      log.warn(`egressHead poll failed: ${errMsg(e)}`);
      egressBadge.update({ ...base, error: errMsg(e) });
    }
  };

  let egressTimer = setInterval(() => void pollEgressBadge(), settings.statusBarPollMs());
  ctx.subscriptions.push({ dispose: () => clearInterval(egressTimer) });
  void pollEgressBadge();
```

> `pollEgressBadge` uses only bindings declared above this point (`connection`, `settings`, `nimbus`, `log`, `errMsg`, `egressBadge`). It must live here — before `renderStatusBar` (which calls it) and before `cfgSub` (which reassigns `egressTimer`), so both bindings are declared before their first use. `egressTimer` is `let` so the config listener can restart it. The `refreshEgress` co-refresh helper is added later — it needs `egressView`, which is declared further down.

Immediately **after** the `egressView` declaration (`src/extension.ts:347-350`, `const egressView = createEgressView({...});`), add the co-refresh helper:

```ts
  const refreshEgress = (): void => {
    egressView.refresh();
    void pollEgressBadge();
  };
```

Replace the `nimbus.refreshEgress` command handler (`src/extension.ts:675-677`):

```ts
  register("nimbus.refreshEgress", () => {
    refreshEgress();
  });
```

Refresh the badge on connect: in the `connection.onState`/`stateSub` listener, in the `if (s.kind === "connected")` branch (near `src/extension.ts:290`, after `log.info(...connected...)`), add:

```ts
      void pollEgressBadge();
```

Also refresh on any state change so the badge hides when disconnected — inside `renderStatusBar` (`src/extension.ts:134-143`), after `statusBar.update({...})`, add:

```ts
    void pollEgressBadge();
```

React to config changes: in the `cfgSub` handler (`src/extension.ts:334`), inside the `if (e.affectsConfiguration("nimbus"))` block, add an immediate re-render (handles the badge on/off toggle):

```ts
      void pollEgressBadge();
```

And, so a changed poll cadence takes effect without a window reload (the setting's docs say the badge follows `statusBarPollMs`), add — still inside the `cfgSub` handler, as a sibling `if` — a timer restart:

```ts
    if (e.affectsConfiguration("nimbus.statusBarPollMs")) {
      clearInterval(egressTimer);
      egressTimer = setInterval(() => void pollEgressBadge(), settings.statusBarPollMs());
    }
```

> The `egressTimer` and its initial `void pollEgressBadge()` are created in the early badge block above (alongside `pollEgressBadge`), so `egressTimer` is declared before this `cfgSub` handler references it — no separate "start the timer" step is needed.

- [ ] **Step 8: Add the setting to the manifest and docs**

In `package.json`, in `contributes.configuration.properties`, after the `nimbus.quickAsk.presets` block (closes at line ~349), add:

```json
        "nimbus.egress.showStatusBarBadge": {
          "type": "boolean",
          "default": true,
          "description": "Show the egress ledger badge (row count + a ledger-live check) in the status bar while connected."
        },
```

In `docs/settings.md`, after the `### nimbus.quickAsk.presets` section, add:

```markdown
### `nimbus.egress.showStatusBarBadge`

`boolean` (default `true`). Shows a second status-bar item while connected: the egress ledger row count plus a `$(check)` that means *the ledger head was read successfully* — not a cryptographic verification. Click it to open the Egress view; run **Verify Egress Ledger** for the offline chain check. Set to `false` to hide the badge. Poll cadence follows [`nimbus.statusBarPollMs`](#nimbusstatusbarpollms).
```

In `README.md`, in the settings table, after the `nimbus.quickAsk.presets` row (line 37), add:

```markdown
| `nimbus.egress.showStatusBarBadge` | `true` | Show the egress row-count badge (ledger-live ✓) in the status bar. |
```

- [ ] **Step 9: Run the full local gate**

Run: `bun run test && bun run typecheck && bun run lint && bun run build && bun run check-bundle`
Expected: all pass. (`check-bundle` still reports `vscode` as the only external — the new module bundles in.)

- [ ] **Step 10: Commit**

```bash
git add src/status-bar/egress-status-bar-item.ts test/unit/egress-status-bar-item.test.ts src/settings.ts test/unit/settings.test.ts src/extension.ts package.json docs/settings.md README.md
git commit -m "feat(egress): status-bar badge (row count + head-reachable check) via egressHead

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Reset webview UI after Stop

**Files:**
- Modify: `src/chat/chat-protocol.ts`, `src/chat/chat-controller.ts`, `src/chat/webview/main.ts`, `src/chat/webview/styles.css`
- Test: `test/unit/chat-controller.test.ts`, `test/unit/webview-interactions.test.ts`

**Interfaces:**
- Consumes: existing `AskStreamHandle.cancel()` (calls `engine.cancelStream`), `ChatPanel.postMessage`, the webview `applyMessage` switch and `finalizeStreamingTurn`/`setStreaming` helpers.
- Produces: a new `ExtensionToWebview` variant `{ type: "cancelled" }`; `stop()` posts it before awaiting cancel.

- [ ] **Step 1: Add the protocol message**

In `src/chat/chat-protocol.ts`, add to the `ExtensionToWebview` union (e.g. after the `done` variant, before `error`):

```ts
  | { type: "cancelled" }
```

- [ ] **Step 2: Write the failing controller test**

In `test/unit/chat-controller.test.ts`, add inside the `describe("ChatController", ...)` block:

```ts
  test("stop() posts a cancelled message to the webview when a stream is active", async () => {
    const { handle } = pendingStream();
    const { panel, posted } = capturingPanel();
    const ctrl = createChatController(
      baseDeps(fakeChatClient({ askStream: () => handle }), { panel }),
    );
    const p = ctrl.start("hi");
    await Promise.resolve();
    await ctrl.stop();
    await p;
    expect(postedTypes(posted)).toContain("cancelled");
  });

  test("stop() posts no cancelled message when nothing is streaming", async () => {
    const { panel, posted } = capturingPanel();
    const ctrl = createChatController(baseDeps(new MockClient(), { panel }));
    await ctrl.stop();
    expect(postedTypes(posted)).not.toContain("cancelled");
  });
```

- [ ] **Step 3: Run the controller test to verify it fails**

Run: `bun run test -- chat-controller`
Expected: FAIL — `posted` does not contain `"cancelled"`.

- [ ] **Step 4: Update `stop()` to post `cancelled` before awaiting cancel**

In `src/chat/chat-controller.ts`, replace the `stop()` method (currently lines ~143-148):

```ts
    async stop(): Promise<void> {
      if (active === undefined) return;
      const handle = active;
      active = undefined;
      // Post before awaiting cancel(): handle.cancel() awaits an IPC round-trip
      // (engine.cancelStream) that can hang on a severed connection, and the
      // webview's return-to-idle must not depend on the Gateway acking it.
      post({ type: "cancelled" });
      await handle.cancel();
    },
```

- [ ] **Step 5: Run the controller test to verify it passes**

Run: `bun run test -- chat-controller`
Expected: PASS.

- [ ] **Step 6: Write the failing webview tests**

In `test/unit/webview-interactions.test.ts`, add inside `describe("webview applyMessage", ...)`:

```ts
  test("cancelled finalizes the streaming turn, marks it Stopped, and re-enables send", () => {
    dispatch({ type: "userMessage", text: "q" });
    dispatch({ type: "token", text: "partial" });
    dispatch({ type: "cancelled" });
    expect($("#transcript").innerHTML).toContain("partial");
    expect($("#transcript").innerHTML).toContain("Stopped");
    expect($("#transcript").querySelector('[data-streaming="1"]')).toBeNull();
    expect(btn("#input-send").disabled).toBe(false);
    expect(btn("#input-stop").disabled).toBe(true);
  });

  test("cancelled while not streaming is a no-op", () => {
    // beforeEach dispatched reset → not streaming.
    expect(() => dispatch({ type: "cancelled" })).not.toThrow();
    expect(btn("#input-send").disabled).toBe(false);
  });
```

And inside `describe("webview interactions", ...)`:

```ts
  test("clicking Stop shows Stopping… and disables the Stop button", () => {
    dispatch({ type: "userMessage", text: "q" });
    click($("#input-stop"));
    expect($("#status").textContent).toBe("Stopping…");
    expect(btn("#input-stop").disabled).toBe(true);
  });
```

- [ ] **Step 7: Run the webview tests to verify they fail**

Run: `bun run test -- webview-interactions`
Expected: FAIL — no "Stopped" marker; status is not "Stopping…".

- [ ] **Step 8: Handle `cancelled` and the Stopping… click state in the webview**

In `src/chat/webview/main.ts`, add a case to the `applyMessage` switch (after the `done` case, before `error`):

```ts
    case "cancelled": {
      if (!state.streaming) return;
      const streamingTurn = r.transcript.querySelector("article.turn-streaming");
      finalizeStreamingTurn(r);
      if (streamingTurn !== null) {
        const marker = document.createElement("div");
        marker.className = "turn-stopped-marker";
        marker.textContent = "⏹ Stopped";
        streamingTurn.appendChild(marker);
      }
      setStreaming(r, false);
      return;
    }
```

Update the Stop click handler in `bootstrap()` (currently lines ~212-215):

```ts
  r.stop.addEventListener("click", () => {
    if (!state.streaming) return;
    r.stop.disabled = true;
    r.status.textContent = "Stopping…";
    vscode.postMessage({ type: "stopStream" });
  });
```

- [ ] **Step 9: Add the marker style**

In `src/chat/webview/styles.css`, add:

```css
.turn-stopped-marker {
  margin-top: 0.4em;
  font-size: 0.85em;
  opacity: 0.6;
}
```

- [ ] **Step 10: Run the webview tests to verify they pass**

Run: `bun run test -- webview-interactions`
Expected: PASS.

- [ ] **Step 11: Run the full local gate**

Run: `bun run test && bun run typecheck && bun run lint && bun run build && bun run check-bundle`
Expected: all pass.

- [ ] **Step 12: Commit**

```bash
git add src/chat/chat-protocol.ts src/chat/chat-controller.ts src/chat/webview/main.ts src/chat/webview/styles.css test/unit/chat-controller.test.ts test/unit/webview-interactions.test.ts
git commit -m "feat(chat): reset webview UI after Stop (finalize partial + Stopped marker)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Connection troubleshooter

**Files:**
- Create: `src/connection/troubleshooter.ts`
- Test: `test/unit/troubleshooter.test.ts`
- Modify: `src/extension.ts`, `package.json`

**Interfaces:**
- Consumes: `ConnectionState` from `src/connection/connection-manager.js`; at wiring time `connection.current()`, `settings.autoStartGateway()`, `process.platform`, `deps.window.showInformationMessage`, `deps.commands.executeCommand`.
- Produces: `buildTroubleshooter(state, { autoStartGateway, platform }): TroubleshootReport`, with `TroubleshootReport = { level; message; actions: { label; command; args? }[] }`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/troubleshooter.test.ts`:

```ts
import { describe, expect, test } from "vitest";

import type { ConnectionState } from "../../src/connection/connection-manager.js";
import { buildTroubleshooter } from "../../src/connection/troubleshooter.js";

const unix = { autoStartGateway: false, platform: "linux" as NodeJS.Platform };

function commandsOf(state: ConnectionState, opts = unix): string[] {
  return buildTroubleshooter(state, opts).actions.map((a) => a.command);
}

describe("buildTroubleshooter", () => {
  test("connected → info + open logs, message names the socket", () => {
    const r = buildTroubleshooter({ kind: "connected", socketPath: "/run/n.sock" }, unix);
    expect(r.level).toBe("info");
    expect(r.message).toContain("/run/n.sock");
    expect(r.actions.map((a) => a.command)).toEqual(["nimbus.openLogs"]);
  });

  test("disconnected + autoStart off → error, offers Start Gateway", () => {
    const r = buildTroubleshooter(
      { kind: "disconnected", socketPath: "/run/n.sock", reason: "ECONNREFUSED" },
      unix,
    );
    expect(r.level).toBe("error");
    expect(r.actions.map((a) => a.command)).toContain("nimbus.startGateway");
  });

  test("disconnected + autoStart on → warn, offers Reconnect not Start", () => {
    const r = buildTroubleshooter(
      { kind: "disconnected", socketPath: "/run/n.sock", reason: "x" },
      { autoStartGateway: true, platform: "linux" },
    );
    expect(r.level).toBe("warn");
    expect(commandsOf({ kind: "disconnected", socketPath: "/run/n.sock", reason: "x" }, {
      autoStartGateway: true,
      platform: "linux",
    })).toEqual(["nimbus.reconnect", "nimbus.openLogs"]);
  });

  test("permission-denied on Unix mentions chmod/chown and offers Edit setting", () => {
    const r = buildTroubleshooter(
      { kind: "permission-denied", socketPath: "/run/n.sock" },
      { autoStartGateway: false, platform: "linux" },
    );
    expect(r.message).toMatch(/chmod|chown/);
    expect(r.actions[0]?.command).toBe("workbench.action.openSettings");
    expect(r.actions[0]?.args).toEqual(["nimbus.socketPath"]);
  });

  test("permission-denied on Windows mentions named-pipe access", () => {
    const r = buildTroubleshooter(
      { kind: "permission-denied", socketPath: "\\\\.\\pipe\\nimbus" },
      { autoStartGateway: false, platform: "win32" },
    );
    expect(r.message).toMatch(/named.pipe/i);
    expect(r.message).not.toMatch(/chmod/);
  });

  test("idle → warn, offers reconnect", () => {
    const r = buildTroubleshooter({ kind: "idle" }, unix);
    expect(r.level).toBe("warn");
    expect(r.actions.map((a) => a.command)).toContain("nimbus.reconnect");
  });

  test("connecting → info, offers reconnect", () => {
    expect(commandsOf({ kind: "connecting", socketPath: "/run/n.sock" })).toEqual([
      "nimbus.reconnect",
      "nimbus.openLogs",
    ]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test -- troubleshooter`
Expected: FAIL — cannot find module `../../src/connection/troubleshooter.js`.

- [ ] **Step 3: Implement the report builder**

Create `src/connection/troubleshooter.ts`:

```ts
import type { ConnectionState } from "./connection-manager.js";

export interface TroubleshootAction {
  label: string;
  command: string;
  args?: unknown[];
}

export interface TroubleshootReport {
  level: "info" | "warn" | "error";
  message: string;
  actions: TroubleshootAction[];
}

const OPEN_LOGS: TroubleshootAction = { label: "Open Logs", command: "nimbus.openLogs" };
const RECONNECT: TroubleshootAction = { label: "Reconnect Now", command: "nimbus.reconnect" };
const START_GATEWAY: TroubleshootAction = { label: "Start Gateway", command: "nimbus.startGateway" };
const EDIT_SETTING: TroubleshootAction = {
  label: "Edit socketPath Setting",
  command: "workbench.action.openSettings",
  args: ["nimbus.socketPath"],
};

// Pure diagnosis: maps a ConnectionState to a user-facing report + fix actions.
// `platform` is injected so permission-denied guidance can differ (Unix socket
// modes vs Windows named-pipe access) without touching process in this module.
export function buildTroubleshooter(
  state: ConnectionState,
  opts: { autoStartGateway: boolean; platform: NodeJS.Platform },
): TroubleshootReport {
  switch (state.kind) {
    case "connected":
      return {
        level: "info",
        message: `Connected to the Gateway at ${state.socketPath}.`,
        actions: [OPEN_LOGS],
      };
    case "disconnected":
      if (opts.autoStartGateway) {
        return {
          level: "warn",
          message: `Waiting for the Gateway to start at ${state.socketPath}.`,
          actions: [RECONNECT, OPEN_LOGS],
        };
      }
      return {
        level: "error",
        message: `Nimbus can't reach the Gateway (not running) at ${state.socketPath}.`,
        actions: [START_GATEWAY, OPEN_LOGS],
      };
    case "permission-denied":
      return {
        level: "error",
        message:
          opts.platform === "win32"
            ? `Permission denied accessing ${state.socketPath} — check that the Gateway is running under your user account (named-pipe access), or adjust the socketPath setting.`
            : `Permission denied accessing the socket ${state.socketPath} — check the socket file's ownership/mode (chmod/chown) or the socketPath setting.`,
        actions: [EDIT_SETTING, OPEN_LOGS],
      };
    case "connecting":
    case "starting-gateway":
      return {
        level: "info",
        message: `Still connecting to ${state.socketPath}…`,
        actions: [RECONNECT, OPEN_LOGS],
      };
    case "idle":
      return {
        level: "warn",
        message: "Nimbus hasn't connected to the Gateway yet.",
        actions: [RECONNECT, OPEN_LOGS],
      };
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run test -- troubleshooter`
Expected: PASS.

- [ ] **Step 5: Wire the command in `extension.ts`**

Add the import (near the other `connection/` imports):

```ts
import { buildTroubleshooter } from "./connection/troubleshooter.js";
```

Register the command alongside the other `register(...)` calls (e.g. near `nimbus.reconnect`, ~line 659):

```ts
  register("nimbus.troubleshootConnection", async () => {
    const report = buildTroubleshooter(connection.current(), {
      autoStartGateway: settings.autoStartGateway(),
      platform: process.platform,
    });
    const labels = report.actions.map((a) => a.label);
    const opts = { modal: true };
    const choice =
      report.level === "error"
        ? await deps.window.showErrorMessage(report.message, opts, ...labels)
        : report.level === "warn"
          ? await deps.window.showWarningMessage(report.message, opts, ...labels)
          : await deps.window.showInformationMessage(report.message, opts, ...labels);
    const action = report.actions.find((a) => a.label === choice);
    if (action === undefined) return;
    await deps.commands.executeCommand(action.command, ...(action.args ?? []));
  });
```

> The shim's `showWarningMessage`/`showErrorMessage` were extended to accept an optional `{ modal }` second parameter (backward-compatible — all existing callers pass only a message). The wiring above maps `report.level` to the matching `show{Information,Warning,Error}Message`, so the modal severity now follows the report instead of always showing info.

- [ ] **Step 6: Add the command to `package.json`**

In `contributes.commands`, after the `nimbus.proveEgressWindow` entry (line ~161), add:

```json
      ,{
        "command": "nimbus.troubleshootConnection",
        "title": "Troubleshoot Connection",
        "category": "Nimbus"
      }
```

> Adjust comma placement to keep the array valid (the preceding object needs a trailing comma; JSON has no trailing comma after the last element). The new entry has no menu contribution — it appears in the command palette by default.

- [ ] **Step 7: Run the full local gate**

Run: `bun run test && bun run typecheck && bun run lint && bun run build && bun run check-bundle`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add src/connection/troubleshooter.ts test/unit/troubleshooter.test.ts src/extension.ts package.json
git commit -m "feat(connection): connection troubleshooter modal

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Find related

**Files:**
- Modify: `src/search.ts`, `src/extension.ts`, `package.json`
- Test: `test/unit/search.test.ts`

**Interfaces:**
- Consumes: existing `runSearch` in `extension.ts`, `parseIndexRow`/`IndexItem` from `src/sidebar/index.js`, `searchRanked`, `RankedResult`/`buildPicks` from `src/search.js`.
- Produces: `buildPicks(rawRows, exclude?)` (new optional predicate), `sameName(query): (r: RankedResult) => boolean`; `runSearch(initialValue?, opts?)` with `opts?: { placeholder?: string; exclude?: (r: RankedResult) => boolean }`; commands `nimbus.findRelated`, `nimbus.findRelatedFromIndex`.

- [ ] **Step 1: Write the failing search tests**

In `test/unit/search.test.ts`, add `sameName` to the import from `../../src/search.js`, then add:

```ts
describe("buildPicks exclude predicate", () => {
  test("drops excluded rows and preserves order", () => {
    const rows = [row({ name: "keep A" }), row({ name: "drop me" }), row({ name: "keep B" })];
    const picks = buildPicks(rows, (r) => r.name === "drop me");
    expect(picks.map((p) => p.label)).toEqual(["keep A", "keep B"]);
  });

  test("no predicate keeps current behaviour", () => {
    const rows = [row({ name: "a" }), row({ name: "b" })];
    expect(buildPicks(rows)).toHaveLength(2);
  });
});

describe("sameName", () => {
  test("matches trimmed, case-insensitively", () => {
    const pred = sameName("  Auth Service ");
    expect(pred(parseRankedItem(row({ name: "auth service" })) ?? { name: "", service: "", score: 0 })).toBe(true);
  });

  test("does not match a different name", () => {
    const pred = sameName("auth service");
    expect(pred(parseRankedItem(row({ name: "billing" })) ?? { name: "", service: "", score: 0 })).toBe(false);
  });
});
```

- [ ] **Step 2: Run the search test to verify it fails**

Run: `bun run test -- search`
Expected: FAIL — `sameName` is not exported; `buildPicks` ignores the second argument.

- [ ] **Step 3: Add the exclude predicate and `sameName` to `search.ts`**

In `src/search.ts`, replace `buildPicks` (lines ~100-107):

```ts
// Map rows to picks, dropping malformed rows and any the optional `exclude`
// predicate rejects (used by Find related to drop the item itself). Order preserved.
export function buildPicks(
  rawRows: unknown[],
  exclude?: (r: RankedResult) => boolean,
): SearchPick[] {
  const picks: SearchPick[] = [];
  for (const raw of rawRows) {
    const r = parseRankedItem(raw);
    if (r === undefined) continue;
    if (exclude !== undefined && exclude(r)) continue;
    picks.push(rankedResultToPick(r));
  }
  return picks;
}

// A trimmed, case-insensitive name-equality predicate. Deliberately no
// delimiter/quote stripping — that normalization is unpredictable and risks
// excluding legitimately distinct items. Used by Find related.
export function sameName(query: string): (r: RankedResult) => boolean {
  const q = query.trim().toLowerCase();
  return (r) => r.name.trim().toLowerCase() === q;
}
```

- [ ] **Step 4: Run the search test to verify it passes**

Run: `bun run test -- search`
Expected: PASS.

- [ ] **Step 5: Extend `runSearch` to accept placeholder + exclude**

In `src/extension.ts`, update the `runSearch` signature (line ~454) and its two internal uses:

Change the declaration:

```ts
  const runSearch = (
    initialValue?: string,
    opts?: { placeholder?: string; exclude?: (r: RankedResult) => boolean },
  ): void => {
```

Set the placeholder from opts (replace `qp.placeholder = "Search the local Nimbus index";`, line ~461):

```ts
    qp.placeholder = opts?.placeholder ?? "Search the local Nimbus index";
```

Pass the predicate into `buildPicks` (replace `const picks = buildPicks(rows);`, line ~483):

```ts
        const picks = buildPicks(rows, opts?.exclude);
```

Add `RankedResult` and `sameName` to the `./search.js` import (line ~25):

```ts
import {
  buildPicks,
  normalizeInline,
  type RankedResult,
  sameName,
  type SearchPick,
  statusPick,
} from "./search.js";
```

- [ ] **Step 6: Register the two Find-related commands**

In `src/extension.ts`, after the `nimbus.searchSelection` registration (~line 544), add:

```ts
  register("nimbus.findRelated", () => {
    const editor = deps.window.activeTextEditor;
    const selection =
      editor !== undefined && !editor.selection.isEmpty
        ? editor.document.getText(editor.selection)
        : "";
    if (selection.trim().length === 0) {
      void deps.window.showErrorMessage("Nimbus: select text to find related items.");
      return;
    }
    runSearch(selection, { placeholder: "Related to selection…", exclude: sameName(selection) });
  });

  register("nimbus.findRelatedFromIndex", (...args) => {
    // view/item/context command: args[0] is the tree NODE; the IndexItem rides
    // on node.payload (see itemToRow), mirroring nimbus.askAboutIndexItem.
    const node = args[0];
    const payload =
      typeof node === "object" && node !== null
        ? (node as { payload?: unknown }).payload
        : undefined;
    const item = parseIndexRow(payload);
    if (item === undefined) return;
    const byName = sameName(item.name);
    const exclude = (r: RankedResult): boolean =>
      (item.url !== undefined && r.url === item.url) || byName(r);
    runSearch(item.name, { placeholder: `Related to "${item.name}"…`, exclude });
  });
```

- [ ] **Step 7: Add commands + menus to `package.json`**

In `contributes.commands`, after the new `nimbus.troubleshootConnection` entry (from Task 3), add:

```json
      ,{
        "command": "nimbus.findRelated",
        "title": "Find Related",
        "category": "Nimbus"
      },
      {
        "command": "nimbus.findRelatedFromIndex",
        "title": "Find Related",
        "category": "Nimbus"
      }
```

In `contributes.menus.commandPalette`, add (hide the context-only command from the palette):

```json
        ,{
          "command": "nimbus.findRelatedFromIndex",
          "when": "false"
        }
```

In `contributes.menus["view/item/context"]`, after the `nimbus.askAboutIndexItem` entry, add:

```json
        ,{
          "command": "nimbus.findRelatedFromIndex",
          "when": "view == nimbus.indexView && viewItem == nimbusIndexItem",
          "group": "navigation"
        }
```

In `contributes.menus["editor/context"]`, after the `nimbus.quickAsk` entry (group `nimbus@3`), add:

```json
        ,{
          "command": "nimbus.findRelated",
          "when": "editorHasSelection",
          "group": "nimbus@4"
        }
```

> Keep the JSON arrays valid — the leading `,{` snippets assume they follow an existing last element; verify no doubled or missing commas after pasting.

- [ ] **Step 8: Run the full local gate**

Run: `bun run test && bun run typecheck && bun run lint && bun run build && bun run check-bundle`
Expected: all pass.

- [ ] **Step 9: Commit**

```bash
git add src/search.ts test/unit/search.test.ts src/extension.ts package.json
git commit -m "feat(search): Find related from selection + index item via searchRanked

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Batch verification & runtime drive

**Files:** none (verification only).

- [ ] **Step 1: Full gate on the finished branch**

Run: `bun run test && bun run typecheck && bun run lint && bun run build && bun run check-bundle`
Expected: all green; 4 commits on `feat/phase1-quick-wins`.

- [ ] **Step 2: Drive the runtime surfaces in an Extension Development Host**

Use the `verify-extension` skill. Confirm, against a running Gateway:
- **Egress badge** appears while connected showing `$(shield) N $(check)`; tooltip names the row count + short head + "Verify ledger"; clicking opens the Egress view; toggling `nimbus.egress.showStatusBarBadge` hides/shows it; killing the Gateway hides it (or shows the last-known count with `$(warning)` on a failed poll).
- **Stop:** start a long Ask, click Stop → partial text is kept, `⏹ Stopped` marker appears, Send re-enables, status clears; the Gateway generation actually stops.
- **Troubleshooter:** run **Nimbus: Troubleshoot Connection** while connected and while the Gateway is down → correct message + buttons; buttons dispatch (Start Gateway / Open Logs / Edit socketPath).
- **Find related:** select code → **Find Related** opens the picker seeded with the selection, self-echo excluded; right-click an Index item → **Find Related** opens seeded with its name, the item itself excluded.

- [ ] **Step 3: Hand off to finishing-a-development-branch**

Use `superpowers:finishing-a-development-branch` to open the single PR for the four commits.

---

## Notes for the implementer

- **Do not** repoint the shipped status-bar error commands at the troubleshooter — it is palette-only by design (keeps Task 3 decoupled).
- **Do not** modify `nimbus.searchSelection` — Find related is additive.
- The `$(check)` badge means "ledger head read OK," never a cryptographic verify — keep the tooltip's "run Verify ledger" clause intact.
- `process.platform` is only read in `extension.ts` wiring (Task 3), never in the pure `troubleshooter.ts` module — the platform is injected so the module stays testable across OSes.
- If Biome flags import ordering after edits, run `bun run lint` and apply its ordering (imports are alphabetized within groups).
