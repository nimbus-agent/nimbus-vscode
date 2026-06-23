import { describe, expect, test, vi } from "vitest";

import { createQuickActions } from "../../src/sidebar/quick-actions.js";
import type { CommandsApi, QuickPickItemLike, WindowApi } from "../../src/vscode-shim.js";

type Picked = (QuickPickItemLike & { command: string }) | undefined;

function makeDeps(pick: Picked): {
  menu: ReturnType<typeof createQuickActions>;
  executed: string[];
  shownItems: ReadonlyArray<QuickPickItemLike & { command: string }>[];
} {
  const executed: string[] = [];
  const shownItems: ReadonlyArray<QuickPickItemLike & { command: string }>[] = [];
  const window = {
    showQuickPick: vi.fn(async (items: readonly (QuickPickItemLike & { command: string })[]) => {
      shownItems.push(items);
      return pick;
    }),
  } as unknown as WindowApi;
  const commands: CommandsApi = {
    executeCommand: vi.fn(async (id: string) => {
      executed.push(id);
      return undefined;
    }),
    registerCommand: () => ({ dispose: () => undefined }),
  };
  return { menu: createQuickActions({ window, commands }), executed, shownItems };
}

describe("createQuickActions", () => {
  test("offers exactly the four Phase 1 actions", async () => {
    const d = makeDeps(undefined);
    await d.menu.show();
    const commandsOffered = d.shownItems[0]?.map((i) => i.command);
    expect(commandsOffered).toEqual([
      "nimbus.ask",
      "nimbus.search",
      "nimbus.reconnect",
      "nimbus.openLogs",
    ]);
  });

  test("executes the picked action's command", async () => {
    const d = makeDeps({ label: "$(sync) Reconnect", command: "nimbus.reconnect" });
    await d.menu.show();
    expect(d.executed).toEqual(["nimbus.reconnect"]);
  });

  test("dismissing the menu runs nothing", async () => {
    const d = makeDeps(undefined);
    await d.menu.show();
    expect(d.executed).toEqual([]);
  });
});
