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
    resume: vi.fn(async () => ({ kind: "applied" }) as const),
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

test("registers exactly the nine documented command ids", () => {
  const h = harness();
  expect(Object.keys(h.commands).sort()).toEqual(
    [
      "nimbus.addMcpConnector",
      "nimbus.authenticateConnector",
      "nimbus.configureConnector",
      "nimbus.fullResyncConnector",
      "nimbus.pauseConnector",
      "nimbus.reindexConnector",
      "nimbus.removeConnector",
      "nimbus.resumeConnector",
      "nimbus.syncConnector",
    ].sort(),
  );
});

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

  test("the consent wait is cancellable, and the task takes (progress, token)", async () => {
    const h = harness();
    await h.commands["nimbus.removeConnector"]!(node());
    const [options, task] = h.window.withProgress.mock.calls[0] ?? [];
    expect(options).toMatchObject({ cancellable: true });
    // Two parameters: the reporter, then the cancellation token — the order
    // the real vscode.window.withProgress always calls with.
    expect(task as (...args: unknown[]) => unknown).toHaveLength(2);
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

describe("resume", () => {
  test("on a paused row, calls ops.resume with the service id and reports the outcome", async () => {
    const h = harness();
    const pausedNode = {
      label: "github",
      contextValue: CONNECTOR_CONTEXT.paused,
      payload: { serviceId: "github", itemCount: 1204 },
    };
    await h.commands["nimbus.resumeConnector"]!(pausedNode);
    expect(h.ops.resume).toHaveBeenCalledWith("github");
    expect(h.window.showInformationMessage.mock.calls[0]?.[0]).toBe("Resuming github: done");
  });
});

describe("fullResync", () => {
  test("confirms modally, mentioning the sync cursor, before calling", async () => {
    const h = harness({ window: { showWarningMessage: vi.fn(async () => "Full re-sync") } });
    await h.commands["nimbus.fullResyncConnector"]!(node());
    const [message, options] = h.window.showWarningMessage.mock.calls[0] ?? [];
    expect(message).toContain("clears its sync cursor");
    expect(options).toMatchObject({ modal: true });
    expect(h.ops.fullSync).toHaveBeenCalledWith("github");
  });

  test("a declined confirmation calls nothing", async () => {
    const h = harness({ window: { showWarningMessage: vi.fn(async () => undefined) } });
    await h.commands["nimbus.fullResyncConnector"]!(node());
    expect(h.ops.fullSync).not.toHaveBeenCalled();
  });
});

describe("reindex", () => {
  test("metadata_only calls ops.reindex directly, without the consent wrapper", async () => {
    const h = harness({
      window: { showQuickPick: vi.fn(async () => ({ label: "metadata_only" })) },
    });
    await h.commands["nimbus.reindexConnector"]!(node());
    expect(h.ops.reindex).toHaveBeenCalledWith("github", "metadata_only");
    expect(h.window.withProgress).not.toHaveBeenCalled();
    expect(h.window.showWarningMessage).not.toHaveBeenCalled();
  });

  test("full confirms modally and goes through the cancellable consent wrapper", async () => {
    const h = harness({
      window: {
        showQuickPick: vi.fn(async () => ({ label: "full" })),
        showWarningMessage: vi.fn(async () => "Re-index"),
      },
    });
    await h.commands["nimbus.reindexConnector"]!(node());
    expect(h.window.showWarningMessage).toHaveBeenCalled();
    const [options] = h.window.withProgress.mock.calls[0] ?? [];
    expect(options).toMatchObject({ cancellable: true });
    expect(h.ops.reindex).toHaveBeenCalledWith("github", "full");
  });
});

describe("addMcp", () => {
  test("validates the connector id, then calls ops.addMcp through the consent wrapper", async () => {
    const answers = ["mcp_acme", "npx -y @acme/mcp-server"];
    const h = harness({
      window: { showInputBox: vi.fn(async (..._args: unknown[]) => answers.shift()) },
    });
    await h.commands["nimbus.addMcpConnector"]!(undefined);
    const idOpts = h.window.showInputBox.mock.calls[0]?.[0] as {
      validateInput: (v: string) => string | undefined;
    };
    expect(idOpts.validateInput("nope")).toEqual(expect.any(String));
    expect(idOpts.validateInput("mcp_acme")).toBeUndefined();
    expect(h.ops.addMcp).toHaveBeenCalledWith("mcp_acme", "npx -y @acme/mcp-server");
    const [options] = h.window.withProgress.mock.calls[0] ?? [];
    expect(options).toMatchObject({ cancellable: true });
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
    // Nor any user-facing surface — today that holds only by construction
    // (nothing interpolates a field value into a title or message), and a
    // future progress title built from a field would be exactly the
    // regression this guards against.
    const surfaces = [
      ...h.window.showInformationMessage.mock.calls,
      ...h.window.showErrorMessage.mock.calls,
      ...h.window.withProgress.mock.calls,
    ];
    expect(JSON.stringify(surfaces)).not.toContain(SENTINEL);
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

describe("credentials: unknown-provider add-another-field loop", () => {
  test("an unknown provider can add two extra fields, and all three reach ops.auth by name", async () => {
    const answers: Array<string | undefined> = [
      SENTINEL, // GENERIC_FIELD's "token"
      "awsAccessKeyId",
      "AKIA_FAKE",
      "awsSecretAccessKey",
      "SECRET_FAKE",
      undefined, // dismiss the name prompt: stop adding fields
    ];
    const h = harness({ window: { showInputBox: vi.fn(async () => answers.shift()) } });
    await h.commands["nimbus.authenticateConnector"]!(node("aws"));
    expect(h.ops.auth).toHaveBeenCalledWith("aws", {
      token: SENTINEL,
      awsAccessKeyId: "AKIA_FAKE",
      awsSecretAccessKey: "SECRET_FAKE",
    });
  });

  test("dismissing the name prompt right away proceeds with what was already collected", async () => {
    const answers: Array<string | undefined> = [SENTINEL, undefined];
    const h = harness({ window: { showInputBox: vi.fn(async () => answers.shift()) } });
    await h.commands["nimbus.authenticateConnector"]!(node("aws"));
    expect(h.ops.auth).toHaveBeenCalledWith("aws", { token: SENTINEL });
  });

  test("cancelling a value prompt abandons the whole flow — nothing is sent", async () => {
    const answers: Array<string | undefined> = [SENTINEL, "awsAccessKeyId", undefined];
    const h = harness({ window: { showInputBox: vi.fn(async () => answers.shift()) } });
    await h.commands["nimbus.authenticateConnector"]!(node("aws"));
    expect(h.ops.auth).not.toHaveBeenCalled();
  });

  test("a known provider is never offered the loop", async () => {
    const h = harness();
    await h.commands["nimbus.authenticateConnector"]!(node("github"));
    expect(h.window.showInputBox).toHaveBeenCalledTimes(1);
    expect(h.ops.auth).toHaveBeenCalledWith("github", { personalAccessToken: SENTINEL });
  });

  test("no value from the extra-field loop ever reaches the log", async () => {
    const answers: Array<string | undefined> = [
      SENTINEL,
      "awsAccessKeyId",
      "AKIA_FAKE_SECRET",
      undefined,
    ];
    const h = harness({ window: { showInputBox: vi.fn(async () => answers.shift()) } });
    await h.commands["nimbus.authenticateConnector"]!(node("aws"));
    expect(h.logged.join("\n")).not.toContain("AKIA_FAKE_SECRET");
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
    // …and a value at or above the floor is accepted, so the box is not simply
    // refusing everything typed into it.
    expect(validate("15m")).toBeUndefined();
    expect(h.ops.setConfig).not.toHaveBeenCalled();
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

  test("a second invocation while one is in flight says so, naming the connector and action", async () => {
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
    expect(h.window.showInformationMessage).toHaveBeenCalledWith(
      "Syncing github is already in progress.",
      {},
    );
    release();
    await first;
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
describe("configure", () => {
  // A two-step command: the first Quick Pick chooses WHICH setting, and
  // "Sync interval" / "Index depth" each open a second prompt. `queued` answers
  // them in order, so a test reads as the sequence the user actually sees.
  function queued(...answers: Array<{ label: string } | undefined>) {
    const rest = [...answers];
    return vi.fn(async (..._args: unknown[]) => rest.shift());
  }

  test("a dismissed setting picker calls nothing", async () => {
    const h = harness({ window: { showQuickPick: queued(undefined) } });
    await h.commands["nimbus.configureConnector"]!(node());
    expect(h.ops.setConfig).not.toHaveBeenCalled();
  });

  test("a valid interval reaches the Gateway as milliseconds, not as the typed text", async () => {
    const h = harness({
      window: {
        showQuickPick: queued({ label: "Sync interval" }),
        showInputBox: vi.fn(async () => "15m"),
      },
    });
    await h.commands["nimbus.configureConnector"]!(node());
    expect(h.ops.setConfig).toHaveBeenCalledWith({ serviceId: "github", intervalMs: 900_000 });
  });

  test("dismissing the interval box calls nothing", async () => {
    const h = harness({
      window: {
        showQuickPick: queued({ label: "Sync interval" }),
        showInputBox: vi.fn(async () => undefined),
      },
    });
    await h.commands["nimbus.configureConnector"]!(node());
    expect(h.ops.setConfig).not.toHaveBeenCalled();
  });

  // validateInput is the first line of defence, but it is the HOST that enforces
  // it. A value that reaches us anyway must still not be sent: the floor is the
  // Gateway's, and shipping an unparseable duration would just move the
  // rejection one hop away.
  test("an unparseable interval that gets past the box is still not sent", async () => {
    const h = harness({
      window: {
        showQuickPick: queued({ label: "Sync interval" }),
        showInputBox: vi.fn(async () => "whenever"),
      },
    });
    await h.commands["nimbus.configureConnector"]!(node());
    expect(h.ops.setConfig).not.toHaveBeenCalled();
  });

  test("index depth sends the chosen depth", async () => {
    const h = harness({
      window: { showQuickPick: queued({ label: "Index depth" }, { label: "summary" }) },
    });
    await h.commands["nimbus.configureConnector"]!(node());
    expect(h.ops.setConfig).toHaveBeenCalledWith({ serviceId: "github", depth: "summary" });
  });

  test("dismissing the depth picker calls nothing", async () => {
    const h = harness({
      window: { showQuickPick: queued({ label: "Index depth" }, undefined) },
    });
    await h.commands["nimbus.configureConnector"]!(node());
    expect(h.ops.setConfig).not.toHaveBeenCalled();
  });

  // `false` is a REQUEST to disable, not an absent field: a truthiness test
  // anywhere on this path would drop it and silently leave the connector on.
  test.each([
    ["Enable", true],
    ["Disable", false],
  ] as const)("%s sends enabled: %s", async (label, enabled) => {
    const h = harness({ window: { showQuickPick: queued({ label }) } });
    await h.commands["nimbus.configureConnector"]!(node());
    expect(h.ops.setConfig).toHaveBeenCalledWith({ serviceId: "github", enabled });
  });
});

describe("reindex: dismissal", () => {
  test("a dismissed depth picker calls nothing", async () => {
    const h = harness({ window: { showQuickPick: vi.fn(async () => undefined) } });
    await h.commands["nimbus.reindexConnector"]!(node());
    expect(h.ops.reindex).not.toHaveBeenCalled();
  });
});

describe("credentials: a provider that authenticates in the browser", () => {
  // google_drive is the catalog's OAuth (PKCE) shape: an EMPTY field list, which
  // means "call with serviceId alone". Prompting for a token there would ask for
  // something that does not exist.
  test("prompts for nothing, says what will happen, and still calls auth", async () => {
    const h = harness();
    await h.commands["nimbus.authenticateConnector"]!(node("google_drive", 0));
    expect(h.window.showInputBox).not.toHaveBeenCalled();
    expect(h.window.showInformationMessage.mock.calls[0]?.[0]).toContain("browser");
    expect(h.ops.auth).toHaveBeenCalledWith("google_drive", {});
  });

  test("the log says 'no fields' rather than trailing an empty list", async () => {
    const h = harness();
    await h.commands["nimbus.authenticateConnector"]!(node("google_drive", 0));
    expect(h.logged.join("\n")).toContain("connector auth: google_drive (no fields)");
  });
});

describe("credentials: prompt shape", () => {
  // exactOptionalPropertyTypes forbids an explicit `placeHolder: undefined`, so
  // the key is spread in only when the field carries one. A field WITHOUT a
  // placeholder must therefore not carry the key at all.
  test("a placeholder is passed only for the field that has one", async () => {
    const h = harness();
    await h.commands["nimbus.authenticateConnector"]!(node("jira", 7));
    const opts = h.window.showInputBox.mock.calls.map(
      (c) => c[0] as { prompt: string; placeHolder?: string },
    );
    expect(opts[0]).not.toHaveProperty("placeHolder");
    expect(opts[1]?.placeHolder).toBe("https://your-team.atlassian.net");
  });

  test("an empty extra-field NAME is rejected in the box, so no unnamed field is sent", async () => {
    const answers: Array<string | undefined> = [SENTINEL, undefined];
    const h = harness({
      window: { showInputBox: vi.fn(async (..._args: unknown[]) => answers.shift()) },
    });
    // "aws" is deliberately absent from the catalog, so the add-another-field
    // loop is offered and its name prompt is the second box.
    await h.commands["nimbus.authenticateConnector"]!(node("aws", 0));
    const nameOpts = h.window.showInputBox.mock.calls[1]?.[0] as {
      validateInput: (v: string) => string | undefined;
    };
    expect(nameOpts.validateInput("   ")).toBe("Field name cannot be empty.");
    expect(nameOpts.validateInput("awsAccessKeyId")).toBeUndefined();
  });
});

describe("addMcp: the command line", () => {
  test("cannot be blank", async () => {
    const answers = ["mcp_acme", "npx -y @acme/mcp-server"];
    const h = harness({
      window: { showInputBox: vi.fn(async (..._args: unknown[]) => answers.shift()) },
    });
    await h.commands["nimbus.addMcpConnector"]!(undefined);
    const cmdOpts = h.window.showInputBox.mock.calls[1]?.[0] as {
      validateInput: (v: string) => string | undefined;
    };
    expect(cmdOpts.validateInput("  ")).toBe("This field is required.");
    expect(cmdOpts.validateInput("npx -y @acme/mcp-server")).toBeUndefined();
  });

  test("dismissing it registers nothing, even though the id was already accepted", async () => {
    const answers: Array<string | undefined> = ["mcp_acme", undefined];
    const h = harness({
      window: { showInputBox: vi.fn(async (..._args: unknown[]) => answers.shift()) },
    });
    await h.commands["nimbus.addMcpConnector"]!(undefined);
    expect(h.ops.addMcp).not.toHaveBeenCalled();
  });
});

describe("reporting", () => {
  test("a failure is an error dialog, not an information one", async () => {
    const h = harness({
      ops: { pause: vi.fn(async () => ({ kind: "failed", message: "socket hang up" }) as const) },
    });
    await h.commands["nimbus.pauseConnector"]!(node());
    expect(h.window.showErrorMessage).toHaveBeenCalledWith("Pausing github failed: socket hang up");
    expect(h.window.showInformationMessage).not.toHaveBeenCalled();
    // A failure still refreshes: the row's state may have moved anyway.
    expect(h.refresh).toHaveBeenCalled();
  });

  test("the palette picker labels a disabled connector as disabled, not by its stale status", async () => {
    const h = harness({
      ops: {
        list: vi.fn(async () => [
          {
            serviceId: "github",
            status: "ok" as const,
            lastSyncAt: null,
            nextSyncAt: null,
            intervalMs: 60_000,
            itemCount: 1204,
            lastError: null,
            consecutiveFailures: 0,
            depth: "summary" as const,
            enabled: false,
          },
        ]),
      },
    });
    await h.commands["nimbus.pauseConnector"]!(undefined);
    const items = h.window.showQuickPick.mock.calls[0]?.[0] as Array<{ description: string }>;
    expect(items[0]?.description).toBe("disabled · 1,204 items");
  });
});
describe("no target, no call", () => {
  // Every one of these is palette-visible, so each can be invoked with no row
  // and each then opens the picker. Dismissing it must abandon that command —
  // proceeding with an undefined target would build "Syncing undefined" at best.
  test.each([
    ["nimbus.syncConnector", "sync"],
    ["nimbus.fullResyncConnector", "fullSync"],
    ["nimbus.pauseConnector", "pause"],
    ["nimbus.resumeConnector", "resume"],
    ["nimbus.configureConnector", "setConfig"],
    ["nimbus.reindexConnector", "reindex"],
    ["nimbus.authenticateConnector", "auth"],
    ["nimbus.removeConnector", "remove"],
  ] as const)("%s calls nothing when the picker is dismissed", async (commandId, op) => {
    const h = harness({ window: { showQuickPick: vi.fn(async () => undefined) } });
    await h.commands[commandId]!(undefined);
    expect(h.ops[op]).not.toHaveBeenCalled();
  });

  // A row from another view, or one of our own non-connector rows: it IS an
  // object, so the typeof guard passes, but it carries no serviceId. Falling
  // through to the picker beats acting on a connector called "undefined".
  test("a row whose payload is not a connector falls through to the picker", async () => {
    const h = harness({ window: { showQuickPick: vi.fn(async () => undefined) } });
    await h.commands["nimbus.pauseConnector"]!({ label: "some row", payload: { name: "x" } });
    expect(h.window.showQuickPick).toHaveBeenCalled();
    expect(h.ops.pause).not.toHaveBeenCalled();
  });
});

describe("confirmations that are declined", () => {
  test("declining the full-depth re-index warning never reaches the consent wait", async () => {
    const h = harness({
      window: {
        showQuickPick: vi.fn(async () => ({ label: "full" })),
        showWarningMessage: vi.fn(async () => undefined),
      },
    });
    await h.commands["nimbus.reindexConnector"]!(node());
    expect(h.ops.reindex).not.toHaveBeenCalled();
    expect(h.window.withProgress).not.toHaveBeenCalled();
  });

  test("dismissing the connector-id prompt never asks for a command line", async () => {
    const h = harness({ window: { showInputBox: vi.fn(async () => undefined) } });
    await h.commands["nimbus.addMcpConnector"]!(undefined);
    expect(h.window.showInputBox).toHaveBeenCalledTimes(1);
    expect(h.ops.addMcp).not.toHaveBeenCalled();
  });
});

// --- Finding 1: consent that never arrives ---------------------------------
describe("waiting for consent", () => {
  test("cancelling stops the wait and says the request may still be open", async () => {
    const h = harness({
      // A consent call that never settles: exactly what Gateway 7.1.0 does when
      // the request is raised as `consent.request` and nothing in the editor is
      // listening for it.
      ops: { remove: vi.fn(() => new Promise<never>(() => {})) },
      window: {
        showWarningMessage: vi.fn(async (..._args: unknown[]) => "Remove"),
        withProgress: vi.fn(
          async (_o: unknown, task: (p: unknown, t: unknown) => Promise<unknown>) =>
            await task(
              { report: () => {} },
              // Cancel as soon as the task registers its listener.
              {
                onCancellationRequested: (cb: () => void) => {
                  cb();
                  return { dispose: () => {} };
                },
              },
            ),
        ),
      },
    });
    await h.commands["nimbus.removeConnector"]!(node());
    const text = String(h.window.showInformationMessage.mock.calls[0]?.[0] ?? "");
    expect(text).toContain("stopped waiting");
    expect(text).toContain("still be open");
    // Never claims the removal was called off — the Gateway's request survives.
    expect(text).not.toContain("failed");
  });

  test("an unanswered gated call warns, and never blames the Gateway", async () => {
    const h = harness({
      ops: { addMcp: vi.fn(async () => ({ kind: "unreachable" }) as const) },
      window: { showInputBox: vi.fn(async (..._args: unknown[]) => "mcp_acme") },
    });
    await h.commands["nimbus.addMcpConnector"]!();
    const text = String(h.window.showWarningMessage.mock.calls[0]?.[0] ?? "");
    expect(text).toContain("Nimbus CLI");
    expect(h.window.showErrorMessage).not.toHaveBeenCalled();
  });
});
