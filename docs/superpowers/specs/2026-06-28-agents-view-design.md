# Agents View Design

**Date:** 2026-06-28
**Status:** Approved (pending spec review)
**Surface:** Sidebar design surface #3 (Agents)

---

## Summary

The Agents sidebar view is currently a scaffold rendering a static
`"No agents configured"` placeholder. This design makes it live: it reads a new
`nimbus.agents` VS Code setting, renders one row per configured agent, and on
click opens the chat panel in a **fresh conversation scoped to that agent**. The
selected agent stays active for the panel until another is chosen, or until a
generic **New Conversation** clears the override back to the `nimbus.askAgent`
default. The active agent is marked in the view (an `(active)` suffix) so the
user always knows which agent is in effect.

The data source is local settings, not the Gateway — so the feature is
developable and testable without a running Gateway.

## Goals

- Render configured agents as clickable sidebar rows.
- Clicking an agent reveals the chat panel, switches the active agent to the
  clicked one, and starts a new conversation.
- A generic New Conversation clears the override back to the `nimbus.askAgent`
  default (the path back to default).
- Mark the active agent in the view so the current scope is visible.
- Defensive parsing of the user-supplied setting (it is untrusted JSON).
- Refresh the view when `nimbus.agents` changes or the active agent changes.

## Non-goals (v1)

- The `client.agentInvoke()` one-shot invocation path.
- Per-agent context menus.
- Click-to-toggle: clicking the already-active agent to clear the override
  (New Conversation already provides the reset — see Deferred).
- Per-agent custom icons in the setting (see Deferred).
- Pre-populating built-in / system agents from the Gateway (see Deferred).
- Editing / adding agents from the UI (configuration is done in settings).

## Setting schema

A new `nimbus.agents` configuration property (type `array`, default `[]`) in
`package.json`. Each item is an object:

```jsonc
"nimbus.agents": [
  { "id": "researcher", "label": "Researcher", "description": "Deep web research" },
  { "id": "coder", "label": "Coder" }
]
```

- `id` (string, required) — passed to the Gateway as the agent name (mirrors how
  `nimbus.askAgent` feeds `askStream`'s `agent` option).
- `label` (string) — row title; falls back to `id` when absent/empty.
- `description` (string, optional) — row description and tooltip.

## Architecture

Follows the established sidebar pattern: a **pure module** owns the data shape
and view-model projection; the **composition root** (`extension.ts`) owns the
schema-coupled load; the **view** stays pure and connection-aware.

### New pure module: `src/sidebar/agents.ts`

```ts
export interface Agent {
  id: string;
  label: string;
  description?: string;
}

// Coerce the untrusted nimbus.agents setting value into Agents. Drops entries
// lacking a non-empty id; label falls back to id.
export function parseAgents(raw: unknown): Agent[];

// Project Agents into sidebar rows. activeAgentId marks the active row.
export function agentsToRows(agents: Agent[], activeAgentId?: string): SidebarItem[];
```

Each row produced by `agentsToRows`:

- `label`: agent label
- `description`: agent description; the active agent's row appends `" (active)"`
  (or just `"(active)"` when it has no description)
- `tooltip`: agent description (omitted when absent)
- `iconId`: `"hubot"` (codicon)
- `contextValue`: `"nimbusAgent"`
- `payload`: the `Agent` (so the click command can recover it from the node)
- `command`: `{ command: "nimbus.openAgentChat", title: "Open Agent Chat", arguments: [agent] }`

`parseAgents` reuses the same defensive coercion idiom as `parseIndexRow` /
`parseSessionRow` (object guard, non-empty-string helper). A single entry can be
re-validated by passing a one-element array (used by the command handler).

### View: `src/sidebar/agents-view.ts`

Replaces the `createPlaceholderView` scaffold with a `createDataView`:

```ts
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

It stays **connection-gated** like its siblings (Audit/Index/Sessions): when not
connected it renders the shared connection placeholder. This is consistent and
acceptable because the click action requires a connection anyway.

### Wiring: `src/extension.ts`

- Add `settings.agents()` to `settings.ts`, returning the raw configured value
  (`unknown[]` / `unknown`) for `parseAgents` to coerce.
- Inject `loadAgents: () => parseAgents(settings.agents())` and
  `activeAgentId: () => activeAgent` into the view so the schema coupling and
  active-state both live in the composition root.
- Introduce a mutable `activeAgent: string | undefined` (default `undefined`).
- Change the chat controller's agent callback from `() => settings.askAgent()`
  to `() => activeAgent ?? settings.askAgent()`.
- In the existing `nimbus.newConversation` command handler, reset
  `activeAgent = undefined` and call `agentsView.refresh()` so a generic new
  conversation returns to the default agent and updates the indicator. (This is
  the only generic-new-conversation path — the webview posts no separate
  new-conversation message.)
- Extend `cfgSub` (`onDidChangeConfiguration`) so a change affecting
  `nimbus.agents` also calls `agentsView.refresh()`.

### Command: `nimbus.openAgentChat`

```ts
register("nimbus.openAgentChat", async (...args) => {
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

Registered in `package.json` `contributes.commands` and bound as the Agents view
item's primary click (the row `command` above). No `view/item/context` entry in
v1.

**Panel reveal (verified):** `ensureChatController` reveals the panel only when
it *creates* it (`chatPanelFactory.createOrReveal()`). For an already-open panel,
reveal explicitly via `chatPanelFactory.current()?.reveal()` — the same pattern
used by `nimbus.showPendingHitl`.

**Command palette (verified convention):** add a `menus.commandPalette` entry
hiding `nimbus.openAgentChat` (`"when": "false"`), matching the existing
payload-only commands (`openIndexItem`, `askAboutIndexItem`, `openSession`,
`openAuditEntry`). The command is meaningless without a node payload.

## Data flow

```
nimbus.agents setting
  -> settings.agents()            (extension.ts, raw unknown)
  -> parseAgents(raw)             (agents.ts, -> Agent[])
  -> createAgentsView.loadData    (agents-view.ts)
  -> agentsToRows                 (-> SidebarItem[])
  -> applyThemeIcons / TreeView   (rendered)

click row
  -> nimbus.openAgentChat(node)   (extension.ts)
  -> parseAgents([node.payload])  (recover Agent)
  -> activeAgent = agent.id
  -> ensureChatController().newConversation()
  -> chatPanelFactory.current()?.reveal()
  -> agentsView.refresh()         (marks the active row)
  -> next askStream uses agent = activeAgent

New Conversation (nimbus.newConversation)
  -> activeAgent = undefined
  -> ctl.newConversation()
  -> agentsView.refresh()         (clears the active marker)
  -> next askStream uses agent = settings.askAgent()
```

## Error handling

- `parseAgents` silently drops malformed entries (no `id`), so a partly-broken
  setting still yields the valid agents rather than failing the whole view.
- `openAgentChat` no-ops when the payload cannot be recovered or no chat client
  is available (mirrors the existing index/session command guards).
- Empty / unset setting renders the `"No agents configured"` row.

## Testing

- `test/unit/agents.test.ts`:
  - `parseAgents`: valid entries; `label` falls back to `id`; entries without a
    usable `id` dropped; non-array / non-object inputs yield `[]`.
  - `agentsToRows`: row shape (label/description/icon/contextValue/payload),
    primary command is `nimbus.openAgentChat`, empty input handling, and the
    `(active)` marker applied only to the matching `activeAgentId` row.
- `test/unit/extension.test.ts` (extend):
  - The registered `nimbus.agentsView` provider renders configured agents from
    the setting.
  - `nimbus.openAgentChat` sets the active agent and starts a new conversation
    (assert the subsequent stream uses the clicked agent id).
  - `nimbus.newConversation` clears the active agent (the subsequent stream falls
    back to `settings.askAgent()`).

## Deferred (with rationale)

These were raised in review and intentionally deferred from v1:

- **Click-to-toggle the active agent off** — New Conversation already provides a
  clean reset path, so a second toggle interaction is redundant (YAGNI).
- **Per-agent `icon` field in the setting** — pure polish; the field is optional
  and additive, so it can be introduced later with no breaking change to
  existing configs.
- **Built-in / system agent discovery** — verified the typed `@nimbus-dev/client`
  exposes no `listAgents`/discovery API (`agent` is only an *input* to
  `agentInvoke`/`askStream`). Pre-populating system agents needs an upstream
  client capability bump; same category as the deferred index auto-refresh.

## Stale-comment cleanup

The comment at `extension.ts` ("the Audit view is live; the rest are scaffolds")
is already stale (Sessions and Index are live). Update it to reflect that, after
this change, all four sidebar views are live.
