import type { EgressGate } from "./gate.js";
import type { EgressKind, EgressMeta } from "./preflight.js";

// THE CHOKE POINT.
//
// This is the only module in src/ permitted to call `.agentInvoke(` or
// `.askStream(` on a Nimbus client; test/unit/egress-choke-point.test.ts
// enforces that. Everything else receives a wrapper from here, with its
// EgressKind fixed at wiring time.

// Thrown instead of returned because the SCM helper already treats an
// `undefined` reply as "the agent returned no reply" — a cancelled send would
// otherwise show the wrong message. A distinguishable error keeps every call
// site's signature unchanged.
export class EgressCancelled extends Error {
  constructor() {
    super("Nimbus: send cancelled at the pre-flight preview.");
    this.name = "EgressCancelled";
  }
}

export function isEgressCancelled(e: unknown): boolean {
  return e instanceof EgressCancelled;
}

export type GatedAgentInvoke<R> = (
  input: string,
  opts: { stream: boolean; agent?: string },
  meta: EgressMeta,
) => Promise<R>;

// The required third argument is the type-level half of the guardrail: the raw
// NimbusClient no longer satisfies ScmClientLike or LmToolsClientLike
// structurally, so the ungated client cannot be wired in by accident.
export function gateAgentInvoke<R>(
  raw: (input: string, opts: { stream: boolean; agent?: string }) => Promise<R>,
  gate: EgressGate,
  kind: EgressKind,
): GatedAgentInvoke<R> {
  return async (input, opts, meta) => {
    if ((await gate.check(kind, input, meta)) === "cancel") throw new EgressCancelled();
    return raw(input, opts);
  };
}

// askStream returns its handle synchronously, so this records rather than
// awaits. That is sound because the two askStream surfaces are pass-through by
// design: the text is what the user just typed.
export function gateAskStream<H, O>(
  raw: (input: string, opts?: O) => H,
  gate: EgressGate,
  kind: EgressKind,
  action: string,
): (input: string, opts?: O) => H {
  return (input, opts) => {
    gate.record(kind, input, { action, files: [], omissions: [] });
    return raw(input, opts);
  };
}
