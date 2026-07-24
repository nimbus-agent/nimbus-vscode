import { describe, expect, test, vi } from "vitest";

import {
  type LmToolsClientLike,
  type LmToolsDeps,
  runNimbusAskTool,
  runNimbusSearchTool,
} from "../../src/lm-tools/lm-tools.js";

function makeDeps(over: {
  client?: Partial<LmToolsClientLike> | undefined;
  askAgent?: string;
}): LmToolsDeps & { warnings: string[] } {
  const warnings: string[] = [];
  const client =
    over.client === undefined
      ? undefined
      : ({
          searchRanked: async () => [],
          agentInvoke: async () => ({ reply: "" }),
          ...over.client,
        } as LmToolsClientLike);
  return {
    client: () => client,
    askAgent: () => over.askAgent ?? "",
    log: { warn: (m: string) => warnings.push(m) },
    warnings,
  };
}

describe("runNimbusSearchTool", () => {
  test("formats ranked rows as name (service): snippet lines", async () => {
    const searchRanked = vi.fn(async () => [
      // semanticSnippet: the wire field parseRankedItem maps into RankedResult.snippet
      {
        name: "PAY-231 checkout 500s",
        service: "jira",
        score: 9,
        semanticSnippet: "spike after deploy",
      },
      { name: "fix: retry webhook", service: "github", score: 7 },
    ]);
    const out = await runNimbusSearchTool(makeDeps({ client: { searchRanked } }), {
      query: "checkout",
    });
    expect(searchRanked).toHaveBeenCalledWith({ name: "checkout", limit: 8 });
    expect(out).toContain("- PAY-231 checkout 500s (jira): spike after deploy");
    expect(out).toContain("- fix: retry webhook (github)");
  });

  test("clamps limit to 1-20 and defaults to 8", async () => {
    const searchRanked = vi.fn(async () => []);
    const deps = makeDeps({ client: { searchRanked } });
    await runNimbusSearchTool(deps, { query: "x", limit: 999 });
    expect(searchRanked).toHaveBeenLastCalledWith({ name: "x", limit: 20 });
    await runNimbusSearchTool(deps, { query: "x", limit: -3 });
    expect(searchRanked).toHaveBeenLastCalledWith({ name: "x", limit: 1 });
  });

  test("reports an empty result set with the query echoed", async () => {
    const out = await runNimbusSearchTool(makeDeps({ client: {} }), { query: "nothing-here" });
    expect(out).toContain('No matches in the local index for "nothing-here"');
  });

  test("rejects a missing query with a field-naming error string", async () => {
    const out = await runNimbusSearchTool(makeDeps({ client: {} }), { limit: 3 });
    expect(out).toMatch(/query/);
    expect(out).toMatch(/string/i);
  });

  test("explains when the gateway is not connected", async () => {
    const out = await runNimbusSearchTool(makeDeps({ client: undefined }), { query: "x" });
    expect(out).toContain("not connected");
    expect(out).toContain("Start Gateway");
  });

  test("turns a thrown client error into text and logs it", async () => {
    const deps = makeDeps({
      client: {
        searchRanked: async () => {
          throw new Error("boom");
        },
      },
    });
    const out = await runNimbusSearchTool(deps, { query: "x" });
    expect(out).toContain("Nimbus lookup failed: boom");
    expect(deps.warnings).toHaveLength(1);
  });
});

describe("runNimbusAskTool", () => {
  test("returns the agent reply, passing the configured agent", async () => {
    const agentInvoke = vi.fn(async () => ({ reply: "the answer" }));
    const out = await runNimbusAskTool(makeDeps({ client: { agentInvoke }, askAgent: "ops" }), {
      question: "who owns billing?",
    });
    expect(agentInvoke).toHaveBeenCalledWith("who owns billing?", { stream: false, agent: "ops" });
    expect(out).toBe("the answer");
  });

  test("omits the agent option when askAgent is blank", async () => {
    const agentInvoke = vi.fn(async () => ({ reply: "r" }));
    await runNimbusAskTool(makeDeps({ client: { agentInvoke } }), { question: "q" });
    expect(agentInvoke).toHaveBeenCalledWith("q", { stream: false });
  });

  test("substitutes a marker for a missing reply", async () => {
    const agentInvoke = vi.fn(async () => ({}));
    const out = await runNimbusAskTool(makeDeps({ client: { agentInvoke } }), { question: "q" });
    expect(out).toContain("no reply");
  });

  test("rejects a missing question with a field-naming error string", async () => {
    const out = await runNimbusAskTool(makeDeps({ client: {} }), {});
    expect(out).toMatch(/question/);
  });

  test("explains when the gateway is not connected", async () => {
    const out = await runNimbusAskTool(makeDeps({ client: undefined }), { question: "q" });
    expect(out).toContain("not connected");
  });

  test("turns a thrown client error into text and logs it", async () => {
    const deps = makeDeps({
      client: {
        agentInvoke: async () => {
          throw new Error("nope");
        },
      },
    });
    const out = await runNimbusAskTool(deps, { question: "q" });
    expect(out).toContain("Nimbus lookup failed: nope");
    expect(deps.warnings).toHaveLength(1);
  });
});
