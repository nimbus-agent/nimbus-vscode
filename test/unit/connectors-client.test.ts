import type { ConnectorSyncStatus } from "@nimbus-dev/client";
import { describe, expect, test, vi } from "vitest";

import {
  type ConnectorClientLike,
  createConnectorOps,
} from "../../src/connectors/connector-client.js";

function stub(over: Partial<ConnectorClientLike> = {}): ConnectorClientLike {
  return {
    connectorListStatus: vi.fn(async () => [] as ConnectorSyncStatus[]),
    connectorStatus: vi.fn(async () => ({}) as never),
    connectorHealthHistory: vi.fn(async () => []),
    connectorPause: vi.fn(async () => ({ ok: true })),
    connectorResume: vi.fn(async () => ({ ok: true })),
    connectorSetConfig: vi.fn(async () => ({
      service: "github",
      intervalMs: 900_000,
      depth: null,
      enabled: null,
    })),
    connectorSync: vi.fn(async () => ({ ok: true })),
    connectorReindex: vi.fn(async () => ({ itemsAffected: 12, depth: "full", mode: "deepen" })),
    connectorAuth: vi.fn(async () => ({ ok: true, serviceId: "github", scopesGranted: ["repo"] })),
    connectorAddMcp: vi.fn(async () => ({ ok: true, serviceId: "mcp_acme" })),
    connectorRemove: vi.fn(async () => ({ ok: true, itemsDeleted: 3, vaultKeysRemoved: [] })),
    ...over,
  } as ConnectorClientLike;
}

describe("while disconnected", () => {
  test("a mutation fails without inventing a denial", async () => {
    const ops = createConnectorOps(() => undefined);
    expect(await ops.pause("github")).toEqual({
      kind: "failed",
      message: "Not connected to the Nimbus Gateway.",
    });
  });

  test("a read rejects, so the view renders its own error row", async () => {
    const ops = createConnectorOps(() => undefined);
    await expect(ops.list()).rejects.toThrow("Not connected to the Nimbus Gateway.");
  });
});

describe("health history", () => {
  test("an mcp_* id is skipped, not attempted — the Gateway rejects those", async () => {
    const client = stub();
    const ops = createConnectorOps(() => client);
    expect(await ops.history("mcp_acme")).toEqual([]);
    expect(client.connectorHealthHistory).not.toHaveBeenCalled();
  });

  test("a built-in id is fetched", async () => {
    const client = stub();
    const ops = createConnectorOps(() => client);
    await ops.history("github");
    expect(client.connectorHealthHistory).toHaveBeenCalledWith({ service: "github", limit: 15 });
  });
});

describe("mutations", () => {
  test("a full sync clears the cursor", async () => {
    const client = stub();
    const ops = createConnectorOps(() => client);
    expect(await ops.fullSync("github")).toEqual({
      kind: "applied",
      detail: "full re-sync started",
    });
    expect(client.connectorSync).toHaveBeenCalledWith({ serviceId: "github", full: true });
  });

  test("setConfig reports only what it asked to change, not the nulls", async () => {
    const ops = createConnectorOps(() => stub());
    expect(await ops.setConfig({ serviceId: "github", intervalMs: 900_000 })).toEqual({
      kind: "applied",
      detail: "interval 15m",
    });
  });

  test("a resolved rejection from remove is a denial carrying the Gateway's reason", async () => {
    const client = stub({
      connectorRemove: vi.fn(async () => ({
        status: "rejected" as const,
        reason: "owner said no",
      })),
    });
    const ops = createConnectorOps(() => client);
    expect(await ops.remove("github")).toEqual({ kind: "denied", reason: "owner said no" });
  });

  test("an approved remove reports what it deleted", async () => {
    const ops = createConnectorOps(() => stub());
    expect(await ops.remove("github")).toEqual({ kind: "applied", detail: "3 items deleted" });
  });

  test("a full reindex REJECTS on denial, and is still reported as denied", async () => {
    const client = stub({
      connectorReindex: vi.fn(async () => {
        throw new Error("consent denied by owner");
      }),
    });
    const ops = createConnectorOps(() => client);
    expect(await ops.reindex("github", "full")).toEqual({
      kind: "denied",
      reason: "consent denied by owner",
    });
  });

  test("a transport error on the same call is a failure, not a denial", async () => {
    const client = stub({
      connectorReindex: vi.fn(async () => {
        throw new Error("socket hang up");
      }),
    });
    const ops = createConnectorOps(() => client);
    expect(await ops.reindex("github", "full")).toEqual({
      kind: "failed",
      message: "socket hang up",
    });
  });

  test("auth forwards the collected fields verbatim alongside the serviceId", async () => {
    const client = stub();
    const ops = createConnectorOps(() => client);
    expect(await ops.auth("github", { personalAccessToken: "ghp_x" })).toEqual({
      kind: "applied",
      detail: "scopes: repo",
    });
    expect(client.connectorAuth).toHaveBeenCalledWith({
      serviceId: "github",
      personalAccessToken: "ghp_x",
    });
  });

  test("auth omits the detail entirely when no scopes come back, rather than a dangling colon", async () => {
    const client = stub({
      connectorAuth: vi.fn(async () => ({
        ok: true as const,
        serviceId: "github",
        scopesGranted: [],
      })),
    });
    const ops = createConnectorOps(() => client);
    expect(await ops.auth("github", { personalAccessToken: "ghp_x" })).toEqual({
      kind: "applied",
    });
  });

  test("reindex renders the Gateway's mode in plain wording, not its internal vocabulary", async () => {
    const client = stub({
      connectorReindex: vi.fn(async () => ({
        itemsAffected: 12,
        depth: "full" as const,
        mode: "shallow" as const,
      })),
    });
    const ops = createConnectorOps(() => client);
    expect(await ops.reindex("github", "metadata_only")).toEqual({
      kind: "applied",
      detail: "12 items · trimmed to a shallower depth",
    });
  });
});

test("the client is resolved per call, never captured", async () => {
  let current: ConnectorClientLike | undefined;
  const ops = createConnectorOps(() => current);
  expect(await ops.pause("github")).toMatchObject({ kind: "failed" });
  current = stub();
  expect(await ops.pause("github")).toEqual({ kind: "applied" });
});
describe("setConfig detail wording", () => {
  // `undefined` means "not part of this call" and drops out of the sentence;
  // `false` is a request to DISABLE and must survive as a word. A truthiness
  // test here would report a disable as if nothing had been asked for.
  test.each([
    [{ enabled: true }, "enabled"],
    [{ enabled: false }, "disabled"],
    [{ depth: "full" as const }, "depth full"],
    [{ intervalMs: 900_000, depth: "summary" as const }, "interval 15m, depth summary"],
    [
      { intervalMs: 3_600_000, depth: "metadata_only" as const, enabled: false },
      "interval 1h, depth metadata_only, disabled",
    ],
  ])("%o reports %s", async (params, detail) => {
    const client = stub();
    const ops = createConnectorOps(() => client);
    expect(await ops.setConfig({ serviceId: "github", ...params })).toEqual({
      kind: "applied",
      detail,
    });
    expect(client.connectorSetConfig).toHaveBeenCalledWith({ serviceId: "github", ...params });
  });
});

describe("the remaining mutations", () => {
  test("a plain sync says it started, without claiming the cursor was cleared", async () => {
    const client = stub();
    const ops = createConnectorOps(() => client);
    expect(await ops.sync("github")).toEqual({ kind: "applied", detail: "sync started" });
    expect(client.connectorSync).toHaveBeenCalledWith({ serviceId: "github" });
  });

  test("resume carries no detail — there is nothing to report beyond 'done'", async () => {
    const client = stub();
    const ops = createConnectorOps(() => client);
    expect(await ops.resume("github")).toEqual({ kind: "applied" });
    expect(client.connectorResume).toHaveBeenCalledWith({ serviceId: "github" });
  });

  test("a Gateway that resolves ok:false is a failure, not a silent success", async () => {
    const ops = createConnectorOps(() =>
      stub({ connectorPause: vi.fn(async () => ({ ok: false })) }),
    );
    expect(await ops.pause("github")).toEqual({
      kind: "failed",
      message: "The Gateway did not apply the change.",
    });
  });

  test("addMcp names what it added", async () => {
    const client = stub();
    const ops = createConnectorOps(() => client);
    expect(await ops.addMcp("mcp_acme", "npx -y @acme/mcp-server")).toEqual({
      kind: "applied",
      detail: "added mcp_acme",
    });
    expect(client.connectorAddMcp).toHaveBeenCalledWith({
      serviceId: "mcp_acme",
      commandLine: "npx -y @acme/mcp-server",
    });
  });

  test("a denied addMcp is a decision carrying the Gateway's reason, not a failure", async () => {
    const ops = createConnectorOps(() =>
      stub({
        connectorAddMcp: vi.fn(async () => ({
          status: "rejected" as const,
          reason: "owner declined the new server",
        })),
      }),
    );
    expect(await ops.addMcp("mcp_acme", "npx -y @acme/mcp-server")).toEqual({
      kind: "denied",
      reason: "owner declined the new server",
    });
  });
});

describe("reads", () => {
  test("detail asks for stats — the row's item count comes from them", async () => {
    const client = stub();
    const ops = createConnectorOps(() => client);
    await ops.detail("github");
    expect(client.connectorStatus).toHaveBeenCalledWith({
      serviceId: "github",
      includeStats: true,
    });
  });
});
