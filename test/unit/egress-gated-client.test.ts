import { describe, expect, test } from "vitest";

import type { EgressGate, GateDecision } from "../../src/egress/gate.js";
import {
  EgressCancelled,
  gateAgentInvoke,
  gateAskStream,
  gateRawBriefs,
  isEgressCancelled,
  type RawBriefClient,
} from "../../src/egress/gated-client.js";
import type { EgressMeta, EgressPayload } from "../../src/egress/preflight.js";

function fakeGate(decision: GateDecision): EgressGate & { recorded: EgressPayload[] } {
  const recorded: EgressPayload[] = [];
  const build = (kind: EgressPayload["kind"], prompt: string, meta: EgressMeta): EgressPayload => ({
    kind,
    prompt,
    roots: [],
    ...meta,
  });
  return {
    recorded,
    check: async (kind, prompt, meta) => {
      recorded.push(build(kind, prompt, meta));
      return decision;
    },
    record: (kind, prompt, meta) => {
      recorded.push(build(kind, prompt, meta));
    },
    lastPayload: () => recorded.at(-1),
  };
}

const META: EgressMeta = { action: "Review Changes", files: [], omissions: [] };

describe("gateAgentInvoke", () => {
  test("forwards input and options when the gate says send", async () => {
    const seen: unknown[] = [];
    const raw = async (input: string, opts: unknown) => {
      seen.push([input, opts]);
      return { reply: "ok" };
    };
    const invoke = gateAgentInvoke(raw, fakeGate("send"), "scm");
    expect(await invoke("diff", { stream: false, agent: "a" }, META)).toEqual({ reply: "ok" });
    expect(seen).toEqual([["diff", { stream: false, agent: "a" }]]);
  });

  test("never calls the raw client when the gate cancels", async () => {
    let called = false;
    const raw = async () => {
      called = true;
      return {};
    };
    const invoke = gateAgentInvoke(raw, fakeGate("cancel"), "scm");
    await expect(invoke("diff", { stream: false }, META)).rejects.toBeInstanceOf(EgressCancelled);
    expect(called).toBe(false);
  });

  test("its rejection is recognisable, so callers stay silent instead of erroring", async () => {
    const invoke = gateAgentInvoke(async () => ({}), fakeGate("cancel"), "quickAsk");
    try {
      await invoke("q", { stream: false }, META);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(isEgressCancelled(e)).toBe(true);
    }
  });

  test("isEgressCancelled rejects unrelated errors", () => {
    expect(isEgressCancelled(new Error("socket closed"))).toBe(false);
    expect(isEgressCancelled("nope")).toBe(false);
  });

  test("passes the fixed kind through, not one the call site chose", async () => {
    const gate = fakeGate("send");
    await gateAgentInvoke(async () => ({}), gate, "quickAsk")("q", { stream: false }, META);
    expect(gate.recorded[0]?.kind).toBe("quickAsk");
  });
});

// A progress notification reading "Nimbus: asking…" while the preview is still
// on screen says the send already happened. Nothing leaks — the gate is still
// the await — but the user is being told the opposite of the truth at the exact
// moment they are deciding. Ordering it here rather than at the call sites means
// no call site can get it wrong.
describe("gateAgentInvoke progress ordering", () => {
  const runner =
    (events: string[]) =>
    async <R>(title: string, body: () => Promise<R>) => {
      events.push(`progress:${title}`);
      return body();
    };

  test("does not start progress until the gate has cleared the send", async () => {
    const events: string[] = [];
    const gate = fakeGate("send");
    const wrapped: EgressGate = {
      ...gate,
      check: async (kind, prompt, meta) => {
        events.push("gate");
        return gate.check(kind, prompt, meta);
      },
    };
    const invoke = gateAgentInvoke(
      async () => {
        events.push("send");
        return {};
      },
      wrapped,
      "quickAsk",
      runner(events),
    );
    await invoke("q", { stream: false }, META, "Nimbus: asking…");
    expect(events).toEqual(["gate", "progress:Nimbus: asking…", "send"]);
  });

  test("shows no progress at all when the gate cancels", async () => {
    const events: string[] = [];
    const invoke = gateAgentInvoke(
      async () => {
        events.push("send");
        return {};
      },
      fakeGate("cancel"),
      "scm",
      runner(events),
    );
    await expect(
      invoke("diff", { stream: false }, META, "Nimbus: reviewing changes…"),
    ).rejects.toBeInstanceOf(EgressCancelled);
    expect(events).toEqual([]);
  });

  test("sends without progress when the call site asks for none", async () => {
    const events: string[] = [];
    const invoke = gateAgentInvoke(
      async () => {
        events.push("send");
        return { reply: "ok" };
      },
      fakeGate("send"),
      "lmTool",
      runner(events),
    );
    expect(await invoke("q", { stream: false }, META)).toEqual({ reply: "ok" });
    expect(events).toEqual(["send"]);
  });
});

describe("gateAskStream", () => {
  test("records and returns the handle synchronously", () => {
    const handle = { streamId: "s1" };
    const gate = fakeGate("send");
    const askStream = gateAskStream(() => handle, gate, "ask", "Ask");
    // Not awaited: askStream's contract is a synchronous return.
    expect(askStream("hello", { sessionId: "x" })).toBe(handle);
    expect(gate.recorded[0]?.kind).toBe("ask");
    expect(gate.recorded[0]?.prompt).toBe("hello");
  });

  test("forwards the options object untouched", () => {
    const seen: unknown[] = [];
    const opts = { sessionId: "x" };
    const askStream = gateAskStream(
      (input: string, o?: unknown) => {
        seen.push([input, o]);
        return {};
      },
      fakeGate("send"),
      "participant",
      "Chat",
    );
    askStream("hi", opts);
    expect(seen).toEqual([["hi", opts]]);
  });
});

describe("gateRawBriefs", () => {
  const base = { agentVersion: 1 as const, generatedAt: 0, latencyMs: 1, gaps: [] };

  function fakeClient(calls: unknown[]) {
    return {
      agentsWhy: async (p: unknown) => {
        calls.push(["why", p]);
        return {
          ...base,
          kind: "why",
          query: { ref: "a", line: null },
          subject: null,
          findings: [],
        };
      },
      agentsGhost: async (p: unknown) => {
        calls.push(["ghost", p]);
        return { ...base, kind: "ghost", query: { file: "a" }, startEntityId: null, findings: [] };
      },
      agentsConflicts: async (p: unknown) => {
        calls.push(["conflicts", p]);
        return {
          ...base,
          kind: "conflict",
          query: { file: "a" },
          startEntityId: null,
          collisions: [],
        };
      },
      agentsHuddle: async (p: unknown) => {
        calls.push(["huddle", p]);
        return { ...base, kind: "huddle", query: { sinceMs: 1 }, contributions: [] };
      },
    } as unknown as RawBriefClient;
  }

  test("sends the params as the verbatim prompt, pretty-printed, under the brief kind", async () => {
    const gate = fakeGate("send");
    const briefs = gateRawBriefs(fakeClient([]), gate);
    await briefs.why({ ref: "src/a.ts", line: 42 }, META, "…");
    expect(gate.recorded[0]?.kind).toBe("brief");
    expect(gate.recorded[0]?.prompt).toBe('{\n  "ref": "src/a.ts",\n  "line": 42\n}');
  });

  test("throws EgressCancelled and never calls the client when the gate cancels", async () => {
    const calls: unknown[] = [];
    const briefs = gateRawBriefs(fakeClient(calls), fakeGate("cancel"));
    await expect(briefs.ghost({ file: "src/a.ts" }, META, "…")).rejects.toBeInstanceOf(
      EgressCancelled,
    );
    expect(calls).toEqual([]);
  });

  test("forwards each brief to its own client method", async () => {
    const calls: unknown[] = [];
    const briefs = gateRawBriefs(fakeClient(calls), fakeGate("send"));
    await briefs.conflicts({ file: "src/a.ts" }, META, "…");
    await briefs.huddle({}, META, "…");
    expect(calls).toEqual([
      ["conflicts", { file: "src/a.ts" }],
      ["huddle", {}],
    ]);
  });

  test("shows progress only after the gate clears", async () => {
    const order: string[] = [];
    const gate = fakeGate("send");
    const wrapped: EgressGate = {
      ...gate,
      check: async (kind, prompt, meta) => {
        order.push("gate");
        return gate.check(kind, prompt, meta);
      },
    };
    const briefs = gateRawBriefs(fakeClient([]), wrapped, async (_t, body) => {
      order.push("progress");
      return body();
    });
    await briefs.huddle({}, META, "…");
    expect(order).toEqual(["gate", "progress"]);
  });
});
