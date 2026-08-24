import { describe, expect, test } from "vitest";

import { lmTools, type ManifestLmTool } from "./helpers/manifest.js";

function toolNamed(name: string): ManifestLmTool | undefined {
  return lmTools.find((t) => t.name === name);
}

// The 2d multiplier: Copilot (or any LM extension) can call Nimbus for private
// local context. These pins keep the declared surface aligned with the
// registered handlers in src/lm-tools/.
describe("extension manifest: languageModelTools", () => {
  test("nimbus_search is declared with a required query and an ICP-voiced description", () => {
    const t = toolNamed("nimbus_search");
    expect(t).toBeDefined();
    expect(t?.inputSchema?.required).toEqual(["query"]);
    expect(t?.canBeReferencedInPrompt).toBe(true);
    expect(t?.toolReferenceName).toBe("nimbusSearch");
    expect(t?.modelDescription).toMatch(/local/i);
    expect(t?.modelDescription).toMatch(/private/i);
  });

  test("nimbus_ask is declared with a required question and an ICP-voiced description", () => {
    const t = toolNamed("nimbus_ask");
    expect(t).toBeDefined();
    expect(t?.inputSchema?.required).toEqual(["question"]);
    expect(t?.canBeReferencedInPrompt).toBe(true);
    expect(t?.toolReferenceName).toBe("nimbusAsk");
    expect(t?.modelDescription).toMatch(/local/i);
    expect(t?.modelDescription).toMatch(/private/i);
  });
});
