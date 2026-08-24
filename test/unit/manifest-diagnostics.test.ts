import { describe, expect, test } from "vitest";

import { DIAGNOSTIC_COMMANDS } from "../../src/diagnostics/actions.js";
import {
  commands,
  contributes,
  palette,
  configProperties as properties,
} from "./helpers/manifest.js";

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
    expect(Array.isArray(contributes.codeActions)).toBe(true);
    expect(JSON.stringify(contributes.codeActions)).toContain("quickfix.nimbus");
  });
});
