import { describe, expect, test, vi } from "vitest";

import type { Attachment } from "../../src/chat/attachments.js";
import { createChatController } from "../../src/chat/chat-controller.js";
import type { ExtensionToWebview } from "../../src/chat/chat-protocol.js";

function harness(files: Record<string, string> = {}) {
  const posted: ExtensionToWebview[] = [];
  const order: string[] = [];
  // AskStreamHandle is `AsyncIterable<StreamEvent> & { streamId, cancel() }` —
  // NOT an object with an `events` property. `test/unit/chat-controller.test.ts`
  // already builds this shape in its `pendingStream` helper; read that first and
  // mirror it rather than inventing a second fake.
  const handle = {
    streamId: "s1",
    cancel: vi.fn(async () => {}),
    [Symbol.asyncIterator](): AsyncIterator<never> {
      return {
        async next(): Promise<IteratorResult<never>> {
          return { value: undefined as never, done: true };
        },
      };
    },
  };
  const client = {
    askStream: vi.fn((_input: string) => {
      order.push("askStream");
      return handle as never;
    }),
    cancelStream: vi.fn(async () => ({ ok: true })),
    getSessionTranscript: vi.fn(async () => ({ sessionId: "s", turns: [], hasMore: false })),
  };
  const ctl = createChatController({
    client: client as never,
    panel: {
      postMessage: async (m: ExtensionToWebview) => {
        posted.push(m);
        // Tag "attachments" posts with their provisional/resolved state so an
        // ordering assertion can target the RESOLVED post specifically rather
        // than any post of that type — see the ordering test below.
        order.push(
          m.type === "attachments"
            ? `attachments:${m.provisional ? "provisional" : "resolved"}`
            : m.type,
        );
      },
    } as never,
    sessionStore: { get: () => undefined, set: () => {}, clear: () => {} } as never,
    registerStreamWithHitl: () => {},
    unregisterStreamWithHitl: () => {},
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never,
    readFile: (p: string) => files[p],
  });
  return { ctl, client, posted, order };
}

const file = (path: string): Attachment => ({ kind: "file", path });

describe("attachment state", () => {
  test("attaching posts provisional chips", async () => {
    const h = harness({ "a.ts": "x\n" });
    h.ctl.attach(file("a.ts"));
    const msg = h.posted.find((m) => m.type === "attachments");
    expect(msg).toBeDefined();
    if (msg?.type !== "attachments") throw new Error("expected attachments");
    expect(msg.provisional).toBe(true);
    expect(msg.chips[0]?.label).toBe("a.ts");
  });

  test("detaching removes it", async () => {
    const h = harness({ "a.ts": "x\n" });
    h.ctl.attach(file("a.ts"));
    const id = h.posted.flatMap((m) => (m.type === "attachments" ? m.chips : []))[0]?.id;
    if (id === undefined) throw new Error("no chip id");
    h.ctl.detach(id);
    expect(h.ctl.attachments()).toHaveLength(0);
  });

  test("attachments survive a turn, because the follow-up needs them", async () => {
    const h = harness({ "a.ts": "x\n" });
    h.ctl.attach(file("a.ts"));
    await h.ctl.start("first question");
    expect(h.ctl.attachments()).toHaveLength(1);
  });

  test("a new conversation clears them", async () => {
    const h = harness({ "a.ts": "x\n" });
    h.ctl.attach(file("a.ts"));
    await h.ctl.newConversation();
    expect(h.ctl.attachments()).toHaveLength(0);
  });
});

describe("sending", () => {
  test("the RESOLVED manifest is posted BEFORE askStream is called", async () => {
    const h = harness({ "a.ts": "x\n" });
    h.ctl.attach(file("a.ts"));
    h.order.length = 0; // ignore the attach-time post
    await h.ctl.start("why is this here?");
    // Track the resolved post specifically: several `attachments` messages are
    // sent, and "some attachments message preceded askStream" would pass even
    // if the resolved one came after. The composer being the pre-flight preview
    // is the whole argument for not prompting, so this ordering IS the feature.
    const resolvedAt = h.posted.findIndex(
      (m) => m.type === "attachments" && m.provisional === false,
    );
    expect(resolvedAt).toBeGreaterThanOrEqual(0);
    const askAt = h.order.indexOf("askStream");
    const postsBeforeAsk = h.order
      .slice(0, askAt)
      .filter((t) => t.startsWith("attachments:")).length;
    expect(askAt).toBeGreaterThanOrEqual(0);
    // The resolved post is among those that happened before the request left.
    expect(postsBeforeAsk).toBeGreaterThanOrEqual(1);
    expect(
      h.posted.slice(0, postsBeforeAsk).some((m) => m.type === "attachments" && !m.provisional),
    ).toBe(true);
    // The direct assertion: the RESOLVED post's tagged slot in `order` precedes
    // askStream's. `postsBeforeAsk` above counts by type only and is used as an
    // index into the heterogeneous `posted` array — the attach-time post (never
    // reset there) happens to make the offsets cancel out, so that assertion
    // alone would pass even if turnAttachments were posted before the resolved
    // post, or if the resolved post came after. This one cannot.
    const resolvedOrderAt = h.order.indexOf("attachments:resolved");
    expect(resolvedOrderAt).toBeGreaterThanOrEqual(0);
    expect(resolvedOrderAt).toBeLessThan(h.order.indexOf("askStream"));
  });

  test("the composer returns to provisional after the send, so the next turn is not overstated", async () => {
    const h = harness({ "a.ts": "x\n" });
    h.ctl.attach(file("a.ts"));
    await h.ctl.start("q");
    const last = [...h.posted].reverse().find((m) => m.type === "attachments");
    if (last?.type !== "attachments") throw new Error("expected attachments");
    expect(last.provisional).toBe(true);
  });

  test("the prompt carries the block and the question, question last", async () => {
    const h = harness({ "a.ts": "export const a = 1;\n" });
    h.ctl.attach(file("a.ts"));
    await h.ctl.start("why is this here?");
    const sent = h.client.askStream.mock.calls[0]?.[0] as string;
    expect(sent).toContain("export const a = 1;");
    expect(sent.indexOf("export const a = 1;")).toBeLessThan(sent.indexOf("why is this here?"));
  });

  test("a turn with no attachments sends exactly the typed text, as today", async () => {
    const h = harness();
    await h.ctl.start("plain question");
    expect(h.client.askStream.mock.calls[0]?.[0]).toBe("plain question");
  });

  test("the sent turn gets its own permanent manifest", async () => {
    const h = harness({ "a.ts": "x\n" });
    h.ctl.attach(file("a.ts"));
    await h.ctl.start("q");
    expect(h.posted.some((m) => m.type === "turnAttachments")).toBe(true);
  });

  test("an all-refused set still sends the question", async () => {
    const h = harness();
    h.ctl.attach(file(".env"));
    await h.ctl.start("q");
    expect(h.client.askStream.mock.calls[0]?.[0]).toBe("q");
  });
});
