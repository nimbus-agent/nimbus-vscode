import { describe, expect, test } from "vitest";
import type { ConnectionState } from "../../src/connection/connection-manager.js";
import { createController } from "../../src/context/controller.js";
import type { SignalSection, SignalSpec } from "../../src/context/signals.js";
import { buildSnapshot, type ContextSnapshot } from "../../src/context/snapshot.js";

const editor = {
  path: "src/a.ts",
  scheme: "file",
  languageId: "typescript",
  line: 1,
  selection: "",
  isDirty: false,
};

const snap = (generation: number, line = 1): ContextSnapshot =>
  buildSnapshot({ generation, editor: { ...editor, line } });

const silentLog = {
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
  debug: () => undefined,
};

function harness(opts: {
  collect: (snapshot: ContextSnapshot) => Promise<SignalSection>;
  needsGateway?: boolean;
  connected?: boolean;
}) {
  const posted: Array<{ type: string; section?: SignalSection }> = [];
  const listeners: Array<(s: ConnectionState) => void> = [];
  const spec: SignalSpec = {
    id: "blame",
    needsGateway: opts.needsGateway ?? true,
    collect: (s) => opts.collect(s),
    cacheKey: (s) => (s.line === undefined ? undefined : `${s.path}:${s.line}`),
  };
  const controller = createController({
    signals: [spec],
    signalDeps: { client: () => undefined, now: () => 0, searchLimit: () => 20 },
    connection: {
      current: () =>
        ((opts.connected ?? true)
          ? { kind: "connected" }
          : { kind: "disconnected" }) as ConnectionState,
      onState: (l) => {
        listeners.push(l);
        return { dispose: () => undefined };
      },
    },
    post: (m) => posted.push(m as { type: string; section?: SignalSection }),
    isVisible: () => true,
    log: silentLog as unknown as Parameters<typeof createController>[0]["log"],
  });
  const fire = (s: ConnectionState): void => {
    for (const l of listeners) l(s);
  };
  return { controller, posted, fire };
}

const section = (rows: number): SignalSection => ({
  id: "blame",
  title: "History",
  rows: Array.from({ length: rows }, (_, i) => ({ label: `row ${i}` })),
});

describe("createController", () => {
  test("posts a render first, then a section per collector", async () => {
    const h = harness({ collect: async () => section(1) });
    await h.controller.collect(snap(1));
    expect(h.posted[0]?.type).toBe("render");
    expect(h.posted.at(-1)?.type).toBe("section");
  });

  test("marks a Gateway-backed section loading in the first render", async () => {
    const h = harness({ collect: async () => section(1) });
    const done = h.controller.collect(snap(1));
    const first = h.posted[0] as unknown as { sections: SignalSection[] };
    expect(first.sections[0]?.loading).toBe(true);
    await done;
  });

  test("serves a repeat collection for the same key from cache", async () => {
    let calls = 0;
    const h = harness({
      collect: async () => {
        calls += 1;
        return section(1);
      },
    });
    await h.controller.collect(snap(1));
    await h.controller.collect(snap(2));
    expect(calls).toBe(1);
  });

  test("collects again when the cache key changes", async () => {
    let calls = 0;
    const h = harness({
      collect: async () => {
        calls += 1;
        return section(1);
      },
    });
    await h.controller.collect(snap(1, 1));
    await h.controller.collect(snap(2, 9));
    expect(calls).toBe(2);
  });

  test("coalesces concurrent collections of the same key into one call", async () => {
    let calls = 0;
    const h = harness({
      collect: async () => {
        calls += 1;
        await Promise.resolve();
        return section(1);
      },
    });
    await Promise.all([h.controller.collect(snap(1)), h.controller.collect(snap(1))]);
    expect(calls).toBe(1);
  });

  test("drops a result whose generation is no longer current", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let first = true;
    const h = harness({
      collect: async () => {
        if (first) {
          first = false;
          await gate;
        }
        return section(1);
      },
    });
    const slow = h.controller.collect(snap(1, 1));
    await h.controller.collect(snap(2, 2));
    release?.();
    await slow;
    const sections = h.posted.filter((p) => p.type === "section");
    expect(sections).toHaveLength(1);
  });

  test("does not collect at all while the view is hidden", async () => {
    let calls = 0;
    const posted: unknown[] = [];
    const controller = createController({
      signals: [
        {
          id: "blame",
          needsGateway: true,
          collect: async () => {
            calls += 1;
            return section(1);
          },
          cacheKey: () => "k",
        },
      ],
      signalDeps: { client: () => undefined, now: () => 0, searchLimit: () => 20 },
      connection: {
        current: () => ({ kind: "connected" }) as ConnectionState,
        onState: () => ({ dispose: () => undefined }),
      },
      post: (m) => posted.push(m),
      isVisible: () => false,
      log: silentLog as never,
    });
    await controller.collect(snap(1));
    expect(calls).toBe(0);
    expect(posted).toEqual([]);
  });

  test("skips a Gateway signal entirely while disconnected", async () => {
    let calls = 0;
    const h = harness({
      connected: false,
      collect: async () => {
        calls += 1;
        return section(1);
      },
    });
    await h.controller.collect(snap(1));
    expect(calls).toBe(0);
    const rendered = h.posted[0] as unknown as { sections: SignalSection[] };
    expect(rendered.sections[0]?.empty).toBe("Needs the Nimbus Gateway.");
  });

  test("invalidatePath drops cached entries for that path", async () => {
    let calls = 0;
    const h = harness({
      collect: async () => {
        calls += 1;
        return section(1);
      },
    });
    await h.controller.collect(snap(1));
    h.controller.invalidatePath("src/a.ts");
    await h.controller.collect(snap(2));
    expect(calls).toBe(2);
  });

  test("re-collects when the connection comes back", async () => {
    let calls = 0;
    const h = harness({
      collect: async () => {
        calls += 1;
        return section(1);
      },
    });
    await h.controller.collect(snap(1));
    h.fire({ kind: "connected" } as ConnectionState);
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toBeGreaterThan(1);
  });

  test("refreshes when the connection drops, so stale answers do not linger", async () => {
    const h = harness({ collect: async () => section(1) });
    await h.controller.collect(snap(1));
    const before = h.posted.length;
    h.fire({ kind: "disconnected" } as ConnectionState);
    await Promise.resolve();
    await Promise.resolve();
    expect(h.posted.length).toBeGreaterThan(before);
  });

  test("posts an error section rather than leaving one loading forever", async () => {
    const h = harness({
      collect: async () => {
        throw new Error("collector exploded");
      },
    });
    await h.controller.collect(snap(1));
    const last = h.posted.at(-1);
    expect(last?.type).toBe("section");
    expect(last?.section?.rows[0]?.label).toContain("collector exploded");
    expect(last?.section?.loading).toBeUndefined();
  });

  test("posts an error section when a collector throws synchronously", async () => {
    const h = harness({
      collect: () => {
        throw new Error("thrown before any await");
      },
    });
    await h.controller.collect(snap(1));
    expect(h.posted.at(-1)?.section?.rows[0]?.label).toContain("thrown before any await");
  });

  test("clears the in-flight entry after a failure, so the next collection retries", async () => {
    let calls = 0;
    const h = harness({
      collect: async () => {
        calls += 1;
        throw new Error("boom");
      },
    });
    await h.controller.collect(snap(1));
    await h.controller.collect(snap(2));
    // Two attempts, not one: a failed collection must not be cached as
    // in-flight, or the key would be permanently poisoned.
    expect(calls).toBe(2);
  });
});
