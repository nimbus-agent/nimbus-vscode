import type { AskStreamHandle, AskStreamOptions, StreamEvent } from "@nimbus-dev/client";

import { errMsg, type Logger } from "../logging.js";
import {
  type AttachedContext,
  type Attachment,
  buildAttachedContext,
  type ResolvedAttachment,
} from "./attachments.js";
import type { ChatPanel } from "./chat-panel.js";
import type { ExtensionToWebview } from "./chat-protocol.js";
import type { SessionStore } from "./session-store.js";

export interface ChatClientLike {
  askStream(input: string, opts?: AskStreamOptions): AskStreamHandle;
  cancelStream(streamId: string): Promise<{ ok: boolean }>;
  getSessionTranscript(params: { sessionId: string; limit?: number }): Promise<{
    sessionId: string;
    turns: Array<{ role: "user" | "assistant"; text: string; timestamp: number }>;
    hasMore: boolean;
  }>;
}

export interface ChatControllerDeps {
  client: ChatClientLike;
  panel: ChatPanel;
  sessionStore: SessionStore;
  registerStreamWithHitl(streamId: string): void;
  unregisterStreamWithHitl(streamId: string): void;
  log: Logger;
  agent?: () => string;
  /** Reads a repo-relative path, or undefined when it cannot be read. */
  readFile(path: string): string | undefined;
}

export interface ChatController {
  start(input: string): Promise<void>;
  stop(): Promise<void>;
  newConversation(): Promise<void>;
  rehydrateIfNeeded(limit: number): Promise<void>;
  resume(sessionId: string, limit: number): Promise<void>;
  isStreaming(): boolean;
  attach(attachment: Attachment): void;
  detach(id: string): void;
  attachments(): readonly Attachment[];
}

function buildAskStreamOptions(
  sessionStore: SessionStore,
  agent: (() => string) | undefined,
): AskStreamOptions {
  const opts: AskStreamOptions = {};
  const sid = sessionStore.get();
  if (sid !== undefined) opts.sessionId = sid;
  const agentName = agent?.() ?? "";
  if (agentName.length > 0) opts.agent = agentName;
  return opts;
}

function buildSubTaskMessage(ev: {
  subTaskId: string;
  status: string;
  progress?: number;
}): ExtensionToWebview {
  if (typeof ev.progress === "number") {
    return {
      type: "subTask",
      subTaskId: ev.subTaskId,
      status: ev.status,
      progress: ev.progress,
    };
  }
  return { type: "subTask", subTaskId: ev.subTaskId, status: ev.status };
}

export function createChatController(deps: ChatControllerDeps): ChatController {
  let active: AskStreamHandle | undefined;
  // Bumped whenever the display intent changes (start / resume / newConversation
  // / rehydrate). An in-flight hydrate captures the generation at request time
  // and discards its result if a newer intent superseded it while awaiting — so
  // a slow getSessionTranscript can't clobber a session the user has since
  // switched away from, and a started stream invalidates a pending hydrate.
  let generation = 0;

  // Session-scoped, not turn-scoped: "now explain the other half" is the normal
  // second question, so a turn must not consume its own context.
  const attached = new Map<string, Attachment>();
  let attachSeq = 0;

  const post = (m: ExtensionToWebview): void => {
    void deps.panel.postMessage(m);
  };

  // The one place a ResolvedAttachment becomes a wire chip, shared by the
  // "attachments" (with id) and "turnAttachments" (without) posts below, so
  // there is exactly one mapping to keep in sync with AttachmentOutcome.
  const wireChipFields = (
    c: ResolvedAttachment,
  ): {
    label: string;
    detail: string;
    state: ResolvedAttachment["outcome"]["state"];
    chars: number;
  } => ({
    label: c.label,
    detail: c.detail,
    state: c.outcome.state,
    chars: c.outcome.state === "refused" ? 0 : c.outcome.chars,
  });

  // Posts an "attachments" message from an ALREADY-BUILT AttachedContext, so a
  // caller that just resolved `built` for the prompt can reuse that exact
  // traversal for the preview instead of triggering a second, possibly
  // divergent read of the same files. `entries` must be the same
  // attached-map snapshot `built` was built from (same order), since the id
  // lookup below zips by identity against it.
  const postAttachmentsFrom = (
    built: AttachedContext,
    entries: ReadonlyArray<readonly [string, Attachment]>,
    provisional: boolean,
  ): void => {
    // Zip by IDENTITY, not by index. Index alignment holds only while
    // buildAttachedContext returns exactly one chip per input in order — true
    // today, and a silent mis-mapping tomorrow if it ever filters. A chip whose
    // id belongs to a different attachment means the remove button deletes the
    // wrong one, which is the kind of bug nobody suspects the zip for.
    post({
      type: "attachments",
      provisional,
      totalChars: built.totalChars,
      chips: built.chips.map((c) => ({
        id: entries.find(([, a]) => a === c.attachment)?.[0] ?? "",
        ...wireChipFields(c),
      })),
    });
  };

  // Attach/detach have no already-built context to reuse: build one from the
  // live attachment set and post it.
  const postAttachments = (provisional: boolean): void => {
    const entries = [...attached.entries()];
    const built = buildAttachedContext(
      entries.map(([, a]) => a),
      deps.readFile,
    );
    postAttachmentsFrom(built, entries, provisional);
  };

  const hydrate = async (sessionId: string, limit: number): Promise<void> => {
    const gen = generation;
    const superseded = (): boolean => active !== undefined || gen !== generation;
    try {
      const r = await deps.client.getSessionTranscript({ sessionId, limit });
      if (superseded()) return;
      post({ type: "hydrate", turns: r.turns });
    } catch (e) {
      deps.log.warn(`getSessionTranscript failed: ${errMsg(e)}`);
      if (superseded()) return;
      post({ type: "emptyState", sub: "no-transcript" });
    }
  };

  const handleEvent = async (ev: StreamEvent, handle: AskStreamHandle): Promise<boolean> => {
    if (active !== handle) return true;
    if (ev.type === "token") {
      post({ type: "token", text: ev.text });
      return false;
    }
    if (ev.type === "subTaskProgress") {
      post(buildSubTaskMessage(ev));
      return false;
    }
    if (ev.type === "hitlBatch") {
      post({
        type: "hitlInline",
        requestId: ev.requestId,
        prompt: ev.prompt,
        details: ev.details,
      });
      return false;
    }
    if (ev.type === "done") {
      post({ type: "done", reply: ev.reply, sessionId: ev.sessionId });
      // Only persist when this stream is still the active one — a concurrent
      // resume()/stop()/newConversation() may have superseded it, and a late
      // "done" must not clobber the session they switched to.
      if (ev.sessionId.length > 0 && active === handle) {
        await deps.sessionStore.set(ev.sessionId);
      }
      return true;
    }
    if (ev.type === "error") {
      post({ type: "error", message: ev.message });
      deps.log.error(`Stream error: ${ev.code}: ${ev.message}`);
      return true;
    }
    return false;
  };

  // Consume the stream: register it for HITL on the first event, dispatch each
  // event via handleEvent, and report whether any content arrived (a stream that
  // ends with none produced no answer). Extracted from start() to keep that
  // function's cognitive complexity in bounds.
  const consumeStream = async (handle: AskStreamHandle): Promise<boolean> => {
    let sawContent = false;
    let registered = false;
    for await (const ev of handle) {
      if (ev.type !== "done") sawContent = true;
      if (!registered && handle.streamId.length > 0) {
        deps.registerStreamWithHitl(handle.streamId);
        registered = true;
      }
      if (await handleEvent(ev, handle)) break;
    }
    return sawContent;
  };

  return {
    async start(input): Promise<void> {
      if (active !== undefined) {
        throw new Error("Stream in progress; click Stop or wait for it to finish.");
      }
      generation += 1; // a new live turn supersedes any in-flight hydrate
      // Built BEFORE any post: buildAskStreamOptions() invokes the
      // caller-supplied deps.agent() closure, which can throw. If that threw
      // after the manifest below had already been posted, the manifest would
      // stand with no retraction (no synchronous askStream() throw to catch
      // it) and the buffered turn chips would leak into the NEXT turn's
      // bubble instead of this one's.
      const opts = buildAskStreamOptions(deps.sessionStore, deps.agent);
      // Resolve now, not at attach time, so a file edited since attaching sends
      // what the user is actually looking at. The manifest is posted BEFORE the
      // request goes out: the composer is this surface's pre-flight preview, so
      // it must show the resolved bytes rather than a stale estimate.
      //
      // ONE traversal for the prompt, the resolved-chip post, the permanent
      // turn record, and the provisional-chip post below — reusing `built`
      // and `entries` throughout (nothing attaches/detaches synchronously in
      // between) is what keeps the chips from drifting from the bytes that
      // actually leave: a second call to buildAttachedContext here could
      // re-read a file that changed between the two reads.
      const entries = [...attached.entries()];
      const built = buildAttachedContext(
        entries.map(([, a]) => a),
        deps.readFile,
      );
      if (built.chips.length > 0) {
        postAttachmentsFrom(built, entries, false);
        post({
          type: "turnAttachments",
          chips: built.chips.map(wireChipFields),
        });
      }
      const prompt = built.blocks.length > 0 ? `${built.blocks}\n${input}` : input;
      // The resolved numbers belong to the turn just sent, and the turn keeps
      // them. For the composer they are already history: the attachments carry
      // into the follow-up, where they will be re-read, so anything shown now
      // is an estimate again. Posting this here rather than on stream-end keeps
      // it in the same tick as the send, so the chips never visibly flicker.
      if (built.chips.length > 0) postAttachmentsFrom(built, entries, true);
      let handle: AskStreamHandle;
      try {
        handle = deps.client.askStream(prompt, opts);
      } catch (e) {
        deps.log.error(`ask: askStream failed to start: ${errMsg(e)}`);
        // The turn manifest above was posted BEFORE this call so the resolved
        // preview would reach the webview ahead of the request — but the
        // request never actually left. Retract it, or the transcript ends up
        // claiming attachments were sent on a turn that never started.
        if (built.chips.length > 0) {
          post({ type: "turnAttachmentsFailed" });
        }
        post({ type: "userMessage", text: input });
        post({ type: "error", message: `Nimbus couldn't start the request: ${errMsg(e)}` });
        return;
      }
      active = handle;
      post({ type: "userMessage", text: input });
      try {
        const sawContent = await consumeStream(handle);
        // A stream that ends without any token/error/HITL event produced no
        // answer — common when the Gateway has no working LLM provider. An
        // empty assistant bubble tells the user nothing, so say so explicitly.
        // Guard on `active === handle` so a superseded stream stays silent.
        if (active === handle && !sawContent) {
          post({
            type: "error",
            message:
              "Nimbus reached the Gateway, but no answer came back — this usually means no language model is set up yet. Add an LLM provider (or API key) in your Gateway configuration, then try again.",
          });
        }
      } catch (e) {
        // The client can surface a mid-stream failure (e.g. the agent hitting
        // "No LLM provider available") by throwing from the iterator rather than
        // yielding an error event. Make it visible instead of failing silently.
        deps.log.error(`ask: stream failed: ${errMsg(e)}`);
        if (active === handle) {
          post({
            type: "error",
            message: `Nimbus ran into a problem answering: ${errMsg(e)}. If that mentions a missing model or invalid API key, set up an LLM provider in your Gateway and try again.`,
          });
        }
      } finally {
        if (handle.streamId.length > 0) {
          deps.unregisterStreamWithHitl(handle.streamId);
        }
        if (active === handle) active = undefined;
      }
    },
    async stop(): Promise<void> {
      if (active === undefined) return;
      const handle = active;
      active = undefined;
      // Post before awaiting cancel(): handle.cancel() awaits an IPC round-trip
      // (engine.cancelStream) that can hang on a severed connection, and the
      // webview's return-to-idle must not depend on the Gateway acking it.
      post({ type: "cancelled" });
      await handle.cancel();
    },
    async newConversation(): Promise<void> {
      attached.clear();
      // The composer's chips are the pre-flight preview for this surface — a
      // stale chip after "New conversation" would show an attachment that
      // will not actually be sent. "reset" clears the transcript and the
      // pending turn-manifest buffer, but never the composer's own
      // #attach-mount (see main.ts), so the (now empty) attachment state must
      // be posted explicitly rather than assumed to follow from the reset.
      postAttachments(true);
      generation += 1; // clearing the conversation supersedes any in-flight hydrate
      if (active !== undefined) {
        const handle = active;
        active = undefined;
        await handle.cancel();
      }
      await deps.sessionStore.clear();
      post({ type: "reset" });
    },
    async rehydrateIfNeeded(limit): Promise<void> {
      // A live stream owns the transcript. The webview's "ready" (which drives
      // this on a freshly-created panel) can land mid-stream; rehydrating then
      // would post emptyState/hydrate and clobber the buffered conversation the
      // stream just delivered. Leave the active stream's turns intact.
      if (active !== undefined) return;
      generation += 1;
      const sid = deps.sessionStore.get();
      if (sid === undefined) {
        post({ type: "emptyState", sub: "no-transcript" });
        return;
      }
      await hydrate(sid, limit);
    },
    async resume(sessionId, limit): Promise<void> {
      generation += 1; // switching sessions supersedes any in-flight hydrate
      if (active !== undefined) {
        const handle = active;
        active = undefined;
        await handle.cancel();
      }
      await deps.sessionStore.set(sessionId);
      post({ type: "reset" });
      await hydrate(sessionId, limit);
    },
    isStreaming: () => active !== undefined,
    attach(attachment): void {
      attachSeq += 1;
      attached.set(`a${attachSeq}`, attachment);
      postAttachments(true);
    },
    detach(id): void {
      attached.delete(id);
      postAttachments(true);
    },
    attachments(): readonly Attachment[] {
      return [...attached.values()];
    },
  };
}
