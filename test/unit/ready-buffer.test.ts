import { describe, expect, test, vi } from "vitest";
import { createReadyBuffer } from "../../src/chat/ready-buffer.js";

describe("createReadyBuffer", () => {
  test("queues posts until the webview reports ready, then flushes them in order", async () => {
    const sent: unknown[] = [];
    const send = vi.fn(async (m: unknown) => {
      sent.push(m);
      return true;
    });
    const buf = createReadyBuffer(send);

    await buf.post({ type: "userMessage", text: "hi" });
    await buf.post({ type: "token", text: "a" });
    // Nothing delivered while the webview is still loading.
    expect(sent).toEqual([]);

    buf.observe({ type: "ready" });

    expect(sent).toEqual([
      { type: "userMessage", text: "hi" },
      { type: "token", text: "a" },
    ]);
  });

  test("posts after ready are sent straight through", async () => {
    const sent: unknown[] = [];
    const send = vi.fn(async (m: unknown) => {
      sent.push(m);
      return true;
    });
    const buf = createReadyBuffer(send);

    buf.observe({ type: "ready" });
    await buf.post({ type: "token", text: "b" });

    expect(sent).toEqual([{ type: "token", text: "b" }]);
  });

  test("non-ready incoming messages do not release the queue", async () => {
    const sent: unknown[] = [];
    const send = vi.fn(async (m: unknown) => {
      sent.push(m);
      return true;
    });
    const buf = createReadyBuffer(send);

    await buf.post({ type: "token", text: "c" });
    buf.observe({ type: "submitAsk", text: "not ready" });
    buf.observe(null);
    buf.observe({ nope: true });

    expect(sent).toEqual([]);
  });

  test("a second ready signal does not re-flush already-sent messages", async () => {
    const sent: unknown[] = [];
    const send = vi.fn(async (m: unknown) => {
      sent.push(m);
      return true;
    });
    const buf = createReadyBuffer(send);

    await buf.post({ type: "token", text: "d" });
    buf.observe({ type: "ready" });
    buf.observe({ type: "ready" });

    expect(sent).toEqual([{ type: "token", text: "d" }]);
  });
});
