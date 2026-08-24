import { describe, expect, test } from "vitest";

import { BRIEF_CATALOG, needsEditor } from "../../src/briefs/catalog.js";
import { commands, editorContext, palette } from "./helpers/manifest.js";

describe("extension manifest: briefs", () => {
  test("every catalog brief is a contributed command under the Nimbus category", () => {
    for (const spec of BRIEF_CATALOG) {
      const entry = commands.find((c) => c.command === spec.command);
      expect(entry, `${spec.command} must be contributed`).toBeDefined();
      expect(entry?.title).toBe(spec.label);
      expect(entry?.category).toBe("Nimbus");
    }
  });

  test("the file-scoped briefs appear in the editor context menu", () => {
    for (const spec of BRIEF_CATALOG.filter(needsEditor)) {
      const entry = editorContext.find((e) => e.command === spec.command);
      expect(entry, `${spec.command} must be in editor/context`).toBeDefined();
      expect(entry?.when).toBe("editorTextFocus");
    }
  });

  test("huddle needs no editor, so it is not in the editor context menu", () => {
    expect(editorContext.find((e) => e.command === "nimbus.brief.huddle")).toBeUndefined();
  });

  // Opening the palette moves focus off the editor, so a focus clause would
  // hide the command exactly when it is being searched for. Same rule
  // manifest-command-palette.test.ts already enforces globally.
  test("palette entries for briefs never gate on keyboard focus", () => {
    for (const spec of BRIEF_CATALOG) {
      const entry = palette.find((e) => e.command === spec.command);
      if (entry?.when !== undefined) expect(entry.when).not.toContain("Focus");
    }
  });

  test("the file-scoped briefs are palette-gated on an open editor", () => {
    for (const spec of BRIEF_CATALOG.filter(needsEditor)) {
      expect(palette.find((e) => e.command === spec.command)?.when).toBe("editorIsOpen");
    }
  });

  test("the prompted briefs are not in the editor context menu", () => {
    for (const spec of BRIEF_CATALOG.filter((b) => b.context === "prompted")) {
      expect(editorContext.find((e) => e.command === spec.command)).toBeUndefined();
    }
  });

  // They prompt for everything they need, so gating them on an open editor would
  // hide them exactly when a tree row or the palette is the entry point.
  test("the prompted briefs are not palette-gated on an open editor", () => {
    for (const spec of BRIEF_CATALOG.filter((b) => b.context === "prompted")) {
      expect(palette.find((e) => e.command === spec.command)?.when).not.toBe("editorIsOpen");
    }
  });
});
