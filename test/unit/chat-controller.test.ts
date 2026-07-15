import type { AskStreamHandle, StreamEvent } from "@nimbus-dev/client";
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

// A stream handle that yields a fixed list of events, then completes.
function streamOf(events: StreamEvent[], streamId = "s1"): AskStreamHandle {
  return {
    streamId,
    cancel: vi.fn(async () => undefined),
    [Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
      let i = 0;
      return {
        async next(): Promise<IteratorResult<StreamEvent>> {
          if (i >= events.length) return { value: undefined as never, done: true };
          return { value: events[i++] as StreamEvent, done: false };
        },
      };
    },
  } as unknown as AskStreamHandle;
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

function fakeChatClient(over: Partial<ChatClientLike> = {}): ChatClientLike {
  return {
    askStream: () => pendingStream().handle,
    cancelStream: async () => ({ ok: true }),
    getSessionTranscript: async () => ({ sessionId: "", turns: [], hasMore: false }),
    ...over,
  };
}

describe("ChatController", () => {
  test("resume sets the session, resets the panel, then hydrates the transcript", async () => {
    const set = vi.fn(async () => undefined);
    const getSessionTranscript = vi.fn(async () => ({
      sessionId: "s9",
      turns: [{ role: "user" as const, text: "hi", timestamp: 1 }],
      hasMore: false,
    }));
    const { panel, posted } = capturingPanel();
    const ctrl = createChatController(
      baseDeps(fakeChatClient({ getSessionTranscript }), {
        panel,
        sessionStore: { get: () => undefined, set, clear: async () => undefined },
      }),
    );
    await ctrl.resume("s9", 50);
    expect(set).toHaveBeenCalledWith("s9");
    expect(postedTypes(posted)).toEqual(["reset", "hydrate"]);
    expect(getSessionTranscript).toHaveBeenCalledWith({ sessionId: "s9", limit: 50 });
  });

  test("resume cancels an in-flight stream before switching sessions", async () => {
    const { handle, cancel } = pendingStream();
    const { panel } = capturingPanel();
    const ctrl = createChatController(
      baseDeps(fakeChatClient({ askStream: () => handle }), { panel }),
    );
    const p = ctrl.start("hi");
    await Promise.resolve();
    expect(ctrl.isStreaming()).toBe(true);
    await ctrl.resume("s2", 10);
    expect(cancel).toHaveBeenCalled();
    expect(ctrl.isStreaming()).toBe(false);
    await p;
  });

  test("a superseded stream's late done does not clobber the resumed session", async () => {
    // A stream that emits done(sessionId:"old") only after cancel() releases it.
    let release = (): void => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const handle = {
      streamId: "s1",
      cancel: vi.fn(async () => release()),
      [Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
        let sent = false;
        return {
          async next(): Promise<IteratorResult<StreamEvent>> {
            if (sent) return { value: undefined as never, done: true };
            await gate;
            sent = true;
            return { value: { type: "done", reply: "", sessionId: "old" }, done: false };
          },
        };
      },
    } as unknown as AskStreamHandle;
    const set = vi.fn(async (_id: string) => undefined);
    const { panel } = capturingPanel();
    const ctrl = createChatController(
      baseDeps(fakeChatClient({ askStream: () => handle }), {
        panel,
        sessionStore: { get: () => undefined, set, clear: async () => undefined },
      }),
    );
    const p = ctrl.start("hi");
    await Promise.resolve();
    await ctrl.resume("new", 10);
    await p;
    const written = set.mock.calls.map((c) => c[0]);
    expect(written).toContain("new");
    expect(written).not.toContain("old");
  });

  test("resume posts an empty state when the transcript load fails", async () => {
    const { panel, posted } = capturingPanel();
    const ctrl = createChatController(
      baseDeps(
        fakeChatClient({
          getSessionTranscript: async () => {
            throw new Error("nope");
          },
        }),
        { panel },
      ),
    );
    await ctrl.resume("s3", 5);
    expect(postedTypes(posted)).toEqual(["reset", "emptyState"]);
  });

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

  test("a stream error event posts an error message and logs it", async () => {
    const { panel, posted } = capturingPanel();
    const log = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
    const ctrl = createChatController(
      baseDeps(
        fakeChatClient({
          askStream: () => streamOf([{ type: "error", code: "E_BOOM", message: "kaboom" }]),
        }),
        { panel, log },
      ),
    );
    await ctrl.start("hi");
    const err = posted.find((m) => (m as { type: string }).type === "error") as
      | { message?: string }
      | undefined;
    expect(err?.message).toBe("kaboom");
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining("kaboom"));
    expect(ctrl.isStreaming()).toBe(false);
  });

  test("a hitlBatch event posts an inline HITL prompt", async () => {
    const { panel, posted } = capturingPanel();
    const ctrl = createChatController(
      baseDeps(
        fakeChatClient({
          askStream: () =>
            streamOf([
              { type: "hitlBatch", requestId: "req-1", prompt: "allow?", details: { foo: 1 } },
              { type: "done", reply: "", sessionId: "" },
            ]),
        }),
        { panel },
      ),
    );
    await ctrl.start("hi");
    const inline = posted.find((m) => (m as { type: string }).type === "hitlInline") as
      | { requestId?: string; prompt?: string }
      | undefined;
    expect(inline?.requestId).toBe("req-1");
    expect(inline?.prompt).toBe("allow?");
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
    const ctrl = createChatController(
      baseDeps({ askStream: () => handle } as unknown as ChatClientLike),
    );
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
