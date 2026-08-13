import { describe, expect, test } from "vitest";

import type { DiagnosticContext } from "../../src/diagnostics/context.js";
import { buildExplainPrompt, buildFixPrompt } from "../../src/diagnostics/prompts.js";

const ctx: DiagnosticContext = {
  fileName: "a.ts",
  languageId: "typescript",
  message: "Object is possibly 'undefined'.",
  severityLabel: "error",
  source: "ts",
  code: "2532",
  startLine: 10,
  endLine: 10,
  snippet: "const x = maybe();\nx.go();",
  truncated: false,
  offsets: { start: 18, end: 24 },
};

describe("buildExplainPrompt", () => {
  test("states the diagnostic, where it is, and fences the snippet", () => {
    const p = buildExplainPrompt(ctx);
    expect(p).toContain("Object is possibly 'undefined'.");
    expect(p).toContain("ts 2532");
    expect(p).toContain("a.ts");
    expect(p).toContain("line 10");
    expect(p).toContain("```typescript\nconst x = maybe();\nx.go();\n```");
  });

  test("asks for an explanation, not a rewrite", () => {
    expect(buildExplainPrompt(ctx).toLowerCase()).toContain("explain");
  });

  test("names a line range when the diagnostic spans lines", () => {
    expect(buildExplainPrompt({ ...ctx, endLine: 14 })).toContain("lines 10-14");
  });

  test("marks a truncated snippet so the reply knows it saw part of the file", () => {
    expect(buildExplainPrompt({ ...ctx, truncated: true })).toContain("truncated");
  });

  test("omits the source/code clause when the diagnostic carries neither", () => {
    const p = buildExplainPrompt({ ...ctx, source: "", code: "" });
    expect(p).not.toContain("()");
    expect(p).toContain("Object is possibly 'undefined'.");
  });
});

describe("buildFixPrompt", () => {
  test("asks for the replacement region only, in a fenced block", () => {
    const p = buildFixPrompt(ctx);
    expect(p).toContain("```typescript");
    expect(p.toLowerCase()).toContain("replacement");
  });

  test("tells the agent not to explain, so extractCode gets a clean block", () => {
    expect(buildFixPrompt(ctx).toLowerCase()).toContain("no prose");
  });
});
