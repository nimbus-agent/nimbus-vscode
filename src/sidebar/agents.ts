import { BRIEF_CATALOG } from "../briefs/catalog.js";
import { asNonEmptyString, asRecord } from "./parse-helpers.js";
import type { SidebarItem } from "./tree-view.js";

// One configurable agent from the nimbus.agents setting. We own this type; it is
// projected from the untrusted setting value, not the SDK.
export interface Agent {
  id: string;
  label: string;
  description?: string;
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
    let description = base;
    if (isActive) {
      description = base.length > 0 ? `${base} (active)` : "(active)";
    }
    return {
      label: agent.label,
      iconId: "hubot",
      contextValue: "nimbusAgent",
      // payload is reserved for a future view/item/context menu entry and is
      // NOT consumed by the primary-click path — the click uses
      // command.arguments[0] (the bare Agent) which openAgentChat reads
      // directly via parseAgents.
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

// The built-in briefs, as sidebar rows. Rows carry no command arguments: a tree
// row holds no editor context, so each command falls back to the active editor
// exactly as its palette entry does.
export function builtInBriefRows(): SidebarItem[] {
  return BRIEF_CATALOG.map((spec) => ({
    label: spec.label,
    iconId: spec.iconId,
    contextValue: "nimbusBrief",
    tooltip: `Runs agents.${spec.id} on the Nimbus Gateway.`,
    command: { command: spec.command, title: spec.label },
  }));
}

// Two labelled groups, because the view holds two different concepts: one-shot
// brief runs and chat scopes. They behave differently on click, so the tree
// says which is which rather than mixing them into one flat list.
export function agentsTreeRows(agents: Agent[], activeAgentId?: string): SidebarItem[] {
  const configured =
    agents.length > 0
      ? agentsToRows(agents, activeAgentId)
      : [
          {
            label: "Configure agents in settings…",
            iconId: "gear",
            command: {
              command: "workbench.action.openSettings",
              title: "Open Settings",
              arguments: ["nimbus.agents"],
            },
          },
        ];
  return [
    { label: "Built-in briefs", iconId: "hubot", children: builtInBriefRows() },
    { label: "Configured agents", iconId: "account", children: configured },
  ];
}
