import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const manifest = JSON.parse(readFileSync(join(__dirname, "..", "..", "package.json"), "utf8")) as {
  contributes?: { chatParticipants?: Array<{ commands?: Array<{ name: string }> }> };
};

// Stage 2b: the extension stops shipping Copilot's exact three slash commands
// (adjudicated on model quality — the one axis a local-first client cannot win)
// and speaks the ICP's ops vocabulary instead.
describe("extension manifest: chat participant commands", () => {
  const names = (manifest.contributes?.chatParticipants?.[0]?.commands ?? []).map((c) => c.name);

  test("the ops four are declared", () => {
    expect(names).toEqual(["incident", "deploys", "owns", "blast"]);
  });

  test("the Copilot three are gone (they live on as quick-ask presets)", () => {
    for (const old of ["explain", "fix", "test"]) {
      expect(names).not.toContain(old);
    }
  });
});
