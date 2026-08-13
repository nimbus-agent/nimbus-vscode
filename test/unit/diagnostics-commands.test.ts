import { describe, expect, test, vi } from "vitest";
import {
  createDiagnosticCommands,
  type DiagnosticActionArg,
  diagnosticMeta,
} from "../../src/diagnostics/commands.js";
import type { DiagnosticContext } from "../../src/diagnostics/context.js";

const context: DiagnosticContext = {
  fileName: "a.ts",
  languageId: "typescript",
  message: "Object is possibly 'undefined'.",
  severityLabel: "error",
  source: "ts",
  code: "2532",
  startLine: 2,
  endLine: 2,
  snippet: "const x = maybe();\nx.go();",
  truncated: false,
  // 19 is the start of line 2 ("const x = maybe();\n" is 19 chars); 26 is its
  // end. The range MUST cover the trailing ";" — stopping at 25 splices in a
  // replacement that already ends in ";" and leaves the original's behind.
  offsets: { start: 19, end: 26 },
};

const fullText = "const x = maybe();\nx.go();\nmore();";
const arg: DiagnosticActionArg = { context, fullText, query: "2532 Object is possibly" };

function harness(over: Partial<Parameters<typeof createDiagnosticCommands>[0]> = {}) {
  const agentInvoke = vi.fn().mockResolvedValue({ reply: "```ts\nx?.go();\n```" });
  const deps = {
    client: () => ({ agentInvoke }),
    window: {
      showErrorMessage: vi.fn(),
      showInformationMessage: vi.fn(),
      showWarningMessage: vi.fn(),
    } as unknown as Parameters<typeof createDiagnosticCommands>[0]["window"],
    agent: () => "",
    openReadonly: vi.fn().mockResolvedValue(undefined),
    openDiff: vi.fn().mockResolvedValue(undefined),
    search: vi.fn(),
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ...over,
  };
  return { deps, agentInvoke, cmds: createDiagnosticCommands(deps) };
}

describe("diagnosticMeta", () => {
  test("names the redacted file and the line range, and nothing else", () => {
    const meta = diagnosticMeta(context, "Explain Problem");
    expect(meta.action).toBe("Explain Problem");
    expect(meta.files).toEqual([{ name: "a.ts", note: "lines 2-2 around the problem" }]);
    expect(meta.omissions[0]).toContain("rest of the file");
  });

  test("adds a truncation omission when the snippet hit its budget", () => {
    expect(diagnosticMeta({ ...context, truncated: true }, "Suggest Fix").omissions).toHaveLength(
      2,
    );
  });
});

describe("explain", () => {
  test("sends the prompt through the seam and opens the reply read-only", async () => {
    const { cmds, deps, agentInvoke } = harness();
    await cmds.explain(arg);
    expect(agentInvoke).toHaveBeenCalledTimes(1);
    expect(agentInvoke.mock.calls[0]?.[0]).toContain("Object is possibly 'undefined'.");
    expect(deps.openReadonly).toHaveBeenCalledWith("Nimbus explanation.md", expect.any(String));
  });

  test("reports a disconnected Gateway instead of assembling a payload", async () => {
    const { cmds, deps, agentInvoke } = harness({ client: () => undefined });
    await cmds.explain(arg);
    expect(agentInvoke).not.toHaveBeenCalled();
    expect(deps.window.showErrorMessage).toHaveBeenCalledWith("Nimbus: not connected to Gateway.");
  });

  test("says so when the agent returns no reply", async () => {
    const agentInvoke = vi.fn().mockResolvedValue({ reply: "   " });
    const { cmds, deps } = harness({ client: () => ({ agentInvoke }) });
    await cmds.explain(arg);
    expect(deps.window.showInformationMessage).toHaveBeenCalled();
    expect(deps.openReadonly).not.toHaveBeenCalled();
  });

  test("stays silent when the user cancels at the pre-flight preview", async () => {
    const { EgressCancelled } = await import("../../src/egress/gated-client.js");
    const agentInvoke = vi.fn().mockRejectedValue(new EgressCancelled());
    const { cmds, deps } = harness({ client: () => ({ agentInvoke }) });
    await cmds.explain(arg);
    expect(deps.window.showErrorMessage).not.toHaveBeenCalled();
    expect(deps.openReadonly).not.toHaveBeenCalled();
  });

  test("reports a thrown failure once, without escaping as a rejection", async () => {
    const agentInvoke = vi.fn().mockRejectedValue(new Error("socket gone"));
    const { cmds, deps } = harness({ client: () => ({ agentInvoke }) });
    await expect(cmds.explain(arg)).resolves.toBeUndefined();
    expect(deps.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining("socket gone"),
    );
  });
});

describe("fix", () => {
  test("splices the replacement in and diffs against the real file", async () => {
    const { cmds, deps } = harness();
    await cmds.fix(arg);
    expect(deps.openDiff).toHaveBeenCalledWith({
      title: "a.ts ↔ Nimbus fix",
      left: fullText,
      right: "const x = maybe();\nx?.go();\nmore();",
      fileName: "a.ts",
    });
  });

  test("diffs whole-file rather than splicing when the reply is the whole file", async () => {
    const whole = "const x = maybe();\nx?.go();\nmore();";
    const agentInvoke = vi.fn().mockResolvedValue({ reply: `\`\`\`ts\n${whole}\n\`\`\`` });
    const { cmds, deps } = harness({ client: () => ({ agentInvoke }) });
    await cmds.fix(arg);
    expect(deps.openDiff).toHaveBeenCalledWith(expect.objectContaining({ right: whole }));
  });

  test("never applies an edit — the diff is the whole output", async () => {
    const { cmds, deps } = harness();
    await cmds.fix(arg);
    expect(Object.keys(deps)).not.toContain("applyEdit");
  });
});

describe("priorOccurrences", () => {
  test("seeds the search picker with the normalized query", async () => {
    const { cmds, deps, agentInvoke } = harness();
    await cmds.priorOccurrences(arg);
    expect(deps.search).toHaveBeenCalledWith("2532 Object is possibly");
    expect(agentInvoke).not.toHaveBeenCalled();
  });

  test("ignores a malformed argument rather than throwing", async () => {
    const { cmds, deps } = harness();
    await cmds.priorOccurrences({ nope: true });
    expect(deps.search).not.toHaveBeenCalled();
  });
});
