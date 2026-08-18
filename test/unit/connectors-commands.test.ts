import { describe, expect, test, vi } from "vitest";

import { createConnectorCommands } from "../../src/connectors/commands.js";
import type { ConnectorOps } from "../../src/connectors/connector-client.js";
import { CONNECTOR_CONTEXT } from "../../src/connectors/rows.js";

const SENTINEL = "ghp_SUPER_SECRET_VALUE";

function node(serviceId = "github", itemCount = 1204) {
  return {
    label: serviceId,
    contextValue: CONNECTOR_CONTEXT.active,
    payload: { serviceId, itemCount },
  };
}

function harness(over: { ops?: Partial<ConnectorOps>; window?: Record<string, unknown> } = {}) {
  const logged: string[] = [];
  const ops = {
    list: vi.fn(async () => [
      {
        serviceId: "github",
        status: "ok",
        lastSyncAt: null,
        nextSyncAt: null,
        intervalMs: 60_000,
        itemCount: 1204,
        lastError: null,
        consecutiveFailures: 0,
        depth: "summary",
        enabled: true,
      },
    ]),
    pause: vi.fn(async () => ({ kind: "applied" }) as const),
    sync: vi.fn(async () => ({ kind: "applied", detail: "sync started" }) as const),
    fullSync: vi.fn(async () => ({ kind: "applied" }) as const),
    setConfig: vi.fn(async () => ({ kind: "applied", detail: "interval 15m" }) as const),
    reindex: vi.fn(async () => ({ kind: "applied" }) as const),
    auth: vi.fn(async () => ({ kind: "applied", detail: "scopes: repo" }) as const),
    remove: vi.fn(async () => ({ kind: "applied", detail: "1204 items deleted" }) as const),
    addMcp: vi.fn(async () => ({ kind: "applied" }) as const),
    ...over.ops,
  } as unknown as ConnectorOps;
  const window = {
    // Typed with a rest param (rather than zero args) so `.mock.calls[n]` comes
    // out as `unknown[]`, not an empty tuple — these are asserted on by index
    // and by destructuring below, under noUncheckedIndexedAccess.
    showInformationMessage: vi.fn(async (..._args: unknown[]) => undefined),
    showWarningMessage: vi.fn(async (..._args: unknown[]) => "Remove"),
    showErrorMessage: vi.fn(async (..._args: unknown[]) => undefined),
    showInputBox: vi.fn(async (..._args: unknown[]) => SENTINEL),
    showQuickPick: vi.fn(async (..._args: unknown[]) => undefined),
    withProgress: vi.fn(async (_o: unknown, task: (p: unknown, t: unknown) => Promise<unknown>) =>
      task({ report: () => {} }, { onCancellationRequested: () => ({ dispose: () => {} }) }),
    ),
    ...over.window,
  };
  const refresh = vi.fn();
  const log = {
    info: (m: string) => logged.push(m),
    warn: (m: string) => logged.push(m),
    error: (m: string) => logged.push(m),
    debug: (m: string) => logged.push(m),
  };
  const commands = createConnectorCommands({
    window: window as never,
    ops,
    refresh,
    log: log as never,
  });
  return { commands, ops, window, refresh, logged };
}

describe("remove", () => {
  test("confirms modally, naming the item count, before calling", async () => {
    const h = harness();
    await h.commands["nimbus.removeConnector"]!(node());
    const [message, options] = h.window.showWarningMessage.mock.calls[0] ?? [];
    expect(message).toContain("1,204 indexed items");
    expect(options).toMatchObject({ modal: true });
    expect(h.ops.remove).toHaveBeenCalledWith("github");
  });

  test("a declined confirmation calls nothing", async () => {
    const h = harness({ window: { showWarningMessage: vi.fn(async () => undefined) } });
    await h.commands["nimbus.removeConnector"]!(node());
    expect(h.ops.remove).not.toHaveBeenCalled();
  });

  test("the consent wait is non-cancellable, and gets the reporter first", async () => {
    const h = harness();
    await h.commands["nimbus.removeConnector"]!(node());
    const [options, task] = h.window.withProgress.mock.calls[0] ?? [];
    expect(options).toMatchObject({ cancellable: false });
    expect(typeof task).toBe("function");
  });

  test("a denial is reported as a decision, not as an error", async () => {
    const h = harness({
      ops: { remove: vi.fn(async () => ({ kind: "denied", reason: "consent expired" }) as const) },
    });
    await h.commands["nimbus.removeConnector"]!(node());
    expect(h.window.showErrorMessage).not.toHaveBeenCalled();
    expect(h.window.showInformationMessage.mock.calls[0]?.[0]).toBe(
      "Removing github was not approved: consent expired",
    );
  });
});

describe("credentials", () => {
  test("a secret field is masked and survives focus loss", async () => {
    const h = harness();
    await h.commands["nimbus.authenticateConnector"]!(node());
    expect(h.window.showInputBox.mock.calls[0]?.[0]).toMatchObject({
      password: true,
      ignoreFocusOut: true,
    });
  });

  test("no credential value ever reaches the log", async () => {
    const h = harness();
    await h.commands["nimbus.authenticateConnector"]!(node());
    expect(h.ops.auth).toHaveBeenCalledWith("github", { personalAccessToken: SENTINEL });
    expect(h.logged.join("\n")).not.toContain(SENTINEL);
  });

  test("cancelling any prompt sends nothing", async () => {
    const h = harness({ window: { showInputBox: vi.fn(async () => undefined) } });
    await h.commands["nimbus.authenticateConnector"]!(node());
    expect(h.ops.auth).not.toHaveBeenCalled();
  });

  test("a blank required field is rejected in the box, before any call", async () => {
    const h = harness();
    await h.commands["nimbus.authenticateConnector"]!(node());
    const validate = (
      h.window.showInputBox.mock.calls[0]![0] as {
        validateInput: (v: string) => string | undefined;
      }
    ).validateInput;
    expect(validate("   ")).toBe("This field is required.");
    expect(validate("ghp_x")).toBeUndefined();
  });
});

describe("interval", () => {
  test("an interval under the floor never reaches the Gateway", async () => {
    const h = harness({
      window: {
        showQuickPick: vi.fn(async () => ({ label: "Sync interval" })),
        showInputBox: vi.fn(async () => "30s"),
      },
    });
    await h.commands["nimbus.configureConnector"]!(node());
    const validate = (
      h.window.showInputBox.mock.calls[0]![0] as {
        validateInput: (v: string) => string | undefined;
      }
    ).validateInput;
    expect(validate("30s")).toBe("The Gateway enforces a minimum of 60s.");
  });
});

describe("concurrency", () => {
  test("a second invocation while the first is in flight issues no RPC", async () => {
    let release = (): void => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const h = harness({
      ops: {
        sync: vi.fn(async () => {
          await gate;
          return { kind: "applied" } as const;
        }),
      },
    });
    const first = h.commands["nimbus.syncConnector"]!(node());
    await h.commands["nimbus.syncConnector"]!(node());
    expect(h.ops.sync).toHaveBeenCalledTimes(1);
    release();
    await first;
    // and the key is released, so the next click works
    await h.commands["nimbus.syncConnector"]!(node());
    expect(h.ops.sync).toHaveBeenCalledTimes(2);
  });

  test("the in-flight key is released even when the op throws", async () => {
    const h = harness({
      ops: {
        sync: vi.fn(async () => {
          throw new Error("boom");
        }),
      },
    });
    await h.commands["nimbus.syncConnector"]!(node());
    await h.commands["nimbus.syncConnector"]!(node());
    expect(h.ops.sync).toHaveBeenCalledTimes(2);
  });
});

describe("invoked without a row", () => {
  test("the palette path picks a connector rather than doing nothing", async () => {
    const h = harness({
      window: { showQuickPick: vi.fn(async () => ({ serviceId: "github", itemCount: 1204 })) },
    });
    await h.commands["nimbus.pauseConnector"]!(undefined);
    expect(h.window.showQuickPick).toHaveBeenCalled();
    expect(h.ops.pause).toHaveBeenCalledWith("github");
  });

  test("a dismissed picker calls nothing", async () => {
    const h = harness({ window: { showQuickPick: vi.fn(async () => undefined) } });
    await h.commands["nimbus.pauseConnector"]!(undefined);
    expect(h.ops.pause).not.toHaveBeenCalled();
  });

  test("with no connectors at all it says so instead of opening an empty picker", async () => {
    const h = harness({ ops: { list: vi.fn(async () => []) } });
    await h.commands["nimbus.pauseConnector"]!(undefined);
    expect(h.window.showQuickPick).not.toHaveBeenCalled();
    expect(h.window.showInformationMessage.mock.calls[0]?.[0]).toContain(
      "no connectors registered",
    );
  });

  test("an unlistable Gateway reports the error rather than a silent no-op", async () => {
    const h = harness({
      ops: {
        list: vi.fn(async () => {
          throw new Error("Method not found");
        }),
      },
    });
    await h.commands["nimbus.pauseConnector"]!(undefined);
    expect(h.window.showErrorMessage.mock.calls[0]?.[0]).toContain("Method not found");
    expect(h.ops.pause).not.toHaveBeenCalled();
  });

  test("a non-object argument falls through to the picker without throwing", async () => {
    const h = harness({
      window: { showQuickPick: vi.fn(async () => ({ serviceId: "github", itemCount: 1204 })) },
    });
    await h.commands["nimbus.pauseConnector"]!("not-a-node");
    expect(h.ops.pause).toHaveBeenCalledWith("github");
  });
});

test("every applied mutation refreshes the view", async () => {
  const h = harness();
  await h.commands["nimbus.pauseConnector"]!(node());
  expect(h.refresh).toHaveBeenCalled();
});
