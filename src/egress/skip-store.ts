import type { MementoLike } from "../vscode-shim.js";

// The surfaces where the EXTENSION chooses what is sent, and therefore prompts:
// the two context-assembling ones, the built-in briefs, whose parameters the
// extension derives from the editor rather than from something the user typed,
// and a workflow run, where the user picks a name and the Gateway expands saved
// steps into model prompts. The other three never prompt, so they have nothing
// to suppress.
export type SkippableKind = "quickAsk" | "scm" | "brief" | "workflow";

// Workspace-scoped by construction (the caller passes ctx.workspaceState), so
// trusting your own repo does not carry into a client repo opened next week.
const KEYS: Record<SkippableKind, string> = {
  quickAsk: "nimbus.preflight.skip.quickAsk",
  scm: "nimbus.preflight.skip.scm",
  brief: "nimbus.preflight.skip.brief",
  workflow: "nimbus.preflight.skip.workflow",
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
