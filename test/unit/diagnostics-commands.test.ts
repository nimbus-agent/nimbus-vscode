import { describe, expect, test, vi } from "vitest";
import {
  createDiagnosticCommands,
  type DiagnosticActionArg,
  diagnosticMeta,
} from "../../src/diagnostics/commands.js";
import { buildDiagnosticContext, type DiagnosticContext } from "../../src/diagnostics/context.js";

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
  // Whole-line offsets, as buildDiagnosticContext produces: 19 is the start of
  // line 2 ("const x = maybe();\n" is 19 chars) and 26 is the offset of its
  // "\n". They must cover the WHOLE line — the model is asked to replace whole
  // lines, so a splice stopping short leaves the rest of the original behind.
  offsets: { start: 19, end: 26 },
};

const fullText = "const x = maybe();\nx.go();\nmore();";
const arg: DiagnosticActionArg = { context, fullText, query: "2532 Object is possibly" };

type WindowDep = Parameters<typeof createDiagnosticCommands>[0]["window"];

// A window whose focused editor holds `text` for `fileName` — the seam the fix
// path reads to notice the buffer moved under it. The default harness window has
// no activeTextEditor, which is the "cannot tell" case.
function editorWindow(fileName: string, text: string): WindowDep {
  return {
    showErrorMessage: vi.fn(),
    showInformationMessage: vi.fn(),
    showWarningMessage: vi.fn(),
    activeTextEditor: {
      document: {
        getText: () => text,
        fileName,
        languageId: "typescript",
        uri: { scheme: "file" },
      },
      selection: { isEmpty: true, active: { line: 0 } },
    },
  } as unknown as WindowDep;
}

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

  // Regression: the fix prompt asks for whole lines, so the splice must consume
  // whole lines. When the offsets tracked the diagnostic's character-exact range
  // instead — which for a TS2532 is just the `x` — splicing the reply produced
  // "x?.go();.go();": the statement went in, the rest of the original line
  // stayed. Sub-token ranges are the norm, not a corner case, and the whole-file
  // guard cannot catch this because it detects the opposite failure.
  test("splices whole lines, so a sub-token diagnostic range cannot duplicate one", async () => {
    const subToken = buildDiagnosticContext({
      fullText,
      fileName: "/home/dev/repo/src/a.ts",
      languageId: "typescript",
      // What tsserver actually reports for TS2532: the flagged expression alone.
      diagnostic: {
        message: "Object is possibly 'undefined'.",
        severity: 0,
        source: "ts",
        code: 2532,
        range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } },
      },
    });
    expect(subToken.offsets).toEqual({ start: 19, end: 26 });

    const { cmds, deps } = harness();
    await cmds.fix({ context: subToken, fullText, query: "2532 Object is possibly" });
    expect(deps.openDiff).toHaveBeenCalledWith(
      expect.objectContaining({ right: "const x = maybe();\nx?.go();\nmore();" }),
    );
  });

  test("diffs whole-file rather than splicing when the reply is the whole file", async () => {
    const whole = "const x = maybe();\nx?.go();\nmore();";
    const agentInvoke = vi.fn().mockResolvedValue({ reply: `\`\`\`ts\n${whole}\n\`\`\`` });
    const { cmds, deps } = harness({ client: () => ({ agentInvoke }) });
    await cmds.fix(arg);
    expect(deps.openDiff).toHaveBeenCalledWith(expect.objectContaining({ right: whole }));
  });

  // fullText is captured when the code action is CREATED. An edit landing while
  // the agent request is in flight makes BOTH sides of the diff stale — the left
  // no longer matches the buffer and the offsets have moved — so the diff would
  // misrepresent the change.
  test("refuses to diff when the file changed while the request was in flight", async () => {
    const { cmds, deps } = harness({
      window: editorWindow("/home/dev/repo/src/a.ts", "const x = maybe();\n// edited\nx.go();"),
    });
    await cmds.fix(arg);
    expect(deps.openDiff).not.toHaveBeenCalled();
    expect(deps.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining("changed while the fix was being generated"),
    );
  });

  test("diffs as usual when the live document still matches the snapshot", async () => {
    const { cmds, deps } = harness({
      window: editorWindow("/home/dev/repo/src/a.ts", fullText),
    });
    await cmds.fix(arg);
    expect(deps.openDiff).toHaveBeenCalled();
    expect(deps.window.showWarningMessage).not.toHaveBeenCalled();
  });

  // "Unknown", not "changed": the user moved to another file while waiting, so
  // the snapshot is the best evidence we have and refusing would be a guess.
  test("proceeds on the snapshot when the focused editor is a different file", async () => {
    const { cmds, deps } = harness({
      window: editorWindow("/home/dev/repo/src/elsewhere.ts", "something else entirely"),
    });
    await cmds.fix(arg);
    expect(deps.openDiff).toHaveBeenCalled();
    expect(deps.window.showWarningMessage).not.toHaveBeenCalled();
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
