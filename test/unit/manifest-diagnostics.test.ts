import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { DIAGNOSTIC_COMMANDS } from "../../src/diagnostics/actions.js";

type Command = { command: string; title: string; category?: string };
type MenuEntry = { command: string; when?: string };

const manifest = JSON.parse(readFileSync(join(__dirname, "..", "..", "package.json"), "utf8")) as {
  contributes?: {
    commands?: Command[];
    menus?: { commandPalette?: MenuEntry[] };
    configuration?: {
      properties?: Record<string, { type?: string; default?: unknown; description?: string }>;
    };
    codeActions?: unknown[];
  };
};

const commands = manifest.contributes?.commands ?? [];
const palette = manifest.contributes?.menus?.commandPalette ?? [];
const properties = manifest.contributes?.configuration?.properties ?? {};
const ids = Object.values(DIAGNOSTIC_COMMANDS);

describe("extension manifest: diagnostic actions", () => {
  test("declares all three commands the code actions reference", () => {
    for (const id of ids) {
      expect(commands.some((c) => c.command === id)).toBe(true);
    }
  });

  test("hides all three from the palette — each needs a diagnostic argument", () => {
    for (const id of ids) {
      expect(palette.some((m) => m.command === id && m.when === "false")).toBe(true);
    }
  });

  test("declares the setting, defaulting on", () => {
    const prop = properties["nimbus.diagnostics.showCodeActions"];
    expect(prop?.type).toBe("boolean");
    expect(prop?.default).toBe(true);
    expect(prop?.description).toBeTruthy();
  });

  test("declares codeActions metadata so the actions are discoverable in settings", () => {
    expect(Array.isArray(manifest.contributes?.codeActions)).toBe(true);
    expect(JSON.stringify(manifest.contributes?.codeActions)).toContain("quickfix.nimbus");
  });
});
