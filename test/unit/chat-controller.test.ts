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

// A stream handle whose cancel() itself stays unresolved (awaiting the same
// gate as the iterator) until the test calls releaseCancel(). Unlike
// pendingStream() — whose cancel() resolves as soon as its synchronous release()
// call runs, i.e. almost immediately — this lets a test observe state WHILE
// cancel() is still genuinely in flight, over multiple microtask turns.
function pendingCancelStream(streamId = "s1"): {
  handle: AskStreamHandle;
  releaseCancel: () => void;
} {
  let releaseCancel = (): void => undefined;
  const gate = new Promise<void>((r) => {
    releaseCancel = r;
  });
  const handle = {
    streamId,
    cancel: vi.fn(async () => {
      await gate;
    }),
    [Symbol.asyncIterator](): AsyncIterator<never> {
      return {
        async next(): Promise<IteratorResult<never>> {
          await gate;
          return { value: undefined as never, done: true };
        },
      };
    },
  };
  return { handle: handle as unknown as AskStreamHandle, releaseCancel };
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
    readFile: () => undefined,
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

  test("a superseded stream's late event does not clobber the newly active stream", async () => {
    // Stream A blocks until manually released, independent of cancel(), so the
    // test controls exactly when A's late event is delivered relative to B
    // starting — reproducing the race where A's teardown runs after B is active.
    let releaseA = (): void => undefined;
    const gateA = new Promise<void>((r) => {
      releaseA = r;
    });
    const handleA = {
      streamId: "sA",
      cancel: vi.fn(async () => undefined),
      [Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
        let sent = false;
        return {
          async next(): Promise<IteratorResult<StreamEvent>> {
            if (sent) return { value: undefined as never, done: true };
            await gateA;
            sent = true;
            return { value: { type: "token", text: "late-from-A" }, done: false };
          },
        };
      },
    } as unknown as AskStreamHandle;
    const { handle: handleB, cancel: cancelB } = pendingStream("sB");

    let call = 0;
    const askStream = vi.fn(() => (call++ === 0 ? handleA : handleB));
    const { panel, posted } = capturingPanel();
    const ctrl = createChatController(baseDeps(fakeChatClient({ askStream }), { panel }));

    const pA = ctrl.start("hi");
    await Promise.resolve();
    await ctrl.stop(); // supersedes A: active becomes undefined, A.cancel() is called
    const pB = ctrl.start("bye"); // active becomes handleB
    await Promise.resolve();
    expect(ctrl.isStreaming()).toBe(true);

    // Now let A's late event arrive, after B is already the active stream.
    releaseA();
    await pA;

    expect(ctrl.isStreaming()).toBe(true); // still B — A's teardown must not clear it
    expect(postedTypes(posted)).not.toContain("token"); // A's late event was never posted
    expect(postedTypes(posted)).toEqual(["userMessage", "cancelled", "userMessage"]);

    await ctrl.stop();
    await pB;
    expect(cancelB).toHaveBeenCalledTimes(1);
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
      readFile: () => undefined,
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

  test("surfaces a thrown stream error as an error message in the panel", async () => {
    // The Gateway agent can fail mid-stream (e.g. "No LLM provider available"),
    // which the client surfaces by throwing from the async iterator rather than
    // yielding an error event. That must still reach the user as a visible turn.
    const throwing = {
      streamId: "s1",
      cancel: vi.fn(async () => undefined),
      [Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
        return {
          async next(): Promise<IteratorResult<StreamEvent>> {
            throw new Error("No LLM provider available");
          },
        };
      },
    } as unknown as AskStreamHandle;
    const { panel, posted } = capturingPanel();
    const ctrl = createChatController(
      baseDeps(fakeChatClient({ askStream: () => throwing }), { panel }),
    );
    await ctrl.start("hi");
    const err = posted.find((m) => (m as { type: string }).type === "error") as
      | { message?: string }
      | undefined;
    expect(err?.message).toContain("No LLM provider available");
    expect(ctrl.isStreaming()).toBe(false);
  });

  test("shows a no-answer notice when the stream ends without producing content", async () => {
    // A Gateway with no working model can complete the stream immediately with
    // an empty reply and no tokens; an empty assistant bubble tells the user
    // nothing, so surface an explicit notice instead.
    const { panel, posted } = capturingPanel();
    const ctrl = createChatController(
      baseDeps(
        fakeChatClient({
          askStream: () => streamOf([{ type: "done", reply: "", sessionId: "" }]),
        }),
        { panel },
      ),
    );
    await ctrl.start("hi");
    const err = posted.find((m) => (m as { type: string }).type === "error") as
      | { message?: string }
      | undefined;
    expect(err?.message).toMatch(/no answer|LLM provider|Gateway/i);
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
      readFile: () => undefined,
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
      readFile: () => undefined,
    });
    await ctrl.newConversation();
    expect(cleared).toHaveBeenCalled();
    expect(posted.some((m) => (m as { type: string }).type === "reset")).toBe(true);
  });

  test("newConversation posts an empty attachments manifest, so the composer stops showing dropped chips", async () => {
    const { panel, posted } = capturingPanel();
    const ctrl = createChatController(baseDeps(fakeChatClient(), { panel }));
    ctrl.attach({ kind: "selection", path: "a.ts", startLine: 1, endLine: 2, text: "hello" });
    posted.length = 0; // discard the attach()-triggered post
    await ctrl.newConversation();
    const attachmentsMsgs = posted.filter(
      (m) => (m as { type: string }).type === "attachments",
    ) as Array<{ chips: readonly unknown[] }>;
    expect(attachmentsMsgs).toHaveLength(1);
    expect(attachmentsMsgs[0]?.chips).toEqual([]);
    expect(ctrl.attachments()).toEqual([]);
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

  test("stop() posts the cancelled message before cancel() resolves", async () => {
    // cancel() stays pending until we release it, so if the implementation
    // ever posted "cancelled" AFTER `await handle.cancel()`, this test would
    // observe no "cancelled" message yet at the assertion point below.
    const { handle, releaseCancel } = pendingCancelStream();
    const { panel, posted } = capturingPanel();
    const ctrl = createChatController(
      baseDeps(fakeChatClient({ askStream: () => handle }), { panel }),
    );
    const pStart = ctrl.start("hi");
    await Promise.resolve();
    expect(ctrl.isStreaming()).toBe(true);

    const pStop = ctrl.stop();
    await Promise.resolve(); // flush the microtask that posts "cancelled"
    expect(postedTypes(posted)).toContain("cancelled"); // posted while cancel() is still pending

    releaseCancel();
    await pStop;
    await pStart;
    expect(ctrl.isStreaming()).toBe(false);
  });

  test("stop() is a no-op when nothing is streaming", async () => {
    const ctrl = createChatController(baseDeps(new MockClient()));
    await expect(ctrl.stop()).resolves.toBeUndefined();
  });

  test("stop() posts a cancelled message to the webview when a stream is active", async () => {
    const { handle } = pendingStream();
    const { panel, posted } = capturingPanel();
    const ctrl = createChatController(
      baseDeps(fakeChatClient({ askStream: () => handle }), { panel }),
    );
    const p = ctrl.start("hi");
    await Promise.resolve();
    await ctrl.stop();
    await p;
    expect(postedTypes(posted)).toContain("cancelled");
  });

  test("stop() posts no cancelled message when nothing is streaming", async () => {
    const { panel, posted } = capturingPanel();
    const ctrl = createChatController(baseDeps(new MockClient(), { panel }));
    await ctrl.stop();
    expect(postedTypes(posted)).not.toContain("cancelled");
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

  test("rehydrateIfNeeded does not post while a stream is active", async () => {
    // On a fresh panel the webview posts "ready" mid-stream, which drives
    // onReady -> rehydrateIfNeeded. That must NOT run: its emptyState/hydrate
    // would clobber the live conversation the buffered stream just delivered.
    const { handle } = pendingStream();
    const { panel, posted } = capturingPanel();
    const ctrl = createChatController(
      baseDeps(fakeChatClient({ askStream: () => handle }), { panel }),
    );
    const p = ctrl.start("hi");
    await Promise.resolve();
    expect(ctrl.isStreaming()).toBe(true);

    await ctrl.rehydrateIfNeeded(50);

    expect(postedTypes(posted)).not.toContain("emptyState");
    expect(postedTypes(posted)).not.toContain("hydrate");

    await ctrl.stop();
    await p;
  });

  test("rehydrateIfNeeded aborts if a stream starts while the transcript is loading", async () => {
    // TOCTOU: the synchronous guard passes (no active stream), then start() sets
    // `active` during the getSessionTranscript await. The resolved hydrate must
    // not post over the now-live stream.
    let releaseTranscript = (): void => undefined;
    const gate = new Promise<void>((r) => {
      releaseTranscript = r;
    });
    const client: ChatClientLike = {
      askStream: () => pendingStream("sX").handle,
      cancelStream: async () => ({ ok: true }),
      getSessionTranscript: async () => {
        await gate;
        return {
          sessionId: "s",
          turns: [{ role: "user" as const, text: "old", timestamp: 1 }],
          hasMore: false,
        };
      },
    };
    const { panel, posted } = capturingPanel();
    const ctrl = createChatController(
      baseDeps(client, {
        panel,
        sessionStore: { get: () => "s", set: async () => undefined, clear: async () => undefined },
      }),
    );
    const pRehydrate = ctrl.rehydrateIfNeeded(50); // passes sync guard, awaits transcript
    await Promise.resolve();
    const pStart = ctrl.start("hi"); // sets active during the await
    await Promise.resolve();
    expect(ctrl.isStreaming()).toBe(true);
    releaseTranscript();
    await pRehydrate;
    expect(postedTypes(posted)).not.toContain("hydrate");
    await ctrl.stop();
    await pStart;
  });

  test("a stale resume transcript does not overwrite a newer resumed session", async () => {
    // Two resume()s race: resume("A") is slow to load; resume("B") starts before
    // A resolves. Both pass the active guard (resume clears `active`), so A's
    // late transcript must be invalidated by session generation, not posted.
    let releaseA = (): void => undefined;
    let releaseB = (): void => undefined;
    const gateA = new Promise<void>((r) => {
      releaseA = r;
    });
    const gateB = new Promise<void>((r) => {
      releaseB = r;
    });
    const client: ChatClientLike = {
      askStream: () => pendingStream().handle,
      cancelStream: async () => ({ ok: true }),
      getSessionTranscript: async ({ sessionId }) => {
        await (sessionId === "A" ? gateA : gateB);
        return {
          sessionId,
          turns: [{ role: "user" as const, text: `turns-${sessionId}`, timestamp: 1 }],
          hasMore: false,
        };
      },
    };
    const { panel, posted } = capturingPanel();
    const ctrl = createChatController(
      baseDeps(client, {
        panel,
        sessionStore: {
          get: () => undefined,
          set: async () => undefined,
          clear: async () => undefined,
        },
      }),
    );
    const pA = ctrl.resume("A", 50);
    await Promise.resolve();
    await Promise.resolve();
    const pB = ctrl.resume("B", 50);
    await Promise.resolve();
    await Promise.resolve();
    releaseB();
    await pB;
    releaseA();
    await pA;
    const hydrates = posted.filter((m) => (m as { type: string }).type === "hydrate") as Array<{
      turns: Array<{ text: string }>;
    }>;
    const postedStaleA = hydrates.some((h) => h.turns.some((t) => t.text === "turns-A"));
    expect(postedStaleA).toBe(false);
  });

  test("subTaskProgress events post subTask messages, with progress only when present", async () => {
    const { panel, posted } = capturingPanel();
    const ctrl = createChatController(
      baseDeps(
        fakeChatClient({
          askStream: () =>
            streamOf([
              { type: "subTaskProgress", subTaskId: "t1", status: "running", progress: 0.5 },
              { type: "subTaskProgress", subTaskId: "t2", status: "queued" },
              { type: "done", reply: "", sessionId: "" },
            ]),
        }),
        { panel },
      ),
    );
    await ctrl.start("hi");
    const subTasks = posted.filter((m) => (m as { type: string }).type === "subTask") as Array<{
      subTaskId: string;
      status: string;
      progress?: number;
    }>;
    expect(subTasks).toHaveLength(2);
    expect(subTasks[0]).toEqual({
      type: "subTask",
      subTaskId: "t1",
      status: "running",
      progress: 0.5,
    });
    expect(subTasks[1]).toEqual({ type: "subTask", subTaskId: "t2", status: "queued" });
    expect("progress" in (subTasks[1] as object)).toBe(false);
  });

  test("start() surfaces a synchronous askStream failure as an error message", async () => {
    const { panel, posted } = capturingPanel();
    const log = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
    const ctrl = createChatController(
      baseDeps(
        fakeChatClient({
          askStream: () => {
            throw new Error("ENOENT: nimbus binary not found");
          },
        }),
        { panel, log },
      ),
    );
    await ctrl.start("hi");
    expect(postedTypes(posted)).toEqual(["userMessage", "error"]);
    const err = posted.find((m) => (m as { type: string }).type === "error") as
      | { message?: string }
      | undefined;
    expect(err?.message).toContain("couldn't start the request");
    expect(err?.message).toContain("ENOENT: nimbus binary not found");
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining("askStream failed to start"));
    expect(ctrl.isStreaming()).toBe(false);
  });

  test("a synchronous askStream failure retracts the turn's attachment manifest instead of leaving it standing", async () => {
    const { panel, posted } = capturingPanel();
    const ctrl = createChatController(
      baseDeps(
        fakeChatClient({
          askStream: () => {
            throw new Error("boom");
          },
        }),
        { panel },
      ),
    );
    // Give the turn something to attach, so a turnAttachments manifest is
    // actually posted before the synchronous throw.
    ctrl.attach({ kind: "selection", path: "a.ts", startLine: 1, endLine: 2, text: "hello" });
    posted.length = 0; // discard the attach()-triggered "attachments" post
    await ctrl.start("hi");
    // The manifest was posted BEFORE askStream (required — the resolved
    // preview must reach the webview before the request leaves), then
    // retracted in the catch path once the request turned out never to have
    // gone out. The webview must never be left claiming attachments were sent
    // on a turn that failed to start.
    expect(postedTypes(posted)).toEqual([
      "attachments",
      "turnAttachments",
      "attachments",
      "turnAttachmentsFailed",
      "userMessage",
      "error",
    ]);
  });

  test("a synchronous askStream failure with nothing attached posts no manifest to retract", async () => {
    const { panel, posted } = capturingPanel();
    const ctrl = createChatController(
      baseDeps(
        fakeChatClient({
          askStream: () => {
            throw new Error("boom");
          },
        }),
        { panel },
      ),
    );
    await ctrl.start("hi");
    expect(postedTypes(posted)).toEqual(["userMessage", "error"]);
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
