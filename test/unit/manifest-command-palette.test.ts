import { describe, expect, test } from "vitest";

import { palette as paletteEntries } from "./helpers/manifest.js";

// Opening the Command Palette moves keyboard focus off the editor, so a
// focus-dependent clause can evaluate false exactly when the palette is being
// filtered — and VS Code then hides the command. `editorIsOpen` asks the
// question that actually matters: is there an editor to act on?
describe("extension manifest: commandPalette when-clauses", () => {
  test("no palette entry gates on keyboard focus", () => {
    const focusGated = paletteEntries
      .filter((e) => e.when?.includes("Focus"))
      .map((e) => `${e.command} (when: ${e.when})`);
    expect(focusGated, "focus-dependent clauses hide the command from the palette").toEqual([]);
  });

  test("nimbus.quickAsk is offered whenever an editor is open", () => {
    const entry = paletteEntries.find((e) => e.command === "nimbus.quickAsk");
    expect(entry, "nimbus.quickAsk must have a commandPalette entry").toBeDefined();
    expect(entry?.when).toBe("editorIsOpen");
  });
});
