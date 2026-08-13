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

// The un-redacted local path. It identifies the document for the staleness
// re-read and nothing else — the assertions below pin that it never appears in
// a prompt or a manifest.
const documentPath = "/home/dev/repo/src/a.ts";
const arg: DiagnosticActionArg = {
  context,
  documentPath,
  fullText,
  query: "2532 Object is possibly",
};

// A path -> text map standing in for workspace.textDocuments. Anything not in
// the map is "no open document has that path", which the fix path refuses on.
function documents(open: Record<string, string>): (path: string) => string | undefined {
  return (path) => open[path];
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
    textOfDocument: documents({ [documentPath]: fullText }),
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
    await cmds.fix({ context: subToken, documentPath, fullText, query: "2532 Object is possibly" });
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
  //
  // The edit is applied WHILE the agentInvoke promise is pending, which is the
  // whole point: at the moment the request went out the document still matched.
  // Read the liveness check before the call instead of after and this test
  // fails, because "unchanged then, changed now" is exactly the window the
  // guard exists to cover.
  test("refuses to diff when the file changed while the request was in flight", async () => {
    let release: (value: unknown) => void = () => undefined;
    const agentInvoke = vi.fn(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    let live = fullText;
    const { cmds, deps } = harness({
      client: () => ({ agentInvoke }),
      textOfDocument: (path) => (path === documentPath ? live : undefined),
    });

    const pending = cmds.fix(arg);
    // Let the handler run up to its await; the document is still untouched.
    await Promise.resolve();
    expect(agentInvoke).toHaveBeenCalledTimes(1);

    // The user edits the file while the agent is still thinking.
    live = "const x = maybe();\n// edited\nx.go();";
    release({ reply: "```ts\nx?.go();\n```" });
    await pending;

    expect(deps.openDiff).not.toHaveBeenCalled();
    expect(deps.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining("changed while the fix was being generated"),
    );
  });

  test("diffs as usual when the live document still matches the snapshot", async () => {
    const { cmds, deps } = harness();
    await cmds.fix(arg);
    expect(deps.openDiff).toHaveBeenCalled();
    expect(deps.window.showWarningMessage).not.toHaveBeenCalled();
  });

  // Focus is not identity: the user moving to another tab must not decide
  // whether the check can run. The lookup is by path, so an open-but-unfocused
  // source document still resolves and the diff opens as normal.
  test("resolves the source document even when another file has focus", async () => {
    const { cmds, deps } = harness({
      textOfDocument: documents({
        [documentPath]: fullText,
        "/home/dev/repo/src/elsewhere.ts": "something else entirely",
      }),
    });
    await cmds.fix(arg);
    expect(deps.openDiff).toHaveBeenCalled();
    expect(deps.window.showWarningMessage).not.toHaveBeenCalled();
  });

  // The old check compared redacted BASENAMES, so test/a.ts and src/a.ts were
  // the same file. Matching on the full local path keeps them apart: the
  // unrelated same-named document must not be mistaken for the source.
  test("does not confuse a same-named file in another directory", async () => {
    const { cmds, deps } = harness({
      textOfDocument: documents({
        [documentPath]: fullText,
        "/home/dev/repo/test/a.ts": "a completely different a.ts",
      }),
    });
    await cmds.fix(arg);
    expect(deps.openDiff).toHaveBeenCalled();
    expect(deps.window.showWarningMessage).not.toHaveBeenCalled();
  });

  // Refusing, not proceeding: a diff we cannot check against the file it claims
  // to change is the unsafe direction, and it is the direction the old
  // active-editor check defaulted to.
  test("refuses to diff when the source document cannot be re-read", async () => {
    const { cmds, deps } = harness({ textOfDocument: documents({}) });
    await cmds.fix(arg);
    expect(deps.openDiff).not.toHaveBeenCalled();
    expect(deps.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining("could not be re-read"),
    );
  });

  // documentPath is local-lookup identity, nothing more. A directory in an
  // agent prompt is precisely what redactPath exists to prevent, and the
  // manifest must describe what actually leaves.
  test("never lets the local path reach the prompt or the egress manifest", async () => {
    const { cmds, agentInvoke } = harness();
    await cmds.fix(arg);
    const call = agentInvoke.mock.calls[0] ?? [];
    expect(String(call[0])).not.toContain("/home/dev/repo");
    expect(JSON.stringify(call[2])).not.toContain("/home/dev/repo");
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
