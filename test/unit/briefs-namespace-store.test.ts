import { describe, expect, test } from "vitest";

import { createNamespaceStore, memoryFolder } from "../../src/briefs/namespace-store.js";
import type { MementoLike } from "../../src/vscode-shim.js";

function memento(): MementoLike & { store: Map<string, unknown> } {
  const store = new Map<string, unknown>();
  return {
    store,
    get: <T>(key: string): T | undefined => store.get(key) as T | undefined,
    update: async (key: string, value: unknown) => {
      if (value === undefined) store.delete(key);
      else store.set(key, value);
    },
  } as MementoLike & { store: Map<string, unknown> };
}

describe("memoryFolder", () => {
  test("the sole root is used when there is no editor", () => {
    expect(memoryFolder(undefined, ["/home/dev/a"])).toBe("/home/dev/a");
  });

  test("the active editor picks its own root out of several", () => {
    expect(memoryFolder("/home/dev/b/src/x.ts", ["/home/dev/a", "/home/dev/b"])).toBe(
      "/home/dev/b",
    );
  });

  // The whole point of keying per folder: with no editor and several roots
  // there is no unambiguous project, so nothing is recalled and the prefill
  // falls through to the setting. A namespace from another project is a guess.
  test("no editor and several roots yields no folder", () => {
    expect(memoryFolder(undefined, ["/home/dev/a", "/home/dev/b"])).toBeUndefined();
  });

  test("no roots at all yields no folder", () => {
    expect(memoryFolder("/tmp/scratch.ts", [])).toBeUndefined();
  });
});

describe("namespace store", () => {
  test("a namespace remembered for one folder is not recalled for another", async () => {
    const store = createNamespaceStore(memento());
    await store.remember("/home/dev/a", "billing");
    expect(store.recall("/home/dev/a")).toBe("billing");
    expect(store.recall("/home/dev/b")).toBeUndefined();
  });

  test("an unknown folder recalls nothing", () => {
    expect(createNamespaceStore(memento()).recall(undefined)).toBeUndefined();
  });

  test("nothing is written without a folder", async () => {
    const m = memento();
    await createNamespaceStore(m).remember(undefined, "billing");
    expect(m.store.size).toBe(0);
  });

  test("an empty namespace is never remembered", async () => {
    const m = memento();
    await createNamespaceStore(m).remember("/home/dev/a", "");
    expect(m.store.size).toBe(0);
  });

  // Stored state is external data, exactly as skip-store treats it.
  test("a non-string stored value is ignored rather than returned", () => {
    const m = memento();
    m.store.set("nimbus.briefs.namespace:/home/dev/a", 42);
    expect(createNamespaceStore(m).recall("/home/dev/a")).toBeUndefined();
  });
});
