import { describe, expect, test } from "vitest";

import { createSettings } from "../../src/settings.js";
import type { WorkspaceApi } from "../../src/vscode-shim.js";

function makeWorkspace(values: Record<string, unknown>): WorkspaceApi {
  return {
    getConfiguration: () => ({
      get: <T>(key: string, dflt: T): T => {
        if (key in values) {
          return values[key] as T;
        }
        return dflt;
      },
    }),
    onDidChangeConfiguration: () => ({ dispose: () => undefined }),
    isTrusted: true,
    workspaceFolders: undefined,
    textDocuments: [],
  };
}

describe("Settings", () => {
  test("returns defaults when keys absent", () => {
    const s = createSettings(makeWorkspace({}));
    expect(s.socketPath()).toBe("");
    expect(s.autoStartGateway()).toBe(false);
    expect(s.statusBarPollMs()).toBe(30000);
    expect(s.transcriptHistoryLimit()).toBe(50);
    expect(s.askAgent()).toBe("");
    expect(s.agents()).toEqual([]);
    expect(s.quickAskPresets()).toEqual([]);
    expect(s.showEgressStatusBarBadge()).toBe(true);
    expect(s.showHoverBlame()).toBe(true);
    expect(s.hitlAlwaysModal()).toBe(false);
    expect(s.logLevel()).toBe("info");
  });

  test("returns user-set values", () => {
    const s = createSettings(
      makeWorkspace({
        socketPath: "/run/nimbus-test/custom.sock",
        autoStartGateway: true,
        statusBarPollMs: 5000,
        transcriptHistoryLimit: 200,
        askAgent: "mainAgent",
        agents: [{ id: "a", label: "A" }],
        "quickAsk.presets": [{ label: "Test", prompt: "Write tests." }],
        "egress.showStatusBarBadge": false,
        "briefs.showHoverBlame": false,
        hitlAlwaysModal: true,
        logLevel: "debug",
      }),
    );
    expect(s.socketPath()).toBe("/run/nimbus-test/custom.sock");
    expect(s.autoStartGateway()).toBe(true);
    expect(s.statusBarPollMs()).toBe(5000);
    expect(s.transcriptHistoryLimit()).toBe(200);
    expect(s.askAgent()).toBe("mainAgent");
    expect(s.agents()).toEqual([{ id: "a", label: "A" }]);
    expect(s.quickAskPresets()).toEqual([{ label: "Test", prompt: "Write tests." }]);
    expect(s.showEgressStatusBarBadge()).toBe(false);
    expect(s.showHoverBlame()).toBe(false);
    expect(s.hitlAlwaysModal()).toBe(true);
    expect(s.logLevel()).toBe("debug");
  });

  test("falls back to info for an unrecognized logLevel value", () => {
    const s = createSettings(makeWorkspace({ logLevel: "trace" }));
    expect(s.logLevel()).toBe("info");
  });

  test("defaultNamespace is empty by default", () => {
    const s = createSettings(makeWorkspace({}));
    expect(s.defaultNamespace()).toBe("");
  });

  test("defaultNamespace reads briefs.defaultNamespace", () => {
    const s = createSettings(makeWorkspace({ "briefs.defaultNamespace": "billing" }));
    expect(s.defaultNamespace()).toBe("billing");
  });
});
