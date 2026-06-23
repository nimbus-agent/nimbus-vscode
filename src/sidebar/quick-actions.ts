import type { CommandsApi, QuickPickItemLike, WindowApi } from "../vscode-shim.js";

interface QuickAction extends QuickPickItemLike {
  readonly command: string;
}

// Status-bar quick menu (design surface #7). Phase 1 lists only the actions
// whose commands already exist; later phases append View Audit / Run Agent /
// SQL as those surfaces land. Codicons in the labels render in the Quick Pick.
const ACTIONS: readonly QuickAction[] = [
  {
    label: "$(comment-discussion) Ask",
    description: "Ask Nimbus a question",
    command: "nimbus.ask",
  },
  { label: "$(search) Search", description: "Search the local index", command: "nimbus.search" },
  {
    label: "$(sync) Reconnect",
    description: "Reconnect to the Gateway",
    command: "nimbus.reconnect",
  },
  {
    label: "$(output) Logs",
    description: "Show the Nimbus output channel",
    command: "nimbus.openLogs",
  },
];

export interface QuickActionsMenu {
  show(): Promise<void>;
}

export function createQuickActions(deps: {
  window: WindowApi;
  commands: CommandsApi;
}): QuickActionsMenu {
  return {
    async show(): Promise<void> {
      const pick = await deps.window.showQuickPick(ACTIONS, {
        placeHolder: "Nimbus: choose an action",
        matchOnDescription: true,
      });
      if (pick === undefined) return;
      await deps.commands.executeCommand(pick.command);
    },
  };
}
