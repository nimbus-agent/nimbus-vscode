import type { AskStreamHandle, AskStreamOptions, StreamEvent } from "@nimbus-dev/client";
import { errMsg } from "../logging.js";
import { redactPath } from "../quick-ask.js";
import { buildCitations } from "./citations.js";
import { runOpsCommand } from "./ops-commands.js";
import type {
  CancellationLike,
  ChatResponseSink,
  ParticipantClientLike,
  ParticipantDeps,
  ParticipantRequest,
  ParticipantResult,
} from "./participant-types.js";
import { buildParticipantPrompt } from "./prompt.js";

const NO_LLM_NOTICE =
  "Nimbus reached the Gateway, but no answer came back — this usually means no language model is set up yet. Add an LLM provider (or API key) in your Gateway configuration, then try again.";

// Fetch citations for the query and emit them; best-effort, never throws. Kept
// separate so the caller can start it WITHOUT awaiting, letting the answer stream
// while the search resolves in parallel.
async function emitCitations(
  client: ParticipantClientLike,
  deps: ParticipantDeps,
  sink: ChatResponseSink,
  query: string,
  excludeBasename: string | undefined,
  signal: AbortSignal,
): Promise<void> {
  const q = query.trim();
  if (q.length === 0) return;
  try {
    const rows = await client.searchRanked({ name: q, limit: deps.citationLimit });
    if (signal.aborted) return;
    const citationOpts =
      excludeBasename !== undefined
        ? { excludeBasename, limit: deps.citationLimit }
        : { limit: deps.citationLimit };
    for (const c of buildCitations(rows as unknown[], citationOpts)) {
      sink.citation(c);
    }
  } catch (e) {
    deps.log.warn(`participant: searchRanked failed: ${errMsg(e)}`);
  }
}

// Assemble the askStream options: the cancellation signal, plus the threaded
// session id and agent override when present.
function buildStreamOptions(
  req: ParticipantRequest,
  deps: ParticipantDeps,
  signal: AbortSignal,
): AskStreamOptions {
  const opts: AskStreamOptions = { signal };
  if (req.priorSessionId !== undefined && req.priorSessionId.length > 0) {
    opts.sessionId = req.priorSessionId;
  }
  const agentName = deps.agent();
  if (agentName.length > 0) opts.agent = agentName;
  return opts;
}

// Running state threaded through the stream loop: whether any answer content and
// any token arrived, and the session id captured from the `done` event.
interface StreamState {
  sessionId?: string;
  sawContent: boolean;
  sawToken: boolean;
}

// Apply one stream event to the sink, updating `state`. Returns true to stop
// consuming (a `done` or `error` event). Mirrors chat-controller.ts's taxonomy.
function handleStreamEvent(
  ev: StreamEvent,
  sink: ChatResponseSink,
  deps: ParticipantDeps,
  state: StreamState,
): boolean {
  if (ev.type !== "done") state.sawContent = true;
  if (ev.type === "token") {
    state.sawToken = true;
    sink.markdown(ev.text);
    return false;
  }
  if (ev.type === "subTaskProgress") {
    sink.progress(ev.status);
    return false;
  }
  if (ev.type === "hitlBatch") {
    // Consent is collected out-of-band by the shared HITL modal router (via
    // registerStreamWithHitl). Just tell the user what's happening.
    sink.progress("Waiting for your approval…");
    return false;
  }
  if (ev.type === "error") {
    sink.markdown(`Nimbus ran into a problem: ${ev.message}`);
    deps.log.error(`participant stream error: ${ev.code}: ${ev.message}`);
    return true;
  }
  // done: render the reply if it wasn't streamed as tokens, and capture the id.
  if (!state.sawToken && ev.reply.trim().length > 0) {
    sink.markdown(ev.reply);
    state.sawContent = true;
  }
  if (ev.sessionId.length > 0) state.sessionId = ev.sessionId;
  return true;
}

// Consume the stream: register it for HITL on the first event, dispatch each
// event via handleStreamEvent, and return the accumulated state. Extracted from
// runParticipantTurn to keep that function's cognitive complexity in bounds.
async function consumeStream(
  handle: AskStreamHandle,
  sink: ChatResponseSink,
  deps: ParticipantDeps,
): Promise<StreamState> {
  const state: StreamState = { sawContent: false, sawToken: false };
  let registered = false;
  for await (const ev of handle) {
    if (!registered && handle.streamId.length > 0) {
      deps.registerStreamWithHitl(handle.streamId);
      registered = true;
    }
    if (handleStreamEvent(ev, sink, deps, state)) break;
  }
  return state;
}

// Best-effort read of the egress-ledger row count; undefined (never a throw)
// when the ledger is unreadable — the footer is an affordance, not a gate.
async function readHeadCount(
  client: ParticipantClientLike,
  log: ParticipantDeps["log"],
): Promise<number | undefined> {
  try {
    return (await client.egressHead()).count;
  } catch (e) {
    log.warn(`participant: egressHead (before) failed: ${errMsg(e)}`);
    return undefined;
  }
}

// The per-answer receipt: how many ledger rows this turn appended. Zero is the
// headline claim — "nothing left this machine" — so it renders too. A negative
// delta (a prune ran mid-turn) is treated as zero.
async function emitEgressDelta(
  client: ParticipantClientLike,
  sink: ChatResponseSink,
  log: ParticipantDeps["log"],
  before: number | undefined,
): Promise<void> {
  if (before === undefined) return;
  let after: number;
  try {
    after = (await client.egressHead()).count;
  } catch (e) {
    log.warn(`participant: egressHead (after) failed: ${errMsg(e)}`);
    return;
  }
  const delta = Math.max(0, after - before);
  const plural = delta === 1 ? "" : "s";
  const text =
    delta === 0
      ? "\n\n---\n_Egress: no rows appended — nothing left this machine during this answer._"
      : `\n\n---\n_Egress: ${delta} row${plural} appended to the local ledger during this answer._`;
  sink.markdown(text);
}

export async function runParticipantTurn(
  req: ParticipantRequest,
  deps: ParticipantDeps,
  sink: ChatResponseSink,
  cancel: CancellationLike,
): Promise<ParticipantResult> {
  const client = deps.client();
  if (client === undefined) {
    sink.markdown(
      "Nimbus isn't connected to the Gateway right now, so I can't answer. Start or reconnect the Gateway, then try again.",
    );
    sink.button("Troubleshoot connection", deps.reconnectCommand);
    return {};
  }

  // Ops commands are structured brief/metric calls, not prompt rewrites — they
  // route before the empty-prompt guard because a bare `/incident` is valid.
  if (req.command !== undefined) {
    const headBefore = await readHeadCount(client, deps.log);
    await runOpsCommand(client, req, sink, deps.log);
    await emitEgressDelta(client, sink, deps.log, headBefore);
    return {};
  }

  const prompt = buildParticipantPrompt(req);
  if (prompt.trim().length === 0) {
    sink.markdown(
      "Ask me a question, or try `/incident`, `/deploys <service>`, `/owns`, or `/blast`.",
    );
    return {};
  }

  const headBefore = await readHeadCount(client, deps.log);

  const ac = new AbortController();
  // Track the cancellation subscription so it is disposed on every exit path — a
  // turn that finishes without being cancelled must not leak the listener.
  let cancelSub: { dispose(): void } | undefined;
  if (cancel.isCancelled) ac.abort();
  else cancelSub = cancel.onCancelled(() => ac.abort());

  // Start citations WITHOUT awaiting — they resolve in parallel with the stream
  // so the first token is never delayed. Await it at the end so late references
  // still land before the turn completes. Guarded by `ac.signal` so a cancelled
  // turn never emits a late citation chip.
  const excludeBasename = req.selection !== undefined ? redactPath(req.selection.path) : undefined;
  const citations = emitCitations(client, deps, sink, req.prompt, excludeBasename, ac.signal);

  const opts = buildStreamOptions(req, deps, ac.signal);

  let handle: AskStreamHandle;
  try {
    handle = client.askStream(prompt, opts);
  } catch (e) {
    cancelSub?.dispose();
    deps.log.error(`participant: askStream failed to start: ${errMsg(e)}`);
    sink.markdown(`Nimbus couldn't start the request: ${errMsg(e)}`);
    await citations;
    return {};
  }

  let state: StreamState = { sawContent: false, sawToken: false };
  try {
    state = await consumeStream(handle, sink, deps);
    if (!state.sawContent && !ac.signal.aborted) sink.markdown(NO_LLM_NOTICE);
  } catch (e) {
    if (!ac.signal.aborted) {
      deps.log.error(`participant: stream failed: ${errMsg(e)}`);
      sink.markdown(
        `Nimbus ran into a problem answering: ${errMsg(e)}. If that mentions a missing model or invalid API key, set up an LLM provider in your Gateway and try again.`,
      );
    }
  } finally {
    if (handle.streamId.length > 0) deps.unregisterStreamWithHitl(handle.streamId);
    cancelSub?.dispose();
  }

  await citations;
  if (!ac.signal.aborted) await emitEgressDelta(client, sink, deps.log, headBefore);
  return state.sessionId !== undefined ? { sessionId: state.sessionId } : {};
}
