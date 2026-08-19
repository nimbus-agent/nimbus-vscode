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

  // Regression coverage for the primeAttachments bug this contract exists to
  // avoid: the OLD primeAttachments called `clear()` once, up front, then
  // awaited `cacheFile()` per attached file, one at a time. Two overlapping
  // primeAttachments runs (e.g. Send mashed twice, or a second Ask fired
  // before the first finished priming) race that single shared `clear()`
  // against a `cacheFile()` call the OTHER run already resolved and moved
  // past — wiping an entry nothing will ever re-fill, so a perfectly
  // readable file resolves as "unreadable · not sent". `cacheFile` alone
  // never has this problem: it only ever sets or deletes the ONE path it was
  // called for, never sweeps the map — which is exactly why primeAttachments
  // was fixed to stop calling `clear()` at all.
  test("clear() racing a concurrent cacheFile() wipes what that call already resolved", async () => {
    let resolveSlow: ((doc: OpenTextDocumentLike) => void) | undefined;
    const openTextDocument = vi.fn(
      (fsPath: string): Promise<OpenTextDocumentLike> =>
        fsPath === "/repo/slow.ts"
          ? new Promise((resolve) => {
              resolveSlow = resolve;
            })
          : Promise.resolve({ getText: () => "fast contents", uri: { fsPath } }),
    );
    const cache = createAttachmentCache({ workspaceRoot: () => "/repo", openTextDocument });

    // One prime run's per-file read has already resolved and cached...
    await cache.cacheFile("fast.ts");
    expect(cache.read("fast.ts")).toBe("fast contents");

    // ...while another run's read for a DIFFERENT file is still in flight —
    // and, as the old code did unconditionally at the top of every prime,
    // something calls clear().
    const slow = cache.cacheFile("slow.ts");
    cache.clear();

    // The already-cached, perfectly readable file is gone — nothing in
    // `cacheFile("slow.ts")`'s own in-flight call will ever restore it.
    expect(cache.read("fast.ts")).toBeUndefined();

    resolveSlow?.({ getText: () => "slow contents", uri: { fsPath: "/repo/slow.ts" } });
    await slow;
    expect(cache.read("slow.ts")).toBe("slow contents");
    expect(cache.read("fast.ts")).toBeUndefined();
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
