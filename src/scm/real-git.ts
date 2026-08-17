import * as vscode from "vscode";
import { errMsg, type Logger } from "../logging.js";
import type { ChangedFile, DiffScope, GitApiLike, GitRepositoryLike } from "./git-types.js";
import { relativeOrBasename } from "./paths.js";
import { type StatusedPath, untrackedPathsFrom } from "./untracked.js";

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
  // Both groups are optional: which one holds untracked entries depends on the
  // user's `git.untrackedChanges` setting — see untracked.ts.
  state: {
    HEAD?: { name?: string };
    untrackedChanges?: RawChange[];
    workingTreeChanges?: RawChange[];
    indexChanges?: RawChange[];
    onDidChange(listener: () => void): { dispose(): void };
  };
  diffIndexWithHEAD(): Promise<RawChange[]>;
  diffIndexWithHEAD(path: string): Promise<string>;
  diffWithHEAD(): Promise<RawChange[]>;
  diffWithHEAD(path: string): Promise<string>;
  log(opts: { maxEntries: number }): Promise<Array<{ message: string }>>;
}

interface RawGitApi {
  repositories: RawRepository[];
  onDidOpenRepository(listener: () => void): { dispose(): void };
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
    // The same state `untrackedPaths` below reads, and the same relativiser —
    // but no diff subprocess, because the context panel asks on every tick.
    changedPathsNow: () =>
      (raw.state.workingTreeChanges ?? []).map((c) => relativeOrBasename(root, c.uri.fsPath)),
    // Same state, same relativiser, same no-subprocess discipline — but the
    // INDEX-vs-HEAD side, which changedPathsNow does not cover.
    stagedPathsNow: () =>
      (raw.state.indexChanges ?? []).map((c) => relativeOrBasename(root, c.uri.fsPath)),
    fileDiff: async (scope, path) =>
      scope === "staged" ? raw.diffIndexWithHEAD(path) : raw.diffWithHEAD(path),
    untrackedPaths: async () => {
      const statused = (changes: RawChange[] | undefined): StatusedPath[] =>
        (changes ?? []).map((c) => ({
          path: relativeOrBasename(root, c.uri.fsPath),
          status: c.status,
        }));
      return untrackedPathsFrom(
        statused(raw.state.untrackedChanges),
        statused(raw.state.workingTreeChanges),
      );
    },
    log: async (maxEntries) => (await raw.log({ maxEntries })).map((c) => c.message),
    inputBox: raw.inputBox,
    branch: () => raw.state.HEAD?.name,
    onDidChange: (listener: () => void) => raw.state.onDidChange(listener),
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
      return {
        repositories: () => api.repositories.map(adaptRepository),
        onDidOpenRepository: (listener: () => void) => api.onDidOpenRepository(listener),
      };
    } catch (e) {
      log.warn(`scm: git extension unavailable: ${errMsg(e)}`);
      return undefined;
    }
  };
}
