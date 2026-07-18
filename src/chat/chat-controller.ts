import type { AskStreamHandle, AskStreamOptions, StreamEvent } from "@nimbus-dev/client";

import { errMsg, type Logger } from "../logging.js";
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
}

export interface ChatController {
  start(input: string): Promise<void>;
  stop(): Promise<void>;
  newConversation(): Promise<void>;
  rehydrateIfNeeded(limit: number): Promise<void>;
  resume(sessionId: string, limit: number): Promise<void>;
  isStreaming(): boolean;
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

  const post = (m: ExtensionToWebview): void => {
    void deps.panel.postMessage(m);
  };

  const hydrate = async (sessionId: string, limit: number): Promise<void> => {
    try {
      const r = await deps.client.getSessionTranscript({ sessionId, limit });
      // A stream may have started while the transcript was loading (the entry
      // guard only covers the synchronous path). Don't clobber a live turn.
      if (active !== undefined) return;
      post({ type: "hydrate", turns: r.turns });
    } catch (e) {
      deps.log.warn(`getSessionTranscript failed: ${errMsg(e)}`);
      if (active !== undefined) return;
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

  return {
    async start(input): Promise<void> {
      if (active !== undefined) {
        throw new Error("Stream in progress; click Stop or wait for it to finish.");
      }
      const opts = buildAskStreamOptions(deps.sessionStore, deps.agent);
      let handle: AskStreamHandle;
      try {
        handle = deps.client.askStream(input, opts);
      } catch (e) {
        deps.log.error(`ask: askStream failed to start: ${errMsg(e)}`);
        post({ type: "userMessage", text: input });
        post({ type: "error", message: `Nimbus couldn't start the request: ${errMsg(e)}` });
        return;
      }
      active = handle;
      post({ type: "userMessage", text: input });
      let sawContent = false;
      try {
        let registered = false;
        for await (const ev of handle) {
          if (ev.type !== "done") sawContent = true;
          if (!registered && handle.streamId.length > 0) {
            deps.registerStreamWithHitl(handle.streamId);
            registered = true;
          }
          if (await handleEvent(ev, handle)) break;
        }
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
      const sid = deps.sessionStore.get();
      if (sid === undefined) {
        post({ type: "emptyState", sub: "no-transcript" });
        return;
      }
      await hydrate(sid, limit);
    },
    async resume(sessionId, limit): Promise<void> {
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
  };
}
