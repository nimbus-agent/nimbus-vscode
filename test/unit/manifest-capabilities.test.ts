import { describe, expect, test } from "vitest";

import { manifest, welcome } from "./helpers/manifest.js";

const VIEW_IDS = [
  "nimbus.auditView",
  "nimbus.egressView",
  "nimbus.agentsView",
  "nimbus.indexView",
  "nimbus.sessionsView",
];

// Undeclared, VS Code disables the extension ENTIRELY in a Restricted-Mode
// workspace, with no explanation — a silent bug, not a feature gap. These
// pins keep a future manifest edit from silently reintroducing it.
describe("extension manifest: restricted-mode + remote + welcome declarations", () => {
  test("untrustedWorkspaces is declared as limited with the dangerous settings restricted", () => {
    const uw = manifest.capabilities?.untrustedWorkspaces;
    expect(uw?.supported).toBe("limited");
    expect(uw?.restrictedConfigurations).toEqual(
      expect.arrayContaining(["nimbus.socketPath", "nimbus.autoStartGateway"]),
    );
    expect(typeof uw?.description).toBe("string");
  });

  test("extensionKind pins the extension to the UI host (the gateway is local)", () => {
    expect(manifest.extensionKind).toEqual(["ui"]);
  });

  test("every sidebar view has a not-connected welcome with start/troubleshoot actions", () => {
    const entries = welcome;
    for (const id of VIEW_IDS) {
      const entry = entries.find((e) => e.view === id);
      expect(entry, `viewsWelcome missing for ${id}`).toBeDefined();
      expect(entry?.when).toBe("!nimbus.connected");
      expect(entry?.contents).toContain("command:nimbus.startGateway");
      expect(entry?.contents).toContain("command:nimbus.troubleshootConnection");
    }
  });
});
