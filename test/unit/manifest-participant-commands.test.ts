import { describe, expect, test } from "vitest";

import { contributes } from "./helpers/manifest.js";

// Stage 2b: the extension stops shipping Copilot's exact three slash commands
// (adjudicated on model quality — the one axis a local-first client cannot win)
// and speaks the ICP's ops vocabulary instead.
describe("extension manifest: chat participant commands", () => {
  const names = (contributes.chatParticipants?.[0]?.commands ?? []).map((c) => c.name);

  test("the ops four are declared", () => {
    expect(names).toEqual(["incident", "deploys", "owns", "blast"]);
  });

  test("the Copilot three are gone (they live on as quick-ask presets)", () => {
    for (const old of ["explain", "fix", "test"]) {
      expect(names).not.toContain(old);
    }
  });
});
