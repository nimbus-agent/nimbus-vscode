# Agents View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Agents sidebar scaffold with a live view driven by a new `nimbus.agents` setting, where clicking an agent opens the chat panel in a fresh conversation scoped to that agent.

**Architecture:** A pure module (`src/sidebar/agents.ts`) owns the agent data shape and row projection; `src/sidebar/agents-view.ts` becomes a real `createDataView`; the composition root (`src/extension.ts`) owns the settings coupling, a mutable `activeAgent` override, the `nimbus.openAgentChat` command, and the New-Conversation reset. Source of truth is local VS Code settings, so no Gateway is needed for development.

**Tech Stack:** TypeScript (strict, no `any`), VS Code extension API via `src/vscode-shim.ts`, Vitest unit tests (`vscode` aliased to a stub), Biome lint, esbuild bundle, bun scripts.

## Global Constraints

- TypeScript **strict**; **no `any`** — use `unknown` for external data. (biome `noExplicitAny`)
- Never use `console` in `src/` — log via the output channel. (biome `noConsole`)
- No non-null assertions (`!`). (biome `noNonNullAssertion`)
- `tsconfig` uses `exactOptionalPropertyTypes`: never assign `undefined` to an optional field — build objects with conditional spreads (see `itemToRow` in `src/sidebar/index.ts`).
- Only touch the `vscode` API through `src/vscode-shim.ts`; keep `src/sidebar/*` pure where it already is.
- New Gateway capability is out of scope — agents come from settings, not the client.
- Run the full gate before claiming done: `bun run typecheck && bun run lint && bun run test && bun run build && bun run check-bundle`.

---

### Task 1: Pure `agents.ts` module (`parseAgents`, `agentsToRows`)

**Files:**
- Create: `src/sidebar/agents.ts`
- Test: `test/unit/agents.test.ts`

**Interfaces:**
- Consumes: `SidebarItem` from `src/sidebar/tree-view.js`.
- Produces:
  - `interface Agent { id: string; label: string; description?: string }`
  - `parseAgents(raw: unknown): Agent[]`
  - `agentsToRows(agents: Agent[], activeAgentId?: string): SidebarItem[]`

- [ ] **Step 1: Write the failing test**

Create `test/unit/agents.test.ts`:

```ts
import { describe, expect, test } from "vitest";

import { type Agent, agentsToRows, parseAgents } from "../../src/sidebar/agents.js";

describe("parseAgents", () => {
  test("reads id/label/description; label falls back to id", () => {
    expect(
      parseAgents([
        { id: "researcher", label: "Researcher", description: "Deep web research" },
        { id: "coder" },
      ]),
    ).toEqual([
      { id: "researcher", label: "Researcher", description: "Deep web research" },
      { id: "coder", label: "coder" },
    ]);
  });

  test("drops entries without a usable id", () => {
    expect(parseAgents([{ label: "no id" }, { id: "" }, { id: "ok" }])).toEqual([
      { id: "ok", label: "ok" },
    ]);
  });

  test("non-array / non-object inputs yield []", () => {
    expect(parseAgents(undefined)).toEqual([]);
    expect(parseAgents("nope")).toEqual([]);
    expect(parseAgents([null, 5, "x"])).toEqual([]);
  });
});

describe("agentsToRows", () => {
  const agents: Agent[] = [
    { id: "researcher", label: "Researcher", description: "Deep web research" },
    { id: "coder", label: "Coder" },
  ];

  test("projects rows with command, payload, icon and contextValue", () => {
    const rows = agentsToRows(agents);
    expect(rows[0]).toMatchObject({
      label: "Researcher",
      description: "Deep web research",
      tooltip: "Deep web research",
      iconId: "hubot",
      contextValue: "nimbusAgent",
      payload: { id: "researcher" },
      command: { command: "nimbus.openAgentChat" },
    });
    expect(rows[1]?.description).toBeUndefined();
    expect(rows[1]?.tooltip).toBeUndefined();
  });

  test("marks the active agent and leaves others unmarked", () => {
    const rows = agentsToRows(agents, "coder");
    expect(rows[0]?.description).toBe("Deep web research");
    expect(rows[1]?.description).toBe("(active)");
  });

  test("appends (active) to an existing description", () => {
    const rows = agentsToRows(agents, "researcher");
    expect(rows[0]?.description).toBe("Deep web research (active)");
  });

  test("empty input yields no rows", () => {
    expect(agentsToRows([])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run test/unit/agents.test.ts`
Expected: FAIL — cannot resolve `../../src/sidebar/agents.js` (module not found).

- [ ] **Step 3: Write minimal implementation**

Create `src/sidebar/agents.ts`:

```ts
import type { SidebarItem } from "./tree-view.js";

// One configurable agent from the nimbus.agents setting. We own this type; it is
// projected from the untrusted setting value, not the SDK.
export interface Agent {
  id: string;
  label: string;
  description?: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

// Coerce the untrusted nimbus.agents setting value into Agents. Non-array input
// yields []; entries that are not objects or lack a non-empty id are dropped;
// label falls back to id.
export function parseAgents(raw: unknown): Agent[] {
  if (!Array.isArray(raw)) return [];
  const agents: Agent[] = [];
  for (const entry of raw) {
    const rec = asRecord(entry);
    if (rec === undefined) continue;
    const id = asNonEmptyString(rec["id"]);
    if (id === undefined) continue;
    const agent: Agent = { id, label: asNonEmptyString(rec["label"]) ?? id };
    const description = asNonEmptyString(rec["description"]);
    if (description !== undefined) agent.description = description;
    agents.push(agent);
  }
  return agents;
}

// Project Agents into sidebar rows. The row whose id === activeAgentId gets an
// "(active)" marker appended to its description so the current scope is visible.
// Conditional spreads keep us clear of exactOptionalPropertyTypes.
export function agentsToRows(agents: Agent[], activeAgentId?: string): SidebarItem[] {
  return agents.map((agent) => {
    const isActive = activeAgentId !== undefined && agent.id === activeAgentId;
    const base = agent.description ?? "";
    const description = isActive ? (base.length > 0 ? `${base} (active)` : "(active)") : base;
    return {
      label: agent.label,
      iconId: "hubot",
      contextValue: "nimbusAgent",
      payload: agent,
      command: {
        command: "nimbus.openAgentChat",
        title: "Open Agent Chat",
        arguments: [agent],
      },
      ...(description.length > 0 ? { description } : {}),
      ...(agent.description !== undefined ? { tooltip: agent.description } : {}),
    };
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run test/unit/agents.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/sidebar/agents.ts test/unit/agents.test.ts
git commit -m "feat(sidebar): pure agents module (parseAgents, agentsToRows)"
```

---

### Task 2: `nimbus.agents` setting + `settings.agents()`

**Files:**
- Modify: `package.json` (add the `nimbus.agents` configuration property)
- Modify: `src/settings.ts` (add `agents()` to the interface + implementation)
- Test: `test/unit/settings.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `Settings.agents(): unknown` — returns the raw configured `nimbus.agents` value (default `[]`) for `parseAgents` to coerce.

- [ ] **Step 1: Write the failing test**

In `test/unit/settings.test.ts`, add an assertion to the existing "returns defaults when keys absent" test (after the `askAgent` line):

```ts
    expect(s.agents()).toEqual([]);
```

Add `agents` to the config object in the existing "returns user-set values" test and assert it (after the `askAgent` line):

```ts
        agents: [{ id: "a", label: "A" }],
```
```ts
    expect(s.agents()).toEqual([{ id: "a", label: "A" }]);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run test/unit/settings.test.ts`
Expected: FAIL — `s.agents is not a function`.

- [ ] **Step 3a: Implement `settings.agents()`**

In `src/settings.ts`, add to the `Settings` interface (after `askAgent(): string;`):

```ts
  agents(): unknown;
```

And to the returned object in `createSettings` (after the `askAgent:` line):

```ts
    agents: () => cfg().get<unknown>("agents", []),
```

- [ ] **Step 3b: Declare the setting in `package.json`**

In `contributes.configuration.properties`, add this property immediately after the `nimbus.askAgent` block (insert a comma after that block's closing `}`):

```json
        "nimbus.agents": {
          "type": "array",
          "default": [],
          "description": "Agents shown in the Agents sidebar view. Each item: { \"id\": string, \"label\": string, \"description\"?: string }. Clicking one opens a chat scoped to that agent.",
          "items": {
            "type": "object",
            "required": ["id"],
            "properties": {
              "id": { "type": "string" },
              "label": { "type": "string" },
              "description": { "type": "string" }
            }
          }
        }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run test/unit/settings.test.ts`
Expected: PASS.

Also confirm the manifest is valid JSON:
Run: `node -e "JSON.parse(require('fs').readFileSync('package.json','utf8')); console.log('package.json OK')"`
Expected: `package.json OK`

- [ ] **Step 5: Commit**

```bash
git add src/settings.ts package.json test/unit/settings.test.ts
git commit -m "feat(settings): add nimbus.agents setting"
```

---

### Task 3: Live `agents-view.ts`

**Files:**
- Modify: `src/sidebar/agents-view.ts` (replace the placeholder scaffold)
- Test: `test/unit/sidebar-views.test.ts` (replace the agents scaffold test)

**Interfaces:**
- Consumes: `Agent`, `agentsToRows` from `src/sidebar/agents.js`; `createDataView`, `SidebarConnection`, `SidebarView` from `src/sidebar/tree-view.js`.
- Produces: `createAgentsView(deps: { connection: SidebarConnection; loadAgents: () => Agent[]; activeAgentId: () => string | undefined }): SidebarView`.

- [ ] **Step 1: Write the failing test**

In `test/unit/sidebar-views.test.ts`, replace the entire `describe("scaffold view factories", ...)` block (the one whose single test is "the agents placeholder view exposes its connected empty label") with:

```ts
describe("createAgentsView", () => {
  const connected: ConnectionState = { kind: "connected", socketPath: "/s" };

  test("shows the empty label when no agents are configured", async () => {
    const view = createAgentsView({
      connection: makeConnection(connected).connection,
      loadAgents: () => [],
      activeAgentId: () => undefined,
    });
    expect((await view.getChildren())[0]?.label).toMatch(/no agents configured/i);
  });

  test("renders configured agents as clickable rows", async () => {
    const view = createAgentsView({
      connection: makeConnection(connected).connection,
      loadAgents: () => [{ id: "researcher", label: "Researcher" }],
      activeAgentId: () => undefined,
    });
    const [row] = await view.getChildren();
    expect(row?.label).toBe("Researcher");
    expect(row?.command?.command).toBe("nimbus.openAgentChat");
    expect(row?.description).toBeUndefined();
  });

  test("marks the active agent", async () => {
    const view = createAgentsView({
      connection: makeConnection(connected).connection,
      loadAgents: () => [{ id: "researcher", label: "Researcher" }],
      activeAgentId: () => "researcher",
    });
    const [row] = await view.getChildren();
    expect(row?.description).toBe("(active)");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run test/unit/sidebar-views.test.ts`
Expected: FAIL — `createAgentsView` is called with `loadAgents`/`activeAgentId` the current signature does not accept (type error / the live behavior is missing).

- [ ] **Step 3: Write the implementation**

Replace the entire contents of `src/sidebar/agents-view.ts` with:

```ts
import { type Agent, agentsToRows } from "./agents.js";
import { createDataView, type SidebarConnection, type SidebarView } from "./tree-view.js";

// Agent runner (design surface #3). Renders the agents configured in the
// nimbus.agents setting; clicking one opens a chat scoped to that agent. The
// settings-coupled `loadAgents` and the `activeAgentId` getter are injected from
// the composition root, keeping this view pure.
export function createAgentsView(deps: {
  connection: SidebarConnection;
  loadAgents: () => Agent[];
  activeAgentId: () => string | undefined;
}): SidebarView {
  return createDataView({
    connection: deps.connection,
    loadData: async () => {
      const agents = deps.loadAgents();
      if (agents.length === 0) return [{ label: "No agents configured" }];
      return agentsToRows(agents, deps.activeAgentId());
    },
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run test/unit/sidebar-views.test.ts`
Expected: PASS. (`createPlaceholderView` stays in `tree-view.ts` — its own describe block still covers it.)

- [ ] **Step 5: Commit**

```bash
git add src/sidebar/agents-view.ts test/unit/sidebar-views.test.ts
git commit -m "feat(sidebar): live Agents view from nimbus.agents setting"
```

---

### Task 4: Wire the Agents view into `extension.ts`

**Files:**
- Modify: `src/extension.ts` (import, `activeAgent` holder, agent callback override, named `agentsView`, config-change refresh, stale comment)
- Test: `test/unit/extension.test.ts`

**Interfaces:**
- Consumes: `createAgentsView` (Task 3); `parseAgents`, `Agent` (Task 1); `settings.agents()` (Task 2).
- Produces (module-internal, used by Task 5): a mutable `activeAgent: string | undefined`; a named `agentsView` view; the chat agent callback resolves `() => activeAgent ?? settings.askAgent()`.

- [ ] **Step 1: Write the failing test**

In `test/unit/extension.test.ts`, add inside the `describe("activateWithDeps", ...)` block:

```ts
  test("the registered agents provider renders configured agents from settings", async () => {
    const f = makeFixture({
      cfg: { agents: [{ id: "researcher", label: "Researcher", description: "Deep research" }] },
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    const provider = f.treeProviders.get("nimbus.agentsView");
    if (provider === undefined) throw new Error("agents provider not registered");
    const rows = await provider.getChildren(undefined);
    expect(rows[0]).toMatchObject({ label: "Researcher", iconPath: expect.anything() });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run test/unit/extension.test.ts -t "renders configured agents"`
Expected: FAIL — the provider renders the `"No agents configured"` placeholder (the scaffold ignores the setting), so the row label is not `"Researcher"`.

- [ ] **Step 3a: Import the agents module**

In `src/extension.ts`, add a new import near the other `./sidebar/*` imports (the `createAgentsView` import already exists and is unchanged):

```ts
import { type Agent, parseAgents } from "./sidebar/agents.js";
```

- [ ] **Step 3b: Add the `activeAgent` holder and override the agent callback**

Near the existing `let chatController` declaration inside `activateWithDeps`, add:

```ts
  let activeAgent: string | undefined;
```

In `ensureChatController`, change the `createChatController({ ... })` call's agent line from:

```ts
      agent: () => settings.askAgent(),
```
to:
```ts
      agent: () => activeAgent ?? settings.askAgent(),
```

- [ ] **Step 3c: Create a named `agentsView` and wire it into the views array**

Find the sidebar views block (where `auditView`, `sessionsView`, `indexView` are created and the `sidebarViews` array is built). Add, alongside the other `const ...View =` declarations:

```ts
  const loadAgents = (): Agent[] => parseAgents(settings.agents());
  const agentsView = createAgentsView({
    connection,
    loadAgents,
    activeAgentId: () => activeAgent,
  });
```

Then change the `sidebarViews` array entry for agents from:

```ts
    ["nimbus.agentsView", createAgentsView({ connection })],
```
to:
```ts
    ["nimbus.agentsView", agentsView],
```

- [ ] **Step 3d: Refresh the view on `nimbus.agents` changes and fix the stale comment**

Replace the existing `cfgSub` block:

```ts
  const cfgSub = deps.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration("nimbus")) renderStatusBar(connection.current());
  });
```
with:
```ts
  const cfgSub = deps.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration("nimbus")) renderStatusBar(connection.current());
    if (e.affectsConfiguration("nimbus.agents")) agentsView.refresh();
  });
```

Update the stale sidebar comment (above the `auditView` creation) from:

```ts
  // Sidebar tree views (design surfaces #1/#3/#5/#6). The Audit view (#1) is
  // live; the rest are scaffolds. Each refreshes off connection state and
  // degrades gracefully when the Gateway is unreachable.
```
to:
```ts
  // Sidebar tree views (design surfaces #1/#3/#5/#6). All four are live (Audit,
  // Agents, Index, Sessions). Each refreshes off connection state and degrades
  // gracefully when the Gateway is unreachable.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run test/unit/extension.test.ts -t "renders configured agents"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/extension.ts test/unit/extension.test.ts
git commit -m "feat(sidebar): wire live Agents view + activeAgent override"
```

---

### Task 5: `nimbus.openAgentChat` command + New-Conversation reset

**Files:**
- Modify: `src/extension.ts` (register `nimbus.openAgentChat`; reset `activeAgent` in `nimbus.newConversation`)
- Modify: `package.json` (declare the command; hide it from the command palette)
- Test: `test/unit/extension.test.ts`

**Interfaces:**
- Consumes: `activeAgent`, `agentsView`, `ensureChatController`, `chatPanelFactory`, `parseAgents` (Tasks 1 & 4).
- Produces: command `nimbus.openAgentChat` (sets `activeAgent`, starts a new conversation, reveals the panel, refreshes the view); `nimbus.newConversation` additionally clears `activeAgent` and refreshes the view.

- [ ] **Step 1: Write the failing tests**

In `test/unit/extension.test.ts`, add:

```ts
  test("nimbus.openAgentChat scopes the next stream to the clicked agent", async () => {
    const askStream = doneAskStream();
    const f = makeFixture({
      cfg: { askAgent: "default-agent" },
      openClient: makeFakeClient({ askStream } as unknown as Partial<ClientLike>),
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await cmd(f, "nimbus.openAgentChat")({
      label: "Researcher",
      contextValue: "nimbusAgent",
      payload: { id: "researcher", label: "Researcher" },
    });
    // A new conversation was started; now send a message and inspect the agent.
    for (const h of f.webviewMessageHandlers) h({ type: "submitAsk", text: "hi" });
    await waitForConnect();
    const opts = askStream.mock.calls[0]?.[1] as { agent?: string } | undefined;
    expect(opts?.agent).toBe("researcher");
  });

  test("nimbus.openAgentChat is a no-op for a node without an agent payload", async () => {
    const askStream = doneAskStream();
    const f = makeFixture({
      openClient: makeFakeClient({ askStream } as unknown as Partial<ClientLike>),
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await cmd(f, "nimbus.openAgentChat")({ label: "x" });
    for (const h of f.webviewMessageHandlers) h({ type: "submitAsk", text: "hi" });
    await waitForConnect();
    const opts = askStream.mock.calls[0]?.[1] as { agent?: string } | undefined;
    expect(opts?.agent).toBeUndefined();
  });

  test("nimbus.newConversation clears the active agent back to the default", async () => {
    const askStream = doneAskStream();
    const f = makeFixture({
      cfg: { askAgent: "default-agent" },
      openClient: makeFakeClient({ askStream } as unknown as Partial<ClientLike>),
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await cmd(f, "nimbus.openAgentChat")({ payload: { id: "researcher", label: "Researcher" } });
    await cmd(f, "nimbus.newConversation")();
    for (const h of f.webviewMessageHandlers) h({ type: "submitAsk", text: "hi" });
    await waitForConnect();
    const opts = askStream.mock.calls[0]?.[1] as { agent?: string } | undefined;
    expect(opts?.agent).toBe("default-agent");
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bunx vitest run test/unit/extension.test.ts -t "openAgentChat"`
Expected: FAIL — `command nimbus.openAgentChat not registered`.

- [ ] **Step 3a: Register the command and add the reset**

In `src/extension.ts`, add a new command registration near the other index/session command registrations (e.g. just after the `nimbus.askAboutIndexItem` registration):

```ts
  register("nimbus.openAgentChat", async (...args) => {
    // The Agents view row's primary command. VS Code passes the tree NODE
    // element (a SidebarItem); the Agent rides on node.payload (see
    // agentsToRows). Re-validate it through parseAgents (single-element array).
    const node = args[0];
    const payload =
      typeof node === "object" && node !== null
        ? (node as { payload?: unknown }).payload
        : undefined;
    const [agent] = parseAgents([payload]);
    if (agent === undefined) return;
    activeAgent = agent.id;
    const ctl = ensureChatController();
    if (ctl === undefined) return;
    await ctl.newConversation();
    chatPanelFactory.current()?.reveal();
    agentsView.refresh();
  });
```

Update the existing `nimbus.newConversation` registration from:

```ts
  register("nimbus.newConversation", async () => {
    const ctl = ensureChatController();
    if (ctl === undefined) return;
    await ctl.newConversation();
  });
```
to:
```ts
  register("nimbus.newConversation", async () => {
    const ctl = ensureChatController();
    if (ctl === undefined) return;
    activeAgent = undefined;
    await ctl.newConversation();
    agentsView.refresh();
  });
```

- [ ] **Step 3b: Declare the command in `package.json`**

In `contributes.commands`, add after the `nimbus.askAboutIndexItem` command object (insert a comma after its closing `}`):

```json
      {
        "command": "nimbus.openAgentChat",
        "title": "Open Agent Chat",
        "category": "Nimbus"
      }
```

In `contributes.menus.commandPalette`, add after the `nimbus.askAboutIndexItem` entry (insert a comma after its closing `}`):

```json
        {
          "command": "nimbus.openAgentChat",
          "when": "false"
        }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bunx vitest run test/unit/extension.test.ts -t "openAgentChat"`
Expected: PASS (3 tests).

Confirm the manifest is still valid JSON:
Run: `node -e "JSON.parse(require('fs').readFileSync('package.json','utf8')); console.log('package.json OK')"`
Expected: `package.json OK`

- [ ] **Step 5: Commit**

```bash
git add src/extension.ts package.json test/unit/extension.test.ts
git commit -m "feat(sidebar): nimbus.openAgentChat command + new-conversation reset"
```

---

### Task 6: Full gate + docs

**Files:**
- Modify: `docs/superpowers/specs/2026-06-28-agents-view-design.md` (flip status to Implemented) — optional but keeps the spec honest.

- [ ] **Step 1: Run the full quality gate**

Run: `bun run typecheck && bun run lint && bun run test && bun run build && bun run check-bundle`
Expected: typecheck clean; biome clean; all tests pass; bundle built; `check-bundle: OK`.

- [ ] **Step 2: Fix anything the gate surfaces**

If typecheck/lint/test fail, fix inline and re-run the full gate until green. (Watch for: unused `Agent` import if a task left one dangling; `exactOptionalPropertyTypes` violations — use conditional spreads.)

- [ ] **Step 3: Mark the spec implemented**

In `docs/superpowers/specs/2026-06-28-agents-view-design.md`, change the `**Status:**` line to `Implemented`.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-06-28-agents-view-design.md
git commit -m "docs(sidebar): mark Agents view spec implemented"
```

---

## Self-Review

**Spec coverage:**
- Setting schema (`nimbus.agents`, `{id,label,description?}`) → Task 2 (package.json + settings).
- Pure `parseAgents` / `agentsToRows` with active marker → Task 1.
- Live `agents-view.ts` (empty label + rows + active marker) → Task 3.
- `settings.agents()` injection / `loadAgents` in composition root → Task 4.
- Mutable `activeAgent` + agent callback override → Task 4.
- `nimbus.openAgentChat` (set agent, new conversation, reveal, refresh) → Task 5.
- New-Conversation reset to default + refresh → Task 5.
- Panel reveal via `chatPanelFactory.current()?.reveal()` → Task 5.
- Command-palette hiding → Task 5.
- Refresh on `nimbus.agents` change → Task 4.
- Stale comment fix → Task 4.
- Tests for parse/rows/view/provider/command/reset → Tasks 1,3,4,5.
- Deferred items (per-agent icon, click-to-toggle, built-in discovery) → intentionally absent.

**Placeholder scan:** No TBD/TODO; every code step shows complete code; commands have expected output. ✓

**Type consistency:** `Agent`, `parseAgents`, `agentsToRows(agents, activeAgentId?)`, `createAgentsView({connection, loadAgents, activeAgentId})`, `settings.agents(): unknown`, `activeAgent: string | undefined`, command id `nimbus.openAgentChat`, contextValue `nimbusAgent` — used identically across Tasks 1–5. ✓
