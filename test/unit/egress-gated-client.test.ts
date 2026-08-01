import { describe, expect, test } from "vitest";

import type { EgressGate, GateDecision } from "../../src/egress/gate.js";
import {
  EgressCancelled,
  gateAgentInvoke,
  gateAskStream,
  isEgressCancelled,
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
