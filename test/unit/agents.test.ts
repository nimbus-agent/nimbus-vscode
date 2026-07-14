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
