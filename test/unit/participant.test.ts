import type { AskStreamHandle, AskStreamOptions, StreamEvent } from "@nimbus-dev/client";
import { describe, expect, test, vi } from "vitest";
import { runParticipantTurn } from "../../src/chat-participant/participant.js";
import type {
  CancellationLike,
  ChatResponseSink,
  CitationRef,
  ParticipantClientLike,
  ParticipantDeps,
  ParticipantRequest,
} from "../../src/chat-participant/participant-types.js";

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

// A capturing fake sink.
function fakeSink(): {
  sink: ChatResponseSink;
  md: string[];
  progress: string[];
  citations: CitationRef[];
  buttons: Array<{ title: string; command: string }>;
} {
  const md: string[] = [];
  const progress: string[] = [];
  const citations: CitationRef[] = [];
  const buttons: Array<{ title: string; command: string }> = [];
  return {
    md,
    progress,
    citations,
    buttons,
    sink: {
      markdown: (t) => md.push(t),
      progress: (t) => progress.push(t),
      citation: (c) => citations.push(c),
      button: (title, command) => buttons.push({ title, command }),
    },
  };
}

const noCancel: CancellationLike = {
  isCancelled: false,
  onCancelled: () => ({ dispose: () => undefined }),
};

function fakeClient(over: Partial<ParticipantClientLike> = {}): ParticipantClientLike {
  return {
    askStream: () => streamOf([{ type: "done", reply: "hi", sessionId: "sess" }]),
    searchRanked: async () => [],
    ...over,
  };
}

function deps(over: Partial<ParticipantDeps> = {}): ParticipantDeps {
  return {
    client: () => fakeClient(),
    registerStreamWithHitl: vi.fn(),
    unregisterStreamWithHitl: vi.fn(),
    agent: () => "",
    citationLimit: 5,
    reconnectCommand: "nimbus.troubleshootConnection",
    log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
    ...over,
  };
}

function req(over: Partial<ParticipantRequest> = {}): ParticipantRequest {
  return { prompt: "why", attachments: [], ...over };
}

describe("runParticipantTurn", () => {
  test("disconnected → friendly note + reconnect button, no stream started", async () => {
    const f = fakeSink();
    const askStream = vi.fn();
    const searchRanked = vi.fn();
    const client: ParticipantClientLike = { askStream, searchRanked };
    const result = await runParticipantTurn(req(), deps({ client: () => undefined }), f.sink, noCancel);
    expect(f.md.join(" ")).toMatch(/connect/i);
    expect(f.buttons).toEqual([{ title: expect.any(String), command: "nimbus.troubleshootConnection" }]);
    // The disconnected guard must return before touching a client at all.
    expect(client.askStream).not.toHaveBeenCalled();
    expect(client.searchRanked).not.toHaveBeenCalled();
    expect(result).toEqual({});
  });

  test("streams token events into markdown and returns the session id", async () => {
    const f = fakeSink();
    const client = fakeClient({
      askStream: () =>
        streamOf([
          { type: "token", text: "Hello " },
          { type: "token", text: "world" },
          { type: "done", reply: "Hello world", sessionId: "sess-1" },
        ]),
    });
    const result = await runParticipantTurn(req(), deps({ client: () => client }), f.sink, noCancel);
    expect(f.md.join("")).toBe("Hello world");
    expect(result).toEqual({ sessionId: "sess-1" });
  });

  test("emits citations from searchRanked", async () => {
    const f = fakeSink();
    const client = fakeClient({
      searchRanked: async () => [
        { name: "a.ts", service: "fs", score: 1, canonicalUrl: "file:///w/a.ts" },
      ] as never,
    });
    await runParticipantTurn(req({ prompt: "auth flow" }), deps({ client: () => client }), f.sink, noCancel);
    expect(f.citations).toEqual([{ label: "a.ts", target: "file:///w/a.ts" }]);
  });

  test("a failing searchRanked does not block the answer", async () => {
    const f = fakeSink();
    const client = fakeClient({
      askStream: () => streamOf([{ type: "token", text: "answer" }, { type: "done", reply: "answer", sessionId: "s" }]),
      searchRanked: async () => {
        throw new Error("index down");
      },
    });
    await runParticipantTurn(req(), deps({ client: () => client }), f.sink, noCancel);
    expect(f.md.join("")).toContain("answer");
    expect(f.citations).toEqual([]);
  });

  test("threads priorSessionId into the stream options", async () => {
    const seen: AskStreamOptions[] = [];
    const client = fakeClient({
      askStream: (_input, opts) => {
        seen.push(opts ?? {});
        return streamOf([{ type: "done", reply: "", sessionId: "s2" }]);
      },
    });
    await runParticipantTurn(req({ priorSessionId: "prev" }), deps({ client: () => client }), fakeSink().sink, noCancel);
    expect(seen[0]?.sessionId).toBe("prev");
  });

  test("passes the agent setting when non-empty", async () => {
    const seen: AskStreamOptions[] = [];
    const client = fakeClient({
      askStream: (_i, opts) => {
        seen.push(opts ?? {});
        return streamOf([{ type: "done", reply: "", sessionId: "s" }]);
      },
    });
    await runParticipantTurn(req(), deps({ client: () => client, agent: () => "coder" }), fakeSink().sink, noCancel);
    expect(seen[0]?.agent).toBe("coder");
  });

  test("registers and unregisters the stream with HITL", async () => {
    const registerStreamWithHitl = vi.fn();
    const unregisterStreamWithHitl = vi.fn();
    const client = fakeClient({
      askStream: () => streamOf([{ type: "token", text: "x" }, { type: "done", reply: "x", sessionId: "s" }], "stream-9"),
    });
    await runParticipantTurn(
      req(),
      deps({ client: () => client, registerStreamWithHitl, unregisterStreamWithHitl }),
      fakeSink().sink,
      noCancel,
    );
    expect(registerStreamWithHitl).toHaveBeenCalledWith("stream-9");
    expect(unregisterStreamWithHitl).toHaveBeenCalledWith("stream-9");
  });

  test("aborts the stream signal when cancellation fires, then disposes the listener", async () => {
    let onCancel = (): void => undefined;
    const dispose = vi.fn();
    const cancel: CancellationLike = {
      isCancelled: false,
      onCancelled: (cb) => {
        onCancel = cb;
        return { dispose };
      },
    };
    let capturedSignal: AbortSignal | undefined;
    const client = fakeClient({
      askStream: (_i, opts) => {
        capturedSignal = opts?.signal;
        return streamOf([{ type: "done", reply: "", sessionId: "s" }]);
      },
    });
    await runParticipantTurn(req(), deps({ client: () => client }), fakeSink().sink, cancel);
    expect(capturedSignal).toBeInstanceOf(AbortSignal);
    onCancel();
    expect(capturedSignal?.aborted).toBe(true);
    // The turn already completed, so the listener must have been disposed.
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  test("an error event surfaces a message and logs it", async () => {
    const f = fakeSink();
    const log = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
    const client = fakeClient({ askStream: () => streamOf([{ type: "error", code: "E", message: "kaboom" }]) });
    await runParticipantTurn(req(), deps({ client: () => client, log }), f.sink, noCancel);
    expect(f.md.join(" ")).toContain("kaboom");
    expect(log.error).toHaveBeenCalled();
  });

  test("a stream that ends with no content shows the no-LLM notice", async () => {
    const f = fakeSink();
    const client = fakeClient({ askStream: () => streamOf([{ type: "done", reply: "", sessionId: "" }]) });
    await runParticipantTurn(req(), deps({ client: () => client }), f.sink, noCancel);
    expect(f.md.join(" ")).toMatch(/no answer|LLM provider|Gateway/i);
  });

  test("a thrown mid-stream error is surfaced, not swallowed", async () => {
    const f = fakeSink();
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
    const client = fakeClient({ askStream: () => throwing });
    await runParticipantTurn(req(), deps({ client: () => client }), f.sink, noCancel);
    expect(f.md.join(" ")).toContain("No LLM provider available");
  });

  test("empty prompt with no context nudges the user, no stream", async () => {
    const f = fakeSink();
    const askStream = vi.fn();
    await runParticipantTurn(req({ prompt: "   " }), deps({ client: () => fakeClient({ askStream }) }), f.sink, noCancel);
    expect(askStream).not.toHaveBeenCalled();
    expect(f.md.join(" ")).toMatch(/ask me|\/explain/i);
  });
});
