import type { MementoLike } from "../vscode-shim.js";

// Only the two surfaces where the EXTENSION assembles context can be skipped;
// the other three never prompt, so they have nothing to suppress.
export type SkippableKind = "quickAsk" | "scm";

// Workspace-scoped by construction (the caller passes ctx.workspaceState), so
// trusting your own repo does not carry into a client repo opened next week.
const KEYS: Record<SkippableKind, string> = {
  quickAsk: "nimbus.preflight.skip.quickAsk",
  scm: "nimbus.preflight.skip.scm",
};

export interface PreflightSkipStore {
  isSkipped(kind: SkippableKind): boolean;
  setSkipped(kind: SkippableKind): Promise<void>;
  clearAll(): Promise<void>;
}

export function createPreflightSkipStore(memento: MementoLike): PreflightSkipStore {
  return {
    // Stored state is external data: only an exact `true` suppresses the gate,
    // so a corrupted or hand-edited value fails closed.
    isSkipped: (kind) => memento.get<unknown>(KEYS[kind]) === true,
    setSkipped: async (kind) => {
      await memento.update(KEYS[kind], true);
    },
    clearAll: async () => {
      for (const key of Object.values(KEYS)) await memento.update(key, undefined);
    },
  };
}
