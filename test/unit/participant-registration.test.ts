import { describe, expect, test, vi } from "vitest";
import { activateWithDeps } from "../../src/extension.js";
import * as stub from "./vscode-stub.js";

type ActivateDeps = Parameters<typeof activateWithDeps>[1];

function ctx(): Parameters<typeof activateWithDeps>[0] {
  return {
    subscriptions: [],
    workspaceState: { get: () => undefined, update: async () => undefined },
  } as unknown as Parameters<typeof activateWithDeps>[0];
}

describe("chat participant registration", () => {
  test("activateWithDeps registers a participant with sane deps", () => {
    const registerChatParticipant = vi.fn((_opts: unknown) => ({ dispose: () => undefined }));
    const deps = {
      window: stub.window,
      workspace: stub.workspace,
      commands: stub.commands,
      chatPanelFactory: () => ({
        createOrReveal: () => ({}),
        current: () => undefined,
      }),
      registerChatParticipant,
    } as unknown as ActivateDeps;

    activateWithDeps(ctx(), deps);

    expect(registerChatParticipant).toHaveBeenCalledTimes(1);
    const arg = registerChatParticipant.mock.calls[0]?.[0] as {
      deps: { citationLimit: number; reconnectCommand: string };
    };
    expect(arg.deps.citationLimit).toBe(5);
    expect(arg.deps.reconnectCommand).toBe("nimbus.troubleshootConnection");
  });
});
