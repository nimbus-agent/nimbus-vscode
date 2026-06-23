import type { AskStreamHandle } from "@nimbus-dev/client";
import { MockClient } from "@nimbus-dev/client";
import { describe, expect, test, vi } from "vitest";
import { type ChatClientLike, createChatController } from "../../src/chat/chat-controller.js";
import { type ChatPanel, createNoopChatPanel } from "../../src/chat/chat-panel.js";

// A stream handle that blocks forever until cancel() is called, so a test can
// observe an in-flight stream (isStreaming === true) and then tear it down.
function pendingStream(streamId = "s1"): {
  handle: AskStreamHandle;
  cancel: ReturnType<typeof vi.fn>;
} {
  let release = (): void => undefined;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const cancel = vi.fn(async () => {
    release();
  });
  const handle = {
    streamId,
    cancel,
    [Symbol.asyncIterator](): AsyncIterator<never> {
      return {
        async next(): Promise<IteratorResult<never>> {
          await gate;
          return { value: undefined as never, done: true };
        },
      };
    },
  };
  return { handle: handle as unknown as AskStreamHandle, cancel };
}

function capturingPanel(): { panel: ChatPanel; posted: unknown[] } {
  const panel = createNoopChatPanel();
  const posted: unknown[] = [];
  panel.postMessage = vi.fn(async (m) => {
    posted.push(m);
    return true;
  });
  return { panel, posted };
}

function baseDeps(
  client: ChatClientLike,
  over: Partial<Parameters<typeof createChatController>[0]> = {},
): Parameters<typeof createChatController>[0] {
  return {
    client,
    panel: createNoopChatPanel(),
    sessionStore: {
      get: () => undefined,
      set: async () => undefined,
      clear: async () => undefined,
    },
    registerStreamWithHitl: () => undefined,
    unregisterStreamWithHitl: () => undefined,
    log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
    ...over,
  };
}

function postedTypes(posted: unknown[]): string[] {
  return posted.map((m) => (m as { type: string }).type);
}

describe("ChatController", () => {
  test("askStream messages get translated to webview postMessage", async () => {
    const panel = createNoopChatPanel();
    const posted: unknown[] = [];
    panel.postMessage = vi.fn(async (msg) => {
      posted.push(msg);
      return true;
    });
    const client = new MockClient({ streamTokens: ["a", "b"], reply: "ab" });
    const ctrl = createChatController({
      client,
      panel,
      sessionStore: {
        get: () => undefined,
        set: async () => undefined,
        clear: async () => undefined,
      },
      registerStreamWithHitl: () => undefined,
      unregisterStreamWithHitl: () => undefined,
      log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
    });
    await ctrl.start("hi");
    const types = posted.map((m) => (m as { type: string }).type);
    expect(types).toContain("userMessage");
    expect(types).toContain("token");
    expect(types).toContain("done");
  });

  test("rejects start while a stream is in progress", async () => {
    const panel = createNoopChatPanel();
    const client = new MockClient({ streamTokens: ["a"] });
    const ctrl = createChatController({
      client,
      panel,
      sessionStore: {
        get: () => undefined,
        set: async () => undefined,
        clear: async () => undefined,
      },
      registerStreamWithHitl: () => undefined,
      unregisterStreamWithHitl: () => undefined,
      log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
    });
    const p = ctrl.start("first");
    await expect(ctrl.start("second")).rejects.toThrow(/in progress/i);
    await p;
  });

  test("newConversation clears sessionId and posts reset", async () => {
    const panel = createNoopChatPanel();
    const posted: unknown[] = [];
    panel.postMessage = vi.fn(async (m) => {
      posted.push(m);
      return true;
    });
    const cleared = vi.fn(async () => undefined);
    const client = new MockClient();
    const ctrl = createChatController({
      client,
      panel,
      sessionStore: {
        get: () => "sess-old",
        set: async () => undefined,
        clear: cleared,
      },
      registerStreamWithHitl: () => undefined,
      unregisterStreamWithHitl: () => undefined,
      log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
    });
    await ctrl.newConversation();
    expect(cleared).toHaveBeenCalled();
    expect(posted.some((m) => (m as { type: string }).type === "reset")).toBe(true);
  });

  test("stop() cancels the in-flight stream and clears the streaming flag", async () => {
    const { handle, cancel } = pendingStream();
    const ctrl = createChatController(baseDeps({ askStream: () => handle } as unknown as ChatClientLike));
    const p = ctrl.start("hi");
    await Promise.resolve();
    expect(ctrl.isStreaming()).toBe(true);
    await ctrl.stop();
    await p;
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(ctrl.isStreaming()).toBe(false);
  });

  test("stop() is a no-op when nothing is streaming", async () => {
    const ctrl = createChatController(baseDeps(new MockClient()));
    await expect(ctrl.stop()).resolves.toBeUndefined();
  });

  test("newConversation cancels an in-flight stream before resetting", async () => {
    const { handle, cancel } = pendingStream();
    const { panel, posted } = capturingPanel();
    const cleared = vi.fn(async () => undefined);
    const ctrl = createChatController(
      baseDeps({ askStream: () => handle } as unknown as ChatClientLike, {
        panel,
        sessionStore: { get: () => "old", set: async () => undefined, clear: cleared },
      }),
    );
    const p = ctrl.start("hi");
    await Promise.resolve();
    expect(ctrl.isStreaming()).toBe(true);
    await ctrl.newConversation();
    await p;
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cleared).toHaveBeenCalledTimes(1);
    expect(postedTypes(posted)).toContain("reset");
  });

  test("rehydrateIfNeeded posts emptyState when there is no stored session", async () => {
    const { panel, posted } = capturingPanel();
    const ctrl = createChatController(baseDeps(new MockClient(), { panel }));
    await ctrl.rehydrateIfNeeded(50);
    expect(postedTypes(posted)).toContain("emptyState");
  });

  test("rehydrateIfNeeded hydrates the stored transcript turns", async () => {
    const { panel, posted } = capturingPanel();
    const turns = [{ role: "user" as const, text: "hi", timestamp: 1 }];
    const client: ChatClientLike = {
      askStream: () => new MockClient().askStream(""),
      cancelStream: async () => ({ ok: true }),
      getSessionTranscript: async () => ({ sessionId: "s", turns, hasMore: false }),
    };
    const ctrl = createChatController(
      baseDeps(client, {
        panel,
        sessionStore: { get: () => "s", set: async () => undefined, clear: async () => undefined },
      }),
    );
    await ctrl.rehydrateIfNeeded(50);
    const hydrate = posted.find((m) => (m as { type: string }).type === "hydrate") as
      | { turns: unknown[] }
      | undefined;
    expect(hydrate?.turns).toEqual(turns);
  });

  test("rehydrateIfNeeded falls back to emptyState when the transcript fetch fails", async () => {
    const { panel, posted } = capturingPanel();
    const warn = vi.fn();
    const client: ChatClientLike = {
      askStream: () => new MockClient().askStream(""),
      cancelStream: async () => ({ ok: true }),
      getSessionTranscript: async () => {
        throw new Error("boom");
      },
    };
    const ctrl = createChatController(
      baseDeps(client, {
        panel,
        sessionStore: { get: () => "s", set: async () => undefined, clear: async () => undefined },
        log: { error: vi.fn(), warn, info: vi.fn(), debug: vi.fn() },
      }),
    );
    await ctrl.rehydrateIfNeeded(50);
    expect(postedTypes(posted)).toContain("emptyState");
    expect(warn).toHaveBeenCalled();
  });
});
