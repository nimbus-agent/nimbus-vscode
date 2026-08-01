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
  /**
   * Progress title for the send itself. Shown only after the gate clears, so a
   * "sending…" notification never appears over the preview that is still asking
   * whether to send. Omit for a silent send.
   */
  progressTitle?: string,
) => Promise<R>;

/**
 * Runs `body` under a progress indicator. Injected rather than imported so this
 * module stays free of `vscode` and the ordering below stays unit-testable.
 */
export type ProgressRunner = <R>(title: string, body: () => Promise<R>) => Promise<R>;

// The required third argument is the type-level half of the guardrail: the raw
// NimbusClient no longer satisfies ScmClientLike or LmToolsClientLike
// structurally, so the ungated client cannot be wired in by accident.
export function gateAgentInvoke<R>(
  raw: (input: string, opts: { stream: boolean; agent?: string }) => Promise<R>,
  gate: EgressGate,
  kind: EgressKind,
  // Defaults to running the body bare, so a caller with no progress surface —
  // and every existing test — needs no runner.
  withProgress: ProgressRunner = (_title, body) => body(),
): GatedAgentInvoke<R> {
  return async (input, opts, meta, progressTitle) => {
    if ((await gate.check(kind, input, meta)) === "cancel") throw new EgressCancelled();
    if (progressTitle === undefined) return raw(input, opts);
    return withProgress(progressTitle, () => raw(input, opts));
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

// ---------------------------------------------------------------------------
// Raw-client entry points.
//
// These exist so the wiring in extension.ts — the ONE place holding a real
// NimbusClient — never has to write `.agentInvoke(` or `.askStream(` itself.
// Keeping those call shapes inside this file is what lets
// egress-choke-point.test.ts allowlist consumer modules (which only ever hold
// an injected seam) while still catching any new code that reaches for a raw
// client.

export interface RawAgentInvoker<R> {
  agentInvoke(input: string, opts: { stream: boolean; agent?: string }): Promise<R>;
}

export interface RawAskStreamer<H, O> {
  askStream(input: string, opts?: O): H;
}

export function gateRawAgentInvoke<R>(
  client: RawAgentInvoker<R>,
  gate: EgressGate,
  kind: EgressKind,
  withProgress?: ProgressRunner,
): GatedAgentInvoke<R> {
  return gateAgentInvoke((i, o) => client.agentInvoke(i, o), gate, kind, withProgress);
}

export function gateRawAskStream<H, O>(
  client: RawAskStreamer<H, O>,
  gate: EgressGate,
  kind: EgressKind,
  action: string,
): (input: string, opts?: O) => H {
  return gateAskStream((i, o) => client.askStream(i, o), gate, kind, action);
}
