import type {
  AskStreamHandle,
  AskStreamOptions,
  CatchupBrief,
  CatchupParams,
  DoraMetricsResult,
  ExpertBrief,
  ExpertParams,
  ImpactBrief,
  ImpactParams,
  MetricsDoraParams,
  RankedSearchItem,
  RankedSearchParams,
} from "@nimbus-dev/client";
import type { Logger } from "../logging.js";

// A code file attached to a turn — an explicit #file reference (free-form) or the
// active editor's selection/whole file (slash commands). The adapter resolves
// these (fs / vscode) so the pure handler stays vscode-free. `path` is the REAL
// local path: redacted before it is sent to the Gateway, and used to self-exclude
// the active file from citations.
export interface AttachedFile {
  path: string;
  languageId: string;
  code: string;
}

// Stage 2b: the ops vocabulary. The Copilot three (explain/fix/test) were
// retired to quick-ask presets — a local-first client does not compete on
// model quality; it competes on private cross-service context.
export type ParticipantCommand = "incident" | "deploys" | "owns" | "blast";

export interface ParticipantRequest {
  prompt: string; // user free text (may be empty for a bare slash command)
  command?: ParticipantCommand;
  attachments: AttachedFile[]; // resolved #file refs (free-form turns)
  selection?: AttachedFile; // active selection / whole file (slash-command turns)
  priorSessionId?: string; // from the prior turn's ChatResult.metadata
}

// A citation carries the REAL local target (opened on click) plus a display
// label. redactPath governs only Gateway-bound prompt context; a citation target
// is a local file the user already has and is never sent anywhere.
export interface CitationRef {
  label: string;
  target: string;
}

export interface ChatResponseSink {
  markdown(text: string): void;
  progress(text: string): void;
  citation(ref: CitationRef): void; // adapter -> response.anchor(uri, label)
  button(title: string, command: string, args?: unknown[]): void; // adapter -> response.button(Command)
}

export interface CancellationLike {
  readonly isCancelled: boolean;
  // Returns a disposable so the handler can unsubscribe in its finally block —
  // a turn that completes without cancelling must not leak the listener.
  onCancelled(cb: () => void): { dispose(): void };
}

export interface ParticipantClientLike {
  askStream(input: string, opts?: AskStreamOptions): AskStreamHandle;
  searchRanked(params?: RankedSearchParams): Promise<RankedSearchItem[]>;
  agentsExpert(p: ExpertParams, o?: { timeoutMs?: number }): Promise<ExpertBrief>;
  agentsImpact(p: ImpactParams, o?: { timeoutMs?: number }): Promise<ImpactBrief>;
  agentsCatchup(p?: CatchupParams, o?: { timeoutMs?: number }): Promise<CatchupBrief>;
  metricsDora(params: MetricsDoraParams): Promise<DoraMetricsResult>;
}

export interface ParticipantDeps {
  client(): ParticipantClientLike | undefined; // undefined = disconnected
  registerStreamWithHitl(streamId: string): void;
  unregisterStreamWithHitl(streamId: string): void;
  agent(): string; // askAgent() setting; "" = omit
  citationLimit: number;
  reconnectCommand: string; // e.g. "nimbus.troubleshootConnection"
  log: Logger;
}

// The pure handler returns the resolved session id; the adapter maps it onto
// ChatResult.metadata so the next turn in this conversation can thread it.
export interface ParticipantResult {
  sessionId?: string;
}
