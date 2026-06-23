import { describe, expect, test, vi } from "vitest";

import { createNoopChatPanel } from "../../src/chat/chat-panel.js";

describe("createNoopChatPanel", () => {
  test("is inert: no panel, never visible or active, postMessage resolves true", async () => {
    const p = createNoopChatPanel();
    expect(p.panel()).toBeUndefined();
    expect(p.isVisible()).toBe(false);
    expect(p.isActive()).toBe(false);
    expect(p.reveal()).toBeUndefined();
    // onMessage is a no-op sink; registering a handler must not throw.
    expect(() => p.onMessage(() => undefined)).not.toThrow();
    await expect(p.postMessage({ type: "anything" })).resolves.toBe(true);
  });

  test("runs onDispose handlers exactly once across repeated dispose() calls", () => {
    const p = createNoopChatPanel();
    const first = vi.fn();
    const second = vi.fn();
    p.onDispose(first);
    p.onDispose(second);
    p.dispose();
    p.dispose();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });
});
