import { describe, expect, test, vi } from "vitest";

import { createEgressGate, SKIP_LABEL } from "../../src/egress/gate.js";
import { createPreflightSkipStore } from "../../src/egress/skip-store.js";

const silentLog = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function memento() {
  const store = new Map<string, unknown>();
  return {
    get: <T>(key: string): T | undefined => store.get(key) as T | undefined,
    update: async (key: string, value: unknown): Promise<void> => {
      if (value === undefined) store.delete(key);
      else store.set(key, value);
    },
  };
}

const meta = { action: "Explain Problem", files: [], omissions: [] };

describe("the diagnostic egress kind", () => {
  test("has a skip label, so the gate's modal can name the surface", () => {
    expect(SKIP_LABEL.diagnostic).toBe("Diagnostic Actions");
  });

  test("round-trips its own skip key, independently of the other kinds", async () => {
    const skips = createPreflightSkipStore(memento());
    await skips.setSkipped("diagnostic");
    expect(skips.isSkipped("diagnostic")).toBe(true);
    expect(skips.isSkipped("brief")).toBe(false);
    await skips.clearAll();
    expect(skips.isSkipped("diagnostic")).toBe(false);
  });

  test("prompts rather than passing through", async () => {
    const showWarningMessage = vi.fn().mockResolvedValue("Send");
    const gate = createEgressGate({
      window: { showWarningMessage },
      openReadonly: vi.fn(),
      skips: createPreflightSkipStore(memento()),
      isTrusted: () => true,
      roots: () => [],
      log: silentLog,
    });
    expect(await gate.check("diagnostic", "the payload", meta)).toBe("send");
    expect(showWarningMessage).toHaveBeenCalled();
  });

  test("cancelling at the preview refuses the send", async () => {
    const gate = createEgressGate({
      window: { showWarningMessage: vi.fn().mockResolvedValue(undefined) },
      openReadonly: vi.fn(),
      skips: createPreflightSkipStore(memento()),
      isTrusted: () => true,
      roots: () => [],
      log: silentLog,
    });
    expect(await gate.check("diagnostic", "the payload", meta)).toBe("cancel");
  });
});
