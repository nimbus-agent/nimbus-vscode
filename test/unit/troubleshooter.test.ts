import { describe, expect, test } from "vitest";

import type { ConnectionState } from "../../src/connection/connection-manager.js";
import { buildTroubleshooter } from "../../src/connection/troubleshooter.js";

const unix = { autoStartGateway: false, platform: "linux" as NodeJS.Platform };

function commandsOf(state: ConnectionState, opts = unix): string[] {
  return buildTroubleshooter(state, opts).actions.map((a) => a.command);
}

describe("buildTroubleshooter", () => {
  test("connected → info + open logs, message names the socket", () => {
    const r = buildTroubleshooter({ kind: "connected", socketPath: "/run/n.sock" }, unix);
    expect(r.level).toBe("info");
    expect(r.message).toContain("/run/n.sock");
    expect(r.actions.map((a) => a.command)).toEqual(["nimbus.openLogs"]);
  });

  test("disconnected + autoStart off → error, offers Start Gateway", () => {
    const r = buildTroubleshooter(
      { kind: "disconnected", socketPath: "/run/n.sock", reason: "ECONNREFUSED" },
      unix,
    );
    expect(r.level).toBe("error");
    expect(r.actions.map((a) => a.command)).toContain("nimbus.startGateway");
  });

  test("disconnected + autoStart on → warn, offers Reconnect not Start", () => {
    const r = buildTroubleshooter(
      { kind: "disconnected", socketPath: "/run/n.sock", reason: "x" },
      { autoStartGateway: true, platform: "linux" },
    );
    expect(r.level).toBe("warn");
    expect(
      commandsOf(
        { kind: "disconnected", socketPath: "/run/n.sock", reason: "x" },
        {
          autoStartGateway: true,
          platform: "linux",
        },
      ),
    ).toEqual(["nimbus.reconnect", "nimbus.openLogs"]);
  });

  test("permission-denied on Unix mentions chmod/chown and offers Edit setting", () => {
    const r = buildTroubleshooter(
      { kind: "permission-denied", socketPath: "/run/n.sock" },
      { autoStartGateway: false, platform: "linux" },
    );
    expect(r.message).toMatch(/chmod|chown/);
    expect(r.actions[0]?.command).toBe("workbench.action.openSettings");
    expect(r.actions[0]?.args).toEqual(["nimbus.socketPath"]);
  });

  test("permission-denied on Windows mentions named-pipe access", () => {
    const r = buildTroubleshooter(
      { kind: "permission-denied", socketPath: "\\\\.\\pipe\\nimbus" },
      { autoStartGateway: false, platform: "win32" },
    );
    expect(r.message).toMatch(/named.pipe/i);
    expect(r.message).not.toMatch(/chmod/);
  });

  test("idle → warn, offers reconnect", () => {
    const r = buildTroubleshooter({ kind: "idle" }, unix);
    expect(r.level).toBe("warn");
    expect(r.actions.map((a) => a.command)).toContain("nimbus.reconnect");
  });

  test("connecting → info, offers reconnect", () => {
    expect(commandsOf({ kind: "connecting", socketPath: "/run/n.sock" })).toEqual([
      "nimbus.reconnect",
      "nimbus.openLogs",
    ]);
  });

  test("connected + ping ok reports gateway version and uptime", () => {
    const r = buildTroubleshooter(
      { kind: "connected", socketPath: "/run/n.sock" },
      { ...unix, ping: { ok: true, version: "0.24.0", uptime: 5 * 60_000 } },
    );
    expect(r.level).toBe("info");
    expect(r.message).toContain("v0.24.0");
    expect(r.message).toContain("5 min");
  });

  test("connected + ping failure warns: socket up, gateway unresponsive", () => {
    const r = buildTroubleshooter(
      { kind: "connected", socketPath: "/run/n.sock" },
      { ...unix, ping: { ok: false, error: "timeout" } },
    );
    expect(r.level).toBe("warn");
    expect(r.message).toContain("not responding");
    expect(r.message).toContain("timeout");
    expect(r.actions.map((a) => a.command)).toContain("nimbus.reconnect");
  });

  test("connected without ping input keeps the legacy message", () => {
    const r = buildTroubleshooter({ kind: "connected", socketPath: "/run/n.sock" }, unix);
    expect(r.message).toBe("Connected to the Gateway at /run/n.sock.");
  });
});
