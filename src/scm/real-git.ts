import * as vscode from "vscode";
import { errMsg, type Logger } from "../logging.js";
import type { ChangedFile, DiffScope, GitApiLike, GitRepositoryLike } from "./git-types.js";
import { relativeOrBasename } from "./paths.js";

// Thin vscode-git glue — mirrors real-participant.ts. Excluded from coverage;
// the pure modules carry the logic and the tests.
//
// The git extension's API is not typed on our side. Resolving the API itself is
// guarded here and degrades to "git unavailable" rather than throwing; a shape
// mismatch discovered later, on a per-repository call, is not caught here —
// commands.ts catches it, at the per-command level.

interface RawChange {
  uri: { fsPath: string };
  status: number;
}

interface RawRepository {
  rootUri: { fsPath: string };
  inputBox: { value: string };
  state: { untrackedChanges?: RawChange[] };
  diffIndexWithHEAD(): Promise<RawChange[]>;
  diffIndexWithHEAD(path: string): Promise<string>;
  diffWithHEAD(): Promise<RawChange[]>;
  diffWithHEAD(path: string): Promise<string>;
  log(opts: { maxEntries: number }): Promise<Array<{ message: string }>>;
}

interface RawGitApi {
  repositories: RawRepository[];
}

function adaptRepository(raw: RawRepository): GitRepositoryLike {
  const root = raw.rootUri.fsPath;
  // `path` here doubles as both the agent-safe display path AND the key
  // `fileDiff` below queries git with. When relativeOrBasename falls back to
  // a bare basename (root mismatch — see paths.ts), that basename is what
  // gets passed to `diffIndexWithHEAD`/`diffWithHEAD` too, which git will not
  // resolve to the real file. In practice this yields an empty diff, so the
  // file is reported (harmlessly) as non-textual rather than by its real path.
  const listing = async (scope: DiffScope): Promise<readonly ChangedFile[]> => {
    const changes = scope === "staged" ? await raw.diffIndexWithHEAD() : await raw.diffWithHEAD();
    return changes.map((c) => ({
      path: relativeOrBasename(root, c.uri.fsPath),
      status: String(c.status),
    }));
  };
  return {
    rootPath: root,
    changedFiles: listing,
    fileDiff: async (scope, path) =>
      scope === "staged" ? raw.diffIndexWithHEAD(path) : raw.diffWithHEAD(path),
    untrackedPaths: async () =>
      (raw.state.untrackedChanges ?? []).map((c) => relativeOrBasename(root, c.uri.fsPath)),
    log: async (maxEntries) => (await raw.log({ maxEntries })).map((c) => c.message),
    inputBox: raw.inputBox,
  };
}

// Resolved lazily on first use: the git extension may activate after us.
export function createRealGitApi(log: Logger): () => Promise<GitApiLike | undefined> {
  return async () => {
    try {
      const ext = vscode.extensions.getExtension("vscode.git");
      if (ext === undefined) return undefined;
      const exports: unknown = ext.isActive ? ext.exports : await ext.activate();
      if (typeof exports !== "object" || exports === null) return undefined;
      const getApi = (exports as { getAPI?: (v: number) => unknown }).getAPI;
      if (typeof getApi !== "function") return undefined;
      const api = getApi.call(exports, 1) as RawGitApi | undefined;
      if (api === undefined || !Array.isArray(api.repositories)) return undefined;
      return { repositories: () => api.repositories.map(adaptRepository) };
    } catch (e) {
      log.warn(`scm: git extension unavailable: ${errMsg(e)}`);
      return undefined;
    }
  };
}
