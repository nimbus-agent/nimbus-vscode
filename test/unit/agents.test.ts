import { describe, expect, test } from "vitest";

import { BRIEF_CATALOG } from "../../src/briefs/catalog.js";
import { type Agent, agentsToRows, agentsTreeRows, parseAgents } from "../../src/sidebar/agents.js";

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

describe("agentsTreeRows", () => {
  test("renders two labelled groups", () => {
    const rows = agentsTreeRows([{ id: "a", label: "my-reviewer" }]);
    expect(rows.map((r) => r.label)).toEqual(["Built-in briefs", "Configured agents"]);
  });

  test("the built-in group lists every catalog brief and each row runs its command", () => {
    const group = agentsTreeRows([])[0];
    expect(group?.children?.map((c) => c.label)).toEqual(BRIEF_CATALOG.map((b) => b.label));
    for (const [i, child] of (group?.children ?? []).entries()) {
      expect(child.command?.command).toBe(BRIEF_CATALOG[i]?.command);
      // A tree row holds no editor context, so it passes no args and each
      // command falls back to the active editor.
      expect(child.command?.arguments).toBeUndefined();
    }
  });

  test("both groups render collapsible, because both have children", () => {
    const rows = agentsTreeRows([{ id: "a", label: "my-reviewer" }]);
    for (const row of rows) expect((row.children ?? []).length).toBeGreaterThan(0);
  });

  test("with no configured agents the second group keeps settings discoverable", () => {
    const configured = agentsTreeRows([])[1];
    expect(configured?.children?.length).toBe(1);
    expect(configured?.children?.[0]?.label).toBe("Configure agents in settings…");
    expect(configured?.children?.[0]?.command?.command).toBe("workbench.action.openSettings");
  });

  test("configured agents keep their existing chat click and active marker", () => {
    const configured = agentsTreeRows([{ id: "a", label: "my-reviewer" }], "a")[1];
    const row = configured?.children?.[0];
    expect(row?.command?.command).toBe("nimbus.openAgentChat");
    expect(row?.description).toContain("(active)");
  });
});
