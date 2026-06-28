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
