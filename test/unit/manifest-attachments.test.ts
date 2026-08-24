import { describe, expect, test } from "vitest";

import { commands, editorContext, itemContext, palette } from "./helpers/manifest.js";

const ALL = ["nimbus.attachContext", "nimbus.attachSelectionToAsk", "nimbus.attachIndexItemToAsk"];

describe("extension manifest: attachments", () => {
  test("every attach command is declared under the Nimbus category", () => {
    for (const id of ALL) {
      const entry = commands.find((c) => c.command === id);
      expect(entry, id).toBeDefined();
      expect(entry?.category).toBe("Nimbus");
    }
  });

  test("attach-to-index-item sits in the index view's item context menu", () => {
    const entry = itemContext.find((m) => m.command === "nimbus.attachIndexItemToAsk");
    expect(entry?.when).toBe("view == nimbus.indexView && viewItem == nimbusIndexItem");
  });

  test("attach-selection sits in the editor context menu, gated on a selection", () => {
    const entry = editorContext.find((m) => m.command === "nimbus.attachSelectionToAsk");
    expect(entry?.when).toBe("editorHasSelection");
  });

  // attachContext prompts (the picker), and attachSelectionToAsk reads the
  // active editor on its own — neither needs a node to work, so the repo's
  // rule for hiding a command from the palette does not apply to them.
  test("attachContext and attachSelectionToAsk are not hidden from the palette", () => {
    for (const id of ["nimbus.attachContext", "nimbus.attachSelectionToAsk"]) {
      expect(palette.find((m) => m.command === id)?.when, id).not.toBe("false");
    }
  });

  // attachIndexItemToAsk, unlike the other two, silently no-ops without a
  // tree node (there is nothing to prompt for in its place) — exactly the
  // same shape as nimbus.askAboutIndexItem and nimbus.findRelatedFromIndex,
  // both of which are hidden for the same reason.
  test("attachIndexItemToAsk IS hidden from the palette — it no-ops without a tree node", () => {
    expect(palette.find((m) => m.command === "nimbus.attachIndexItemToAsk")?.when).toBe("false");
  });
});
