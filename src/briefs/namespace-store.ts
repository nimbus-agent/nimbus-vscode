import type { MementoLike } from "../vscode-shim.js";
import { rootFor } from "./params.js";

// The last namespace the user typed and confirmed for Preflight, keyed PER
// WORKSPACE FOLDER.
//
// workspaceState is shared across the whole VS Code window, so a single key
// would let a Preflight in one project prefill another's prompt. That is not
// "a value the user confirmed here" — it is a guess wearing a confirmation's
// clothes, and a wrong namespace does not error: agents.preflight returns a
// confidently green brief computed for something the user never asked about.
// The design doc rejects deriving the namespace for exactly that reason, so a
// stale cross-project prefill has to be rejected on the same grounds.

const PREFIX = "nimbus.briefs.namespace:";

export interface NamespaceStore {
  recall(folder: string | undefined): string | undefined;
  remember(folder: string | undefined, namespace: string): Promise<void>;
}

/**
 * The folder to key the memory on: the root containing the active editor, else
 * the sole root. With no editor and several roots there is no unambiguous
 * project, so this returns undefined and the caller recalls nothing — failing
 * to the safe side costs one typed namespace.
 */
export function memoryFolder(
  activeFile: string | undefined,
  roots: readonly string[],
): string | undefined {
  const containing = activeFile === undefined ? undefined : rootFor(activeFile, roots);
  if (containing !== undefined) return containing;
  return roots.length === 1 ? roots[0] : undefined;
}

export function createNamespaceStore(memento: MementoLike): NamespaceStore {
  return {
    // Stored state is external data: anything that is not a non-empty string
    // recalls nothing, so a corrupted or hand-edited value fails closed.
    recall: (folder) => {
      if (folder === undefined) return undefined;
      const value = memento.get<unknown>(`${PREFIX}${folder}`);
      return typeof value === "string" && value.length > 0 ? value : undefined;
    },
    remember: async (folder, namespace) => {
      if (folder === undefined || namespace.length === 0) return;
      await memento.update(`${PREFIX}${folder}`, namespace);
    },
  };
}
