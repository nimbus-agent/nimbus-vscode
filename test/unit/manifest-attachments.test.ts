import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

type Command = { command: string; title: string; category?: string; icon?: string };
type MenuEntry = { command: string; when?: string; group?: string };

const manifest = JSON.parse(readFileSync(join(__dirname, "..", "..", "package.json"), "utf8")) as {
  contributes?: {
    commands?: Command[];
    menus?: {
      commandPalette?: MenuEntry[];
      "editor/context"?: MenuEntry[];
      "view/item/context"?: MenuEntry[];
    };
  };
};

const commands = manifest.contributes?.commands ?? [];
const palette = manifest.contributes?.menus?.commandPalette ?? [];
const editorContext = manifest.contributes?.menus?.["editor/context"] ?? [];
const itemContext = manifest.contributes?.menus?.["view/item/context"] ?? [];

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

  // Every one of these three prompts or reads the active editor on its own, so
  // none of them needs a node to work — unlike nimbus.askAboutIndexItem or
  // nimbus.openIndexItem, which are hidden with "when": "false" because they
  // are meaningless without a tree row. The repo's rule for hiding a command
  // from the palette does not apply here.
  test("none of the three is hidden from the palette", () => {
    for (const id of ALL) {
      expect(palette.find((m) => m.command === id)?.when, id).not.toBe("false");
    }
  });
});
