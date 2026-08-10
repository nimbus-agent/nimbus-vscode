import type { WhyPeek } from "@nimbus-dev/client";

import { errMsg, type Logger } from "../logging.js";
import type { EditorTarget } from "./params.js";
import { renderPeek } from "./peek.js";

// A second-stage guard on top of VS Code's own mouse-rest delay: it filters a
// cursor sweeping across a file. Below ~100ms it stops filtering anything;
// above ~250ms the hover feels broken.
export const HOVER_SETTLE_MS = 150;

/** The slice of vscode.CancellationToken this needs. */
export interface CancellationLike {
  readonly isCancellationRequested: boolean;
}

export interface PeekHoverDeps {
  /** Throws when disconnected; the controller declines rather than surfacing it. */
  peek(params: { ref: string; line: number }): Promise<WhyPeek>;
  /** nimbus.briefs.showHoverBlame. Read per hover so a toggle takes effect at once. */
  enabled(): boolean;
  /** Injected so tests do not wait in real time. */
  settle(ms: number): Promise<void>;
  now(): number;
  log: Logger;
}

export interface PeekHover {
  provide(req: {
    target: EditorTarget;
    /** Identifies the document, so hovers in different files do not supersede each other. */
    docKey: string;
    token: CancellationLike;
  }): Promise<string | undefined>;
}

export function createPeekHover(deps: PeekHoverDeps): PeekHover {
  // One in-flight request per document. This is the ONLY backpressure available:
  // agentsWhyPeek takes a single argument — no options object, no timeout, no
  // abort signal — so a cancelled token cannot stop the round trip, it can only
  // stop a stale reply being rendered.
  const seqByDoc = new Map<string, number>();

  return {
    provide: async ({ target, docKey, token }) => {
      if (!deps.enabled()) return undefined;

      const mine = (seqByDoc.get(docKey) ?? 0) + 1;
      seqByDoc.set(docKey, mine);

      await deps.settle(HOVER_SETTLE_MS);
      if (token.isCancellationRequested) return undefined;
      if (seqByDoc.get(docKey) !== mine) return undefined;

      let peek: WhyPeek;
      try {
        peek = await deps.peek({ ref: target.ref, line: target.line });
      } catch (e) {
        // Ambient surface: never surface an error the user did not ask for.
        deps.log.debug(`whyPeek hover failed: ${errMsg(e)}`);
        return undefined;
      }

      if (token.isCancellationRequested) return undefined;
      if (seqByDoc.get(docKey) !== mine) return undefined;
      return renderPeek(peek, target, deps.now());
    },
  };
}
