import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { WORKFLOW_CONTEXT_VALUE } from "../../src/sidebar/workflows.js";

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

const RUN = "nimbus.runWorkflow";
const DRY = "nimbus.dryRunWorkflow";
const VIEW = "nimbus.workflowsView";

describe("extension manifest: workflows", () => {
  test("the Workflows view is contributed to the nimbus container", () => {
    expect(views.find((v) => v.id === VIEW)?.name).toBe("Workflows");
  });

  test("the view has a disconnected welcome, like every other Nimbus view", () => {
    const entry = welcome.find((w) => w.view === VIEW);
    expect(entry?.when).toBe("!nimbus.connected");
  });

  test("refresh sits in the view's title bar", () => {
    const entry = viewTitle.find((m) => m.command === "nimbus.refreshWorkflows");
    expect(entry?.when).toBe(`view == ${VIEW}`);
    expect(entry?.group).toBe("navigation");
  });

  test("run and dry-run are contributed under the Nimbus category", () => {
    for (const id of [RUN, DRY]) {
      const entry = commands.find((c) => c.command === id);
      expect(entry, `${id} must be contributed`).toBeDefined();
      expect(entry?.category).toBe("Nimbus");
    }
  });

  test("both run commands are gated on a workflow row, not any row in the view", () => {
    // Without the viewItem clause they would also appear on a RUN row, offering
    // to re-run a piece of history.
    for (const id of [RUN, DRY]) {
      const entry = itemContext.find((m) => m.command === id);
      expect(entry, `${id} must be in view/item/context`).toBeDefined();
      expect(entry?.when).toBe(`view == ${VIEW} && viewItem == ${WORKFLOW_CONTEXT_VALUE}`);
    }
  });

  test("the manifest's viewItem clause matches the contextValue the view actually sets", () => {
    // The two halves live in different files; a typo in either silently means
    // the menu never appears. This is the assertion that catches that.
    const entry = itemContext.find((m) => m.command === RUN);
    expect(entry?.when).toContain(WORKFLOW_CONTEXT_VALUE);
  });
});
