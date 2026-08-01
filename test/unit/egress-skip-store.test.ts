import { describe, expect, test } from "vitest";

import { createPreflightSkipStore } from "../../src/egress/skip-store.js";
import type { MementoLike } from "../../src/vscode-shim.js";

class FakeMemento implements MementoLike {
  readonly store = new Map<string, unknown>();
  get<T>(key: string, defaultValue?: T): T | undefined {
    return (this.store.get(key) as T | undefined) ?? defaultValue;
  }
  async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) this.store.delete(key);
    else this.store.set(key, value);
  }
}

describe("createPreflightSkipStore", () => {
  test("nothing is skipped by default", () => {
    const s = createPreflightSkipStore(new FakeMemento());
    expect(s.isSkipped("quickAsk")).toBe(false);
    expect(s.isSkipped("scm")).toBe(false);
  });

  test("skipping one surface leaves the other still gated", async () => {
    const s = createPreflightSkipStore(new FakeMemento());
    await s.setSkipped("quickAsk");
    expect(s.isSkipped("quickAsk")).toBe(true);
    expect(s.isSkipped("scm")).toBe(false);
  });

  test("clearAll resets every surface", async () => {
    const s = createPreflightSkipStore(new FakeMemento());
    await s.setSkipped("quickAsk");
    await s.setSkipped("scm");
    await s.clearAll();
    expect(s.isSkipped("quickAsk")).toBe(false);
    expect(s.isSkipped("scm")).toBe(false);
  });

  test("stores under stable, namespaced keys", async () => {
    const m = new FakeMemento();
    await createPreflightSkipStore(m).setSkipped("scm");
    expect([...m.store.keys()]).toEqual(["nimbus.preflight.skip.scm"]);
  });

  test("a non-boolean stored value does not count as skipped", () => {
    const m = new FakeMemento();
    m.store.set("nimbus.preflight.skip.scm", "yes");
    expect(createPreflightSkipStore(m).isSkipped("scm")).toBe(false);
  });
});
