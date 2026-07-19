import { describe, expect, test } from "vitest";

import type { ConnectionState } from "../../src/connection/connection-manager.js";
import { formatStatusBar, type StatusBarInputs } from "../../src/status-bar/status-bar-item.js";

function inputs(p: Partial<StatusBarInputs> = {}): StatusBarInputs {
  return {
    connection: { kind: "connected", socketPath: "/run/nimbus-test/s" },
    profile: "work",
    degradedConnectorCount: 0,
    degradedConnectorNames: [],
    pendingHitlCount: 0,
    autoStartGateway: false,
    ...p,
  };
}

describe("formatStatusBar", () => {
  test("connecting state", () => {
    const r = formatStatusBar(inputs({ connection: { kind: "connecting", socketPath: "/x" } }));
    expect(r.text).toMatch(/connecting/);
    expect(r.command).toBeUndefined();
  });

  test("disconnected, autostart off", () => {
    const r = formatStatusBar(
      inputs({
        connection: { kind: "disconnected", socketPath: "/x", reason: "no socket" },
      }),
    );
    expect(r.text).toMatch(/Gateway not running/);
    expect(r.backgroundColor?.id).toMatch(/warningBackground/);
    expect(r.command).toBe("nimbus.startGateway");
  });

  test("disconnected with autostart on shows starting-Gateway", () => {
    const r = formatStatusBar(
      inputs({
        connection: { kind: "disconnected", socketPath: "/x", reason: "no socket" },
        autoStartGateway: true,
      }),
    );
    expect(r.text).toMatch(/starting Gateway/);
    expect(r.command).toBeUndefined();
    expect(r.backgroundColor).toBeUndefined();
  });

  test("starting-gateway state is a non-actionable spinner", () => {
    const r = formatStatusBar(
      inputs({ connection: { kind: "starting-gateway", socketPath: "/x" } }),
    );
    expect(r.text).toMatch(/starting Gateway/);
    expect(r.tooltip).toContain("waiting for socket");
    expect(r.command).toBeUndefined();
  });

  test("permission denied has distinct state and tooltip", () => {
    const r = formatStatusBar(
      inputs({ connection: { kind: "permission-denied", socketPath: "/sock" } }),
    );
    expect(r.text).toMatch(/Socket permission denied/);
    expect(r.tooltip).toContain("/sock");
    expect(r.backgroundColor?.id).toMatch(/errorBackground/);
  });

  test("connected healthy opens the quick-actions menu", () => {
    const r = formatStatusBar(inputs());
    expect(r.text).toMatch(/work/);
    expect(r.text).toMatch(/circle-large-filled/);
    expect(r.command).toBe("nimbus.quickActions");
  });

  test("connected with degraded connector", () => {
    const r = formatStatusBar(
      inputs({ degradedConnectorCount: 2, degradedConnectorNames: ["github", "slack"] }),
    );
    expect(r.text).toMatch(/2 degraded/);
    expect(r.backgroundColor?.id).toMatch(/warningBackground/);
    expect(r.tooltip).toContain("github");
    expect(r.tooltip).toContain("slack");
  });

  test("HITL pending wins over degraded for click action", () => {
    const r = formatStatusBar(inputs({ degradedConnectorCount: 1, pendingHitlCount: 3 }));
    expect(r.text).toMatch(/3 pending/);
    expect(r.text).toMatch(/1 degraded/);
    expect(r.command).toBe("nimbus.showPendingHitl");
  });

  test("an unrecognized non-connected state falls through to the connected renderer", () => {
    // formatNonConnected's if-chain is exhaustive over today's ConnectionState
    // union, but it's a forward-compatibility guard: a future connection kind
    // the chain doesn't recognize yet must fall through (return undefined) so
    // formatStatusBar renders it via formatConnected rather than crashing.
    const unknownState = { kind: "reticulating-splines" } as unknown as ConnectionState;
    const r = formatStatusBar(inputs({ connection: unknownState }));
    expect(r).toEqual(formatStatusBar(inputs()));
  });
});
