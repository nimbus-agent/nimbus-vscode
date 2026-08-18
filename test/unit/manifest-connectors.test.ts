import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { CONNECTOR_CONTEXT } from "../../src/connectors/rows.js";

type Command = { command: string; title: string; category?: string; icon?: string };
type MenuEntry = { command: string; when?: string; group?: string };
type View = { id: string; name: string };

const manifest = JSON.parse(readFileSync(join(__dirname, "..", "..", "package.json"), "utf8")) as {
  contributes?: {
    commands?: Command[];
    views?: { nimbus?: View[] };
    viewsWelcome?: Array<{ view: string; contents: string; when?: string }>;
    menus?: { "view/title"?: MenuEntry[]; "view/item/context"?: MenuEntry[] };
  };
};

const commands = manifest.contributes?.commands ?? [];
const views = manifest.contributes?.views?.nimbus ?? [];
const welcome = manifest.contributes?.viewsWelcome ?? [];
const viewTitle = manifest.contributes?.menus?.["view/title"] ?? [];
const itemContext = manifest.contributes?.menus?.["view/item/context"] ?? [];
const VIEW = "nimbus.connectorsView";

const ALL = [
  "nimbus.syncConnector",
  "nimbus.fullResyncConnector",
  "nimbus.pauseConnector",
  "nimbus.resumeConnector",
  "nimbus.configureConnector",
  "nimbus.reindexConnector",
  "nimbus.authenticateConnector",
  "nimbus.addMcpConnector",
  "nimbus.removeConnector",
  "nimbus.refreshConnectors",
];

describe("extension manifest: connectors", () => {
  test("the view is contributed to the nimbus container", () => {
    expect(views.find((v) => v.id === VIEW)?.name).toBe("Connectors");
  });

  test("it has a disconnected welcome, like every other Nimbus view", () => {
    expect(welcome.find((w) => w.view === VIEW)?.when).toBe("!nimbus.connected");
  });

  test("every command is declared under the Nimbus category", () => {
    for (const id of ALL) {
      const entry = commands.find((c) => c.command === id);
      expect(entry, id).toBeDefined();
      expect(entry?.category).toBe("Nimbus");
    }
  });

  test("refresh sits in the view's title bar", () => {
    const entry = viewTitle.find((m) => m.command === "nimbus.refreshConnectors");
    expect(entry?.when).toBe(`view == ${VIEW}`);
    expect(entry?.group).toBe("navigation");
  });

  // A `when` clause carries either `viewItem == <value>` or `viewItem =~ /re/`.
  // Substring-matching it is wrong in both directions — "nimbus.connector.syncing"
  // does not occur inside "/nimbus.connector.(active|syncing)/", and a substring
  // test would also accept "nimbus.connector.syncingXYZ". Evaluate the clause
  // against the contextValue instead, which is what VS Code itself does.
  function offeredOn(when: string | undefined, contextValue: string): boolean {
    const clause = when ?? "";
    const re = /viewItem =~ \/(.+?)\//.exec(clause);
    if (re !== null) return new RegExp(re[1] ?? "").test(contextValue);
    return clause.includes(`viewItem == ${contextValue}`);
  }

  test("Pause and Resume never both appear on one row", () => {
    const pause = itemContext.find((m) => m.command === "nimbus.pauseConnector");
    const resume = itemContext.find((m) => m.command === "nimbus.resumeConnector");
    expect(offeredOn(pause?.when, CONNECTOR_CONTEXT.active)).toBe(true);
    expect(offeredOn(pause?.when, CONNECTOR_CONTEXT.paused)).toBe(false);
    expect(offeredOn(resume?.when, CONNECTOR_CONTEXT.paused)).toBe(true);
    expect(offeredOn(resume?.when, CONNECTOR_CONTEXT.active)).toBe(false);
  });

  test("the sync family is hidden while a connector is syncing", () => {
    for (const id of [
      "nimbus.syncConnector",
      "nimbus.fullResyncConnector",
      "nimbus.reindexConnector",
    ]) {
      const entry = itemContext.find((m) => m.command === id);
      expect(offeredOn(entry?.when, CONNECTOR_CONTEXT.syncing), id).toBe(false);
    }
  });

  test("Pause and Remove stay reachable on a syncing row, on purpose", () => {
    for (const id of ["nimbus.pauseConnector", "nimbus.removeConnector"]) {
      const entry = itemContext.find((m) => m.command === id);
      expect(offeredOn(entry?.when, CONNECTOR_CONTEXT.syncing), id).toBe(true);
    }
  });

  test("no connector command is hidden from the palette — each prompts when it has no row", () => {
    const palette =
      (manifest.contributes?.menus as { commandPalette?: MenuEntry[] } | undefined)
        ?.commandPalette ?? [];
    for (const id of ALL) {
      expect(palette.find((m) => m.command === id)?.when, id).not.toBe("false");
    }
  });
});
