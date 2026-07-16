import { describe, expect, test } from "vitest";

import { formatEgressBadge } from "../../src/status-bar/egress-status-bar-item.js";

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
