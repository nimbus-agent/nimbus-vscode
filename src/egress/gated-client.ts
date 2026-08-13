import type {
  CatchupBrief,
  CatchupParams,
  ConflictBrief,
  ConflictsParams,
  ExpertBrief,
  ExpertParams,
  GhostBrief,
  GhostParams,
  HuddleBrief,
  HuddleParams,
  ImpactBrief,
  ImpactParams,
  JanitorBrief,
  JanitorParams,
  PreflightBrief,
  PreflightParams,
  WhyBrief,
  WhyParams,
} from "@nimbus-dev/client";

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

// ---------------------------------------------------------------------------
// Briefs.
//
// The `agents*` family is agent-bound too: the Gateway composes a `brief`
// string from a model. The params are structured rather than assembled prose,
// but a `file`/`ref` is exactly what the leak-check scans for, so these route
// through the same seam and the same gate.
//
// Keeping the agents* call shapes in THIS file is what lets
// egress-choke-point.test.ts allowlist consumers that only ever hold the
// injected GatedBriefs seam.

export interface RawBriefClient {
  agentsWhy(p: WhyParams, o?: { timeoutMs?: number }): Promise<WhyBrief>;
  agentsGhost(p: GhostParams, o?: { timeoutMs?: number }): Promise<GhostBrief>;
  agentsConflicts(p: ConflictsParams, o?: { timeoutMs?: number }): Promise<ConflictBrief>;
  agentsHuddle(p?: HuddleParams, o?: { timeoutMs?: number }): Promise<HuddleBrief>;
  agentsJanitor(p: JanitorParams, o?: { timeoutMs?: number }): Promise<JanitorBrief>;
  agentsPreflight(p: PreflightParams, o?: { timeoutMs?: number }): Promise<PreflightBrief>;
}

/** A brief call that has already passed the gate. Throws EgressCancelled if not. */
export type GatedBrief<P, B> = (p: P, meta: EgressMeta, progressTitle: string) => Promise<B>;

export interface GatedBriefs {
  why: GatedBrief<WhyParams, WhyBrief>;
  ghost: GatedBrief<GhostParams, GhostBrief>;
  conflicts: GatedBrief<ConflictsParams, ConflictBrief>;
  huddle: GatedBrief<HuddleParams, HuddleBrief>;
  janitor: GatedBrief<JanitorParams, JanitorBrief>;
  preflight: GatedBrief<PreflightParams, PreflightBrief>;
}

export function gateRawBriefs(
  client: RawBriefClient,
  gate: EgressGate,
  withProgress: ProgressRunner = (_title, body) => body(),
): GatedBriefs {
  // The seam stringifies, so no call site can send a shape the manifest did not
  // show. Pretty-printed because the modal's "Show full text" renders it raw.
  const run = async <P, B>(
    call: (p: P) => Promise<B>,
    p: P,
    meta: EgressMeta,
    progressTitle: string,
  ): Promise<B> => {
    if ((await gate.check("brief", JSON.stringify(p, null, 2), meta)) === "cancel") {
      throw new EgressCancelled();
    }
    return withProgress(progressTitle, () => call(p));
  };

  return {
    why: (p, meta, title) => run((q: WhyParams) => client.agentsWhy(q), p, meta, title),
    ghost: (p, meta, title) => run((q: GhostParams) => client.agentsGhost(q), p, meta, title),
    conflicts: (p, meta, title) =>
      run((q: ConflictsParams) => client.agentsConflicts(q), p, meta, title),
    huddle: (p, meta, title) => run((q: HuddleParams) => client.agentsHuddle(q), p, meta, title),
    janitor: (p, meta, title) => run((q: JanitorParams) => client.agentsJanitor(q), p, meta, title),
    preflight: (p, meta, title) =>
      run((q: PreflightParams) => client.agentsPreflight(q), p, meta, title),
  };
}

// ---------------------------------------------------------------------------
// Workflow runs.
//
// Agent-bound, and the heaviest of the lot: one click can send MANY model
// prompts, expanded Gateway-side from steps saved long before. The extension
// sends only a workflow name, so unlike every other surface here the previewed
// text is a manifest rather than the literal bytes — buildRunManifest says so
// in its omissions instead of implying byte-exactness.
//
// The gate is awaited BEFORE the stream starts. That ordering is the point: a
// run started and then cancelled has already reached the model, and (because
// cancellation lands at the next step boundary) cannot be stopped mid-step.

export interface RawWorkflowRunner<P, H> {
  workflowRunStream(params: P): H;
}

/** A workflow run that has passed the gate. Throws EgressCancelled if not. */
export type GatedWorkflowRun<P, H> = (
  params: P,
  /** The rendered manifest — what the pre-flight modal shows. */
  manifest: string,
  meta: EgressMeta,
) => Promise<H>;

export function gateRawWorkflowRun<P, H>(
  client: RawWorkflowRunner<P, H>,
  gate: EgressGate,
): GatedWorkflowRun<P, H> {
  return async (params, manifest, meta) => {
    if ((await gate.check("workflow", manifest, meta)) === "cancel") throw new EgressCancelled();
    return client.workflowRunStream(params);
  };
}

// ---------------------------------------------------------------------------
// Participant briefs.
//
// The chat participant's three ops briefs take an argument the user typed after
// a slash command, so they follow the same rule as askStream: record, do not
// prompt. gate.ts splits kinds on exactly this principle — only the surfaces
// where the EXTENSION decides what is sent prompt.
//
// A separate constructor rather than a flag on gateRawBriefs: one function per
// gate behaviour, each named for what it does, and neither reachable by passing
// the wrong argument to the other.

export interface RawParticipantBriefClient {
  agentsCatchup(p?: CatchupParams, o?: { timeoutMs?: number }): Promise<CatchupBrief>;
  agentsExpert(p: ExpertParams, o?: { timeoutMs?: number }): Promise<ExpertBrief>;
  agentsImpact(p: ImpactParams, o?: { timeoutMs?: number }): Promise<ImpactBrief>;
}

/** No progressTitle: the chat turn already renders its own progress. */
export type ParticipantBrief<P, B> = (p: P, meta: EgressMeta) => Promise<B>;

export interface ParticipantBriefs {
  catchup: ParticipantBrief<CatchupParams, CatchupBrief>;
  expert: ParticipantBrief<ExpertParams, ExpertBrief>;
  impact: ParticipantBrief<ImpactParams, ImpactBrief>;
}

export function gateRawParticipantBriefs(
  client: RawParticipantBriefClient,
  gate: EgressGate,
): ParticipantBriefs {
  // Stringified by the seam, so no call site can send a shape the ledger did
  // not record. Pretty-printed to match gateRawBriefs.
  const run = async <P, B>(call: (p: P) => Promise<B>, p: P, meta: EgressMeta): Promise<B> => {
    gate.record("participant", JSON.stringify(p, null, 2), meta);
    return call(p);
  };

  return {
    catchup: (p, meta) => run((q: CatchupParams) => client.agentsCatchup(q), p, meta),
    expert: (p, meta) => run((q: ExpertParams) => client.agentsExpert(q), p, meta),
    impact: (p, meta) => run((q: ImpactParams) => client.agentsImpact(q), p, meta),
  };
}
