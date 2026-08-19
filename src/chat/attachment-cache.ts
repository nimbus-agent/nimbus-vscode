import type { OpenTextDocumentLike } from "../vscode-shim.js";
import { isWithinRoot, toAbsolute } from "./attachment-paths.js";

export interface AttachmentCacheDeps {
  /** The current workspace root, re-read each call (a folder can open/close). */
  workspaceRoot(): string | undefined;
  /** The shim's `WorkspaceApi.openTextDocument`, injected so this stays pure. */
  openTextDocument(fsPath: string): Thenable<OpenTextDocumentLike>;
}

export interface AttachmentCache {
  /**
   * Synchronous lookup, wired as `ChatControllerDeps.readFile`. `undefined`
   * for anything never cached or cached-then-cleared — the assembler reports
   * that as "unreadable · not sent", never throws.
   */
  read(path: string): string | undefined;
  /**
   * Drops every cached file. Nothing in `src/` calls this: `primeAttachments`
   * used to, and clearing mid-await made a file attached during that window
   * resolve as "unreadable · not sent" though it read perfectly well.
   * `cacheFile` overwrites or deletes per path, which is all the freshness a
   * send needs. Kept for tests and for a future caller that genuinely wants
   * the whole cache gone.
   */
  clear(): void;
  /**
   * Reads one repo-relative path into the cache. A path that resolves outside
   * the workspace root is rejected BEFORE `openTextDocument` is ever called —
   * the containment check this task owns. Silent on any other failure too
   * (a deleted file, a permission error): the assembler is what reports it,
   * this just clears whatever stale entry might exist for that path.
   */
  cacheFile(path: string): Promise<void>;
}

export function createAttachmentCache(deps: AttachmentCacheDeps): AttachmentCache {
  const cache = new Map<string, string>();
  return {
    read: (path) => cache.get(path),
    clear: () => cache.clear(),
    async cacheFile(path) {
      const root = deps.workspaceRoot();
      const absolute = toAbsolute(root, path);
      if (!isWithinRoot(root, absolute)) {
        cache.delete(path);
        return;
      }
      try {
        const doc = await deps.openTextDocument(absolute);
        cache.set(path, doc.getText());
      } catch {
        cache.delete(path);
      }
    },
  };
}
