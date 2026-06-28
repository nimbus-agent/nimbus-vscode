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
selected agent stays active for the panel until another is chosen (or the
default `nimbus.askAgent` applies).

The data source is local settings, not the Gateway — so the feature is
developable and testable without a running Gateway.

## Goals

- Render configured agents as clickable sidebar rows.
- Clicking an agent reveals the chat panel, switches the active agent to the
  clicked one, and starts a new conversation.
- Defensive parsing of the user-supplied setting (it is untrusted JSON).
- Refresh the view when `nimbus.agents` changes.

## Non-goals (v1)

- The `client.agentInvoke()` one-shot invocation path.
- Per-agent context menus.
- A UI to revert the active agent back to the `nimbus.askAgent` default.
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

// Project Agents into sidebar rows.
export function agentsToRows(agents: Agent[]): SidebarItem[];
```

Each row produced by `agentsToRows`:

- `label`: agent label
- `description` / `tooltip`: agent description (omitted when absent)
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
}): SidebarView {
  return createDataView({
    connection: deps.connection,
    loadData: async () => {
      const agents = deps.loadAgents();
      if (agents.length === 0) return [{ label: "No agents configured" }];
      return agentsToRows(agents);
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
- Inject `loadAgents: () => parseAgents(settings.agents())` into the view so the
  schema coupling lives in the composition root.
- Introduce a mutable `activeAgent: string | undefined` (default `undefined`).
- Change the chat controller's agent callback from `() => settings.askAgent()`
  to `() => activeAgent ?? settings.askAgent()`.
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
  // Reveal the panel via the chat panel factory's createOrReveal.
});
```

Registered in `package.json` `contributes.commands` and bound as the Agents view
item's primary click (the row `command` above). No `view/item/context` entry in
v1.

> Implementation note: confirm during planning how an already-created chat panel
> is revealed (the `nimbus.ask` / `askAboutIndexItem` paths rely on
> `ensureChatController` / the panel factory's `createOrReveal`); reuse that
> mechanism so `openAgentChat` reveals an existing panel rather than only
> creating one.

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
  -> ensureChatController().newConversation() + reveal
  -> next askStream uses agent = activeAgent
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
    primary command is `nimbus.openAgentChat`, empty input handling.
- `test/unit/extension.test.ts` (extend):
  - The registered `nimbus.agentsView` provider renders configured agents from
    the setting.
  - `nimbus.openAgentChat` sets the active agent and starts a new conversation
    (assert the subsequent stream uses the clicked agent id).

## Stale-comment cleanup

The comment at `extension.ts` ("the Audit view is live; the rest are scaffolds")
is already stale (Sessions and Index are live). Update it to reflect that, after
this change, all four sidebar views are live.
