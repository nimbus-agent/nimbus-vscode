import { describe, expect, test, vi } from "vitest";

import { createAttachmentCache } from "../../src/chat/attachment-cache.js";
import { buildAttachedContext } from "../../src/chat/attachments.js";
import type { OpenTextDocumentLike } from "../../src/vscode-shim.js";

// Exercises the wiring `extension.ts` delegates to: openTextDocument resolving
// a real document, the containment rejection, and a failed open — none of
// which any test reached before (extension.test.ts's WorkspaceApi double
// gives openTextDocument an unconditional reject, and there is no attach()
// call site yet to drive it through activateWithDeps). This is the cheapest
// honest seam: real inputs (an injected openTextDocument), real output (the
// cache, and — via buildAttachedContext — the actual payload a chip carries).

describe("createAttachmentCache", () => {
  test("a resolved document's contents reach the cache and the payload", async () => {
    const openTextDocument = vi.fn(
      async (fsPath: string): Promise<OpenTextDocumentLike> => ({
        getText: () => "export const a = 1;\n",
        uri: { fsPath },
      }),
    );
    const cache = createAttachmentCache({ workspaceRoot: () => "/repo", openTextDocument });

    await cache.cacheFile("src/a.ts");

    expect(openTextDocument).toHaveBeenCalledWith("/repo/src/a.ts");
    expect(cache.read("src/a.ts")).toBe("export const a = 1;\n");

    // And therefore the payload: the same `read` function is what gets wired
    // as ChatControllerDeps.readFile, so run it through the real assembler.
    const built = buildAttachedContext([{ kind: "file", path: "src/a.ts" }], cache.read);
    expect(built.chips[0]?.outcome).toEqual({ state: "sent", chars: expect.any(Number) });
    expect(built.blocks).toContain("export const a = 1;");
  });

  test("a path escaping the workspace root is rejected before any read", async () => {
    const openTextDocument = vi.fn(
      async (fsPath: string): Promise<OpenTextDocumentLike> => ({
        getText: () => "should never be reached",
        uri: { fsPath },
      }),
    );
    const cache = createAttachmentCache({ workspaceRoot: () => "/repo", openTextDocument });

    await expect(cache.cacheFile("../../etc/passwd")).resolves.toBeUndefined();

    expect(openTextDocument).not.toHaveBeenCalled();
    expect(cache.read("../../etc/passwd")).toBeUndefined();

    // The assembler degrades this to a refusal, not a throw.
    const built = buildAttachedContext([{ kind: "file", path: "../../etc/passwd" }], cache.read);
    expect(built.chips[0]?.outcome).toEqual({ state: "refused", reason: "unreadable" });
    expect(built.chips[0]?.detail).toBe("unreadable · not sent");
  });

  test("a document that fails to open clears the cache instead of throwing", async () => {
    const openTextDocument = vi.fn(async (): Promise<OpenTextDocumentLike> => {
      throw new Error("ENOENT: no such file");
    });
    const cache = createAttachmentCache({ workspaceRoot: () => "/repo", openTextDocument });

    await expect(cache.cacheFile("gone.ts")).resolves.toBeUndefined();

    expect(openTextDocument).toHaveBeenCalledWith("/repo/gone.ts");
    expect(cache.read("gone.ts")).toBeUndefined();
  });

  test("clear() drops every cached entry", async () => {
    const openTextDocument = vi.fn(
      async (fsPath: string): Promise<OpenTextDocumentLike> => ({
        getText: () => "x",
        uri: { fsPath },
      }),
    );
    const cache = createAttachmentCache({ workspaceRoot: () => "/repo", openTextDocument });

    await cache.cacheFile("a.ts");
    expect(cache.read("a.ts")).toBe("x");

    cache.clear();
    expect(cache.read("a.ts")).toBeUndefined();
  });

  test("with no workspace root, a relative path is still read (nothing to contain it against)", async () => {
    const openTextDocument = vi.fn(
      async (fsPath: string): Promise<OpenTextDocumentLike> => ({
        getText: () => "loose file contents",
        uri: { fsPath },
      }),
    );
    const cache = createAttachmentCache({ workspaceRoot: () => undefined, openTextDocument });

    await cache.cacheFile("a.ts");

    expect(openTextDocument).toHaveBeenCalledWith("a.ts");
    expect(cache.read("a.ts")).toBe("loose file contents");
  });
});
