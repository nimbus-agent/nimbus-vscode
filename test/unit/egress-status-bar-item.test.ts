import { describe, expect, test, vi } from "vitest";

import {
  createEgressStatusBarController,
  formatEgressBadge,
} from "../../src/status-bar/egress-status-bar-item.js";
import type { StatusBarItemHandle } from "../../src/vscode-shim.js";

const base = {
  head: undefined,
  lastKnownCount: undefined,
  error: undefined,
  connected: true,
  showBadge: true,
} as const;

describe("formatEgressBadge", () => {
  test("hidden when the badge setting is off", () => {
    expect(
      formatEgressBadge({ ...base, showBadge: false, head: { head: "abc123", count: 3 } }),
    ).toBeUndefined();
  });

  test("hidden when disconnected", () => {
    expect(
      formatEgressBadge({ ...base, connected: false, head: { head: "abc123", count: 3 } }),
    ).toBeUndefined();
  });

  test("hidden on read error before any successful read", () => {
    expect(formatEgressBadge({ ...base, error: "boom" })).toBeUndefined();
  });

  test("success render: count, short head, check icon, focus command", () => {
    const r = formatEgressBadge({ ...base, head: { head: "3f9a1b2c4d", count: 128 } });
    expect(r?.text).toBe("$(shield) 128 $(check)");
    expect(r?.tooltip).toContain("128 rows");
    expect(r?.tooltip).toContain("3f9a1b");
    expect(r?.tooltip).toContain("Verify ledger");
    expect(r?.command).toBe("nimbus.egressView.focus");
  });

  test("stale render after error keeps last-known count with a warning icon", () => {
    const r = formatEgressBadge({
      ...base,
      head: undefined,
      lastKnownCount: 128,
      error: "ECONNRESET",
    });
    expect(r?.text).toBe("$(shield) 128 $(warning)");
    expect(r?.tooltip).toContain("last known 128");
    expect(r?.tooltip).toContain("ECONNRESET");
    expect(r?.text).not.toMatch(/egress/i);
  });
});

function makeFakeStatusBarItem(): StatusBarItemHandle {
  return {
    text: "",
    tooltip: undefined,
    command: undefined,
    backgroundColor: undefined,
    show: vi.fn(),
    hide: vi.fn(),
    dispose: vi.fn(),
  };
}

describe("createEgressStatusBarController", () => {
  test("update() with a successful read sets the formatted badge and shows it", () => {
    const item = makeFakeStatusBarItem();
    const controller = createEgressStatusBarController(item);
    controller.update({
      head: { head: "3f9a1b2c", count: 5 },
      lastKnownCount: 5,
      error: undefined,
      connected: true,
      showBadge: true,
    });
    expect(item.text).toBe("$(shield) 5 $(check)");
    expect(item.tooltip).toContain("5 rows");
    expect(item.command).toBe("nimbus.egressView.focus");
    expect(item.show).toHaveBeenCalledTimes(1);
    expect(item.hide).not.toHaveBeenCalled();
  });

  test("update() with a hidden input hides the item without throwing", () => {
    const item = makeFakeStatusBarItem();
    const controller = createEgressStatusBarController(item);
    expect(() =>
      controller.update({
        head: { head: "3f9a1b2c", count: 5 },
        lastKnownCount: 5,
        error: undefined,
        connected: false,
        showBadge: true,
      }),
    ).not.toThrow();
    expect(item.hide).toHaveBeenCalledTimes(1);
    expect(item.show).not.toHaveBeenCalled();
  });

  test("dispose() disposes the underlying status bar item", () => {
    const item = makeFakeStatusBarItem();
    const controller = createEgressStatusBarController(item);
    controller.dispose();
    expect(item.dispose).toHaveBeenCalledTimes(1);
  });
});
