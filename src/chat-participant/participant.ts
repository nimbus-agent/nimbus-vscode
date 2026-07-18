import type { AskStreamHandle, AskStreamOptions } from "@nimbus-dev/client";
import { errMsg } from "../logging.js";
import { redactPath } from "../quick-ask.js";
import { buildCitations } from "./citations.js";
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

  const prompt = buildParticipantPrompt(req);
  if (prompt.trim().length === 0) {
    sink.markdown("Ask me a question, or run `/explain`, `/fix`, or `/test` on a selection.");
    return {};
  }

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

  const opts: AskStreamOptions = {};
  if (req.priorSessionId !== undefined && req.priorSessionId.length > 0)
    opts.sessionId = req.priorSessionId;
  const agentName = deps.agent();
  if (agentName.length > 0) opts.agent = agentName;
  opts.signal = ac.signal;

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

  let sessionId: string | undefined;
  let sawContent = false;
  let sawToken = false;
  let registered = false;
  try {
    for await (const ev of handle) {
      if (ev.type !== "done") sawContent = true;
      if (!registered && handle.streamId.length > 0) {
        deps.registerStreamWithHitl(handle.streamId);
        registered = true;
      }
      if (ev.type === "token") {
        sawToken = true;
        sink.markdown(ev.text);
      } else if (ev.type === "subTaskProgress") {
        sink.progress(ev.status);
      } else if (ev.type === "hitlBatch") {
        // Consent is collected out-of-band by the shared HITL modal router (via
        // registerStreamWithHitl). Just tell the user what's happening.
        sink.progress("Waiting for your approval…");
      } else if (ev.type === "error") {
        sink.markdown(`Nimbus ran into a problem: ${ev.message}`);
        deps.log.error(`participant stream error: ${ev.code}: ${ev.message}`);
        break;
      } else if (ev.type === "done") {
        if (!sawToken && ev.reply.trim().length > 0) {
          sink.markdown(ev.reply);
          sawContent = true;
        }
        if (ev.sessionId.length > 0) sessionId = ev.sessionId;
        break;
      }
    }
    if (!sawContent && !ac.signal.aborted) sink.markdown(NO_LLM_NOTICE);
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
  return sessionId !== undefined ? { sessionId } : {};
}
