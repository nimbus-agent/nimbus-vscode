import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

type LmToolEntry = {
  name: string;
  displayName?: string;
  modelDescription?: string;
  userDescription?: string;
  canBeReferencedInPrompt?: boolean;
  toolReferenceName?: string;
  tags?: string[];
  inputSchema?: { type?: string; required?: string[]; properties?: Record<string, unknown> };
};

const manifest = JSON.parse(readFileSync(join(__dirname, "..", "..", "package.json"), "utf8")) as {
  contributes?: { languageModelTools?: LmToolEntry[] };
};

function toolNamed(name: string): LmToolEntry | undefined {
  return (manifest.contributes?.languageModelTools ?? []).find((t) => t.name === name);
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
