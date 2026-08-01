import { describe, expect, test, vi } from "vitest";

import {
  buildAskConfirmation,
  type LmToolsClientLike,
  type LmToolsDeps,
  runNimbusAskTool,
  runNimbusSearchTool,
} from "../../src/lm-tools/lm-tools.js";

// Every agentInvoke on this path now carries the pre-flight manifest.
const ASK_META = { action: "Ask Nimbus", files: [], omissions: [] };

function makeDeps(over: {
  client?: Partial<LmToolsClientLike> | undefined;
  askAgent?: string;
  roots?: readonly string[];
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
    roots: () => over.roots ?? [],
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
    expect(agentInvoke).toHaveBeenCalledWith(
      "who owns billing?",
      { stream: false, agent: "ops" },
      ASK_META,
    );
    expect(out).toBe("the answer");
  });

  test("omits the agent option when askAgent is blank", async () => {
    const agentInvoke = vi.fn(async () => ({ reply: "r" }));
    await runNimbusAskTool(makeDeps({ client: { agentInvoke } }), { question: "q" });
    expect(agentInvoke).toHaveBeenCalledWith("q", { stream: false }, ASK_META);
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

describe("buildAskConfirmation", () => {
  test("describes the question the calling model wants to send", () => {
    const c = buildAskConfirmation({ roots: () => [] }, { question: "why is p99 up?" });
    expect(c?.title).toBe("Send this to the Nimbus agent?");
    expect(c?.message).toContain("Ask Nimbus");
    expect(c?.message).toContain("14 characters");
  });

  test("warns when the calling model quoted an absolute path", () => {
    // The question on this path is written by ANOTHER model, which may well
    // quote a path it read from disk — so the leak check runs here too.
    const c = buildAskConfirmation(
      { roots: () => ["/home/asafg"] },
      { question: "look at /home/asafg/svc/main.go" },
    );
    expect(c?.message).toContain("WARNING");
  });

  test("returns undefined for invalid input, leaving the handler to explain", () => {
    expect(buildAskConfirmation({ roots: () => [] }, { question: "  " })).toBeUndefined();
    expect(buildAskConfirmation({ roots: () => [] }, null)).toBeUndefined();
  });
});

describe("nimbus_ask routes through the gate", () => {
  test("passes a manifest alongside the question", async () => {
    const seen: unknown[] = [];
    const deps = makeDeps({
      client: {
        agentInvoke: async (input: string, options: unknown, meta: unknown) => {
          seen.push({ input, options, meta });
          return { reply: "ok" };
        },
      },
    });
    await runNimbusAskTool(deps, { question: "why is p99 up?" });
    expect(seen).toHaveLength(1);
    expect((seen[0] as { meta: { action: string } }).meta.action).toBe("Ask Nimbus");
  });
});
