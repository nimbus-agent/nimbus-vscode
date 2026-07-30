import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

type CommandEntry = { command: string; title: string; category?: string };

const manifest = JSON.parse(readFileSync(join(__dirname, "..", "..", "package.json"), "utf8")) as {
  contributes?: { commands?: CommandEntry[] };
};

// A command registered in extension.ts but undeclared here is invisible in the
// Command Palette — the only way most people will ever reach these two.
describe("extension manifest: pre-flight commands", () => {
  const declared = manifest.contributes?.commands ?? [];

  for (const [command, title] of [
    ["nimbus.showLastOutbound", "Show Last Outbound Payload"],
    ["nimbus.resetPreflightPrompts", "Reset Egress Preview Prompts"],
  ] as const) {
    test(`${command} is declared under the Nimbus category`, () => {
      const entry = declared.find((c) => c.command === command);
      expect(entry, `${command} must be declared in contributes.commands`).toBeDefined();
      expect(entry?.title).toBe(title);
      expect(entry?.category).toBe("Nimbus");
    });
  }
});
