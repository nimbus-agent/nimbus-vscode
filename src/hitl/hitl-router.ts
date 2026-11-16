import type { HitlRequest } from "@nimbus-dev/client";

export type HitlDecision = "approve" | "reject";

export interface HitlRouterDeps {
  chatPanelVisibleAndFocused(): boolean;
  streamRegistered(streamId: string): boolean;
  showInline(req: HitlRequest): Promise<HitlDecision | undefined>;
  showToast(req: HitlRequest): Promise<HitlDecision | undefined>;
  showModal(req: HitlRequest): Promise<HitlDecision | undefined>;
  /**
   * A type-to-confirm request: the person must TYPE `req.confirmText`. Resolves with exactly
   * what they typed, or `undefined` if they dismissed the box. Never pre-filled, never
   * compared here: the Gateway decides.
   */
  askTyped(req: HitlRequest): Promise<string | undefined>;
  /** `typed` is set only for a type-to-confirm approval, and is sent unchanged. */
  sendResponse(requestId: string, decision: HitlDecision, typed?: string): Promise<void>;
  onCountChange(count: number): void;
  alwaysModal(): boolean;
}

export interface HitlRouter {
  handle(req: HitlRequest): Promise<void>;
  snapshot(): HitlRequest[];
}

export function createHitlRouter(deps: HitlRouterDeps): HitlRouter {
  const pending = new Map<string, HitlRequest>();
  // Typed prompts are shown ONE AT A TIME. VS Code has a single quick input: opening a second
  // box replaces the first, which then resolves as dismissed, and a dismissed typed prompt is a
  // rejection. Without this queue a second request arriving mid-prompt would reject the first
  // although the person never dismissed it.
  let typedQueue: Promise<unknown> = Promise.resolve();
  const askTypedInTurn = (req: HitlRequest): Promise<string | undefined> => {
    const turn = typedQueue.then(() => deps.askTyped(req));
    // The queue moves on whether this prompt was answered, dismissed or failed.
    typedQueue = turn.catch(() => undefined);
    return turn;
  };

  const emitCount = (): void => {
    deps.onCountChange(pending.size);
  };

  const handleOne = async (req: HitlRequest): Promise<void> => {
    if (pending.has(req.requestId)) return;
    pending.set(req.requestId, req);
    emitCount();
    try {
      // A type-to-confirm request has ONE surface: the input box. No inline card, toast or
      // modal button can approve it, and nothing here ever answers it on the person's behalf.
      if (req.confirmText !== undefined) {
        const typed = await askTypedInTurn(req);
        await (typed === undefined
          ? deps.sendResponse(req.requestId, "reject")
          : deps.sendResponse(req.requestId, "approve", typed));
        return;
      }
      const useInline =
        typeof req.streamId === "string" &&
        deps.streamRegistered(req.streamId) &&
        deps.chatPanelVisibleAndFocused();
      let decision: HitlDecision | undefined;
      if (useInline) {
        decision = await deps.showInline(req);
      } else if (deps.alwaysModal()) {
        decision = await deps.showModal(req);
      } else {
        decision = await deps.showToast(req);
      }
      if (decision !== undefined) {
        await deps.sendResponse(req.requestId, decision);
      }
    } finally {
      pending.delete(req.requestId);
      emitCount();
    }
  };

  return {
    handle: handleOne,
    snapshot: () => Array.from(pending.values()),
  };
}
