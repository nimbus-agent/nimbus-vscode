import { describe, expect, test } from "vitest";
import type { ConnectionState } from "../../src/connection/connection-manager.js";
import { createController } from "../../src/context/controller.js";
import type { SignalSection, SignalSpec } from "../../src/context/signals.js";
import { buildSnapshot, type ContextSnapshot } from "../../src/context/snapshot.js";
import type { Logger } from "../../src/logging.js";

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

// Records every line logged, prefixed the way the real Logger prefixes them,
// so a test can assert on cadence output the same way a human reads the
// output channel.
function makeRecordingLog(): Logger & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    error: (m) => lines.push(`[error] ${m}`),
    warn: (m) => lines.push(`[warn] ${m}`),
    info: (m) => lines.push(`[info] ${m}`),
    debug: (m) => lines.push(`[debug] ${m}`),
  };
}

function harness(opts: {
  collect: (snapshot: ContextSnapshot) => Promise<SignalSection>;
  needsGateway?: boolean;
  connected?: boolean;
}) {
  const posted: Array<{ type: string; section?: SignalSection }> = [];
  const listeners: Array<(s: ConnectionState) => void> = [];
  const log = makeRecordingLog();
  // A mutable variable `fire` updates before invoking listeners, so a test
  // that fires "disconnected" actually gets a disconnected `current()` when
  // the resulting refresh reads it — a fixed closure here would silently
  // turn every fired state back into whatever `connected` was at harness
  // creation, and the "drops on disconnect" test would assert nothing real.
  let currentState: ConnectionState = (
    (opts.connected ?? true) ? { kind: "connected" } : { kind: "disconnected" }
  ) as ConnectionState;
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
      current: () => currentState,
      onState: (l) => {
        listeners.push(l);
        return { dispose: () => undefined };
      },
    },
    post: (m) => posted.push(m as { type: string; section?: SignalSection }),
    isVisible: () => true,
    log,
  });
  const fire = (s: ConnectionState): void => {
    currentState = s;
    for (const l of listeners) l(s);
  };
  return { controller, posted, fire, log };
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
    h.fire({ kind: "disconnected" } as ConnectionState);
    await Promise.resolve();
    await Promise.resolve();
    // The claim is not just "something more was posted" — it is that the
    // stale blame answer on screen is replaced by the needs-Gateway
    // placeholder. A harness whose current() ignored the fired state could
    // not fail this assertion even with no refresh logic at all.
    const last = h.posted.at(-1) as unknown as { type: string; sections: SignalSection[] };
    expect(last.type).toBe("render");
    expect(last.sections[0]?.empty).toBe("Needs the Nimbus Gateway.");
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

  test("does not cache a transient section — a caught Gateway hiccup must not pin itself in place", async () => {
    let calls = 0;
    const h = harness({
      collect: async () => {
        calls += 1;
        return {
          id: "blame",
          title: "History",
          rows: [{ label: "Blame unavailable: ECONNRESET", iconId: "error" }],
          transient: true,
        };
      },
    });
    await h.controller.collect(snap(1));
    await h.controller.collect(snap(2));
    expect(calls).toBe(2);
  });

  test("invalidating mid-flight means the next collection refetches, and the stale answer never lands in the cache", async () => {
    let calls = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const h = harness({
      collect: async () => {
        calls += 1;
        if (calls === 1) await gate;
        return section(1);
      },
    });
    const first = h.controller.collect(snap(1));
    // Give runOne a turn to register its in-flight entry before invalidating.
    await Promise.resolve();
    h.controller.invalidatePath("src/a.ts");
    release?.();
    await first;
    // If the stale answer had landed in the cache despite the invalidation,
    // this second collection (same key) would be served from cache and
    // `calls` would stay at 1.
    await h.controller.collect(snap(2));
    expect(calls).toBe(2);
  });

  test("invalidatePath drops a related-shaped entry whose key never mentions the path", async () => {
    let calls = 0;
    const spec: SignalSpec = {
      id: "related",
      needsGateway: true,
      collect: async () => {
        calls += 1;
        return { id: "related", title: "Related", rows: [] };
      },
      // Keyed purely on the selected text — e.g. "parseWidget" — exactly like
      // relatedSection's real key once a selection is active: a key that
      // never contains "src/a.ts" anywhere in its text.
      cacheKey: () => "parseWidget",
    };
    const controller = createController({
      signals: [spec],
      signalDeps: { client: () => undefined, now: () => 0, searchLimit: () => 20 },
      connection: {
        current: () => ({ kind: "connected" }) as ConnectionState,
        onState: () => ({ dispose: () => undefined }),
      },
      post: () => undefined,
      isVisible: () => true,
      log: silentLog as never,
    });
    await controller.collect(snap(1)); // snapshot path is "src/a.ts"
    controller.invalidatePath("src/a.ts");
    await controller.collect(snap(2));
    expect(calls).toBe(2);
  });

  test("evicts the oldest cache entry once the per-signal limit is exceeded", async () => {
    const calls: string[] = [];
    const spec: SignalSpec = {
      id: "blame",
      needsGateway: true,
      collect: async (s) => {
        calls.push(`${s.path}:${s.line}`);
        return section(1);
      },
      cacheKey: (s) => (s.line === undefined ? undefined : `${s.path}:${s.line}`),
    };
    const controller = createController({
      signals: [spec],
      signalDeps: { client: () => undefined, now: () => 0, searchLimit: () => 20 },
      connection: {
        current: () => ({ kind: "connected" }) as ConnectionState,
        onState: () => ({ dispose: () => undefined }),
      },
      post: () => undefined,
      isVisible: () => true,
      log: silentLog as never,
      cacheLimit: 2,
    });
    await controller.collect(snap(1, 1));
    await controller.collect(snap(2, 2));
    await controller.collect(snap(3, 3)); // evicts line 1's entry (limit 2)
    await controller.collect(snap(4, 1)); // line 1 again: must recollect
    expect(calls).toEqual(["src/a.ts:1", "src/a.ts:2", "src/a.ts:3", "src/a.ts:1"]);
  });

  test("dispose tears down the connection subscription", () => {
    let subDisposed = false;
    const controller = createController({
      signals: [],
      signalDeps: { client: () => undefined, now: () => 0, searchLimit: () => 20 },
      connection: {
        current: () => ({ kind: "connected" }) as ConnectionState,
        onState: () => ({
          dispose: () => {
            subDisposed = true;
          },
        }),
      },
      post: () => undefined,
      isVisible: () => true,
      log: silentLog as never,
    });
    controller.dispose();
    expect(subDisposed).toBe(true);
  });

  test("dispose fences a still-running collection's post — nothing reaches a torn-down view", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const h = harness({
      collect: async () => {
        await gate;
        return section(1);
      },
    });
    const inFlightCollect = h.controller.collect(snap(1));
    h.controller.dispose();
    release?.();
    await inFlightCollect;
    const sections = h.posted.filter((p) => p.type === "section");
    expect(sections).toHaveLength(0);
  });

  test("a signal with no cache key is recollected every time, unlike a keyed one", async () => {
    let localCalls = 0;
    let gatewayCalls = 0;
    const localSpec: SignalSpec = {
      id: "problems",
      needsGateway: false,
      collect: async () => {
        localCalls += 1;
        return { id: "problems", title: "Problems", rows: [] };
      },
      cacheKey: () => undefined,
    };
    const gatewaySpec: SignalSpec = {
      id: "blame",
      needsGateway: true,
      collect: async () => {
        gatewayCalls += 1;
        return section(1);
      },
      cacheKey: (s) => (s.line === undefined ? undefined : `${s.path}:${s.line}`),
    };
    const controller = createController({
      signals: [localSpec, gatewaySpec],
      signalDeps: { client: () => undefined, now: () => 0, searchLimit: () => 20 },
      connection: {
        current: () => ({ kind: "connected" }) as ConnectionState,
        onState: () => ({ dispose: () => undefined }),
      },
      post: () => undefined,
      isVisible: () => true,
      log: silentLog as never,
    });
    await controller.collect(snap(1));
    await controller.collect(snap(2));
    expect(localCalls).toBe(2);
    expect(gatewayCalls).toBe(1);
  });

  test("invalidateSignal clears only that signal's cache, leaving others intact", async () => {
    let blameCalls = 0;
    let relatedCalls = 0;
    const blameSpec: SignalSpec = {
      id: "blame",
      needsGateway: true,
      collect: async () => {
        blameCalls += 1;
        return section(1);
      },
      cacheKey: (s) => (s.line === undefined ? undefined : `${s.path}:${s.line}`),
    };
    const relatedSpec: SignalSpec = {
      id: "related",
      needsGateway: true,
      collect: async () => {
        relatedCalls += 1;
        return { id: "related", title: "Related", rows: [] };
      },
      cacheKey: (s) => s.path,
    };
    const controller = createController({
      signals: [blameSpec, relatedSpec],
      signalDeps: { client: () => undefined, now: () => 0, searchLimit: () => 20 },
      connection: {
        current: () => ({ kind: "connected" }) as ConnectionState,
        onState: () => ({ dispose: () => undefined }),
      },
      post: () => undefined,
      isVisible: () => true,
      log: silentLog as never,
    });
    await controller.collect(snap(1));
    controller.invalidateSignal("blame");
    await controller.collect(snap(2));
    expect(blameCalls).toBe(2);
    expect(relatedCalls).toBe(1);
  });

  // The epoch is per signal, not one global counter. With a single counter, the
  // glue's per-repository-event invalidation of `git` also refused to cache —
  // and refused to coalesce — every in-flight `blame` and `related`, so under a
  // burst of git events the caches never filled at all.
  describe("per-signal invalidation epochs", () => {
    function twoGatewaySignals(collectBlame: () => Promise<SignalSection>) {
      let relatedCalls = 0;
      const blameSpec: SignalSpec = {
        id: "blame",
        needsGateway: true,
        collect: () => collectBlame(),
        cacheKey: (s) => (s.line === undefined ? undefined : `${s.path}:${s.line}`),
      };
      const relatedSpec: SignalSpec = {
        id: "related",
        needsGateway: true,
        collect: async () => {
          relatedCalls += 1;
          return { id: "related", title: "Related", rows: [] };
        },
        cacheKey: (s) => s.path,
      };
      const controller = createController({
        signals: [blameSpec, relatedSpec],
        signalDeps: { client: () => undefined, now: () => 0, searchLimit: () => 20 },
        connection: {
          current: () => ({ kind: "connected" }) as ConnectionState,
          onState: () => ({ dispose: () => undefined }),
        },
        post: () => undefined,
        isVisible: () => true,
        log: silentLog as never,
      });
      return { controller, relatedCalls: () => relatedCalls };
    }

    test("invalidating one signal mid-flight still lets another's answer be cached", async () => {
      let blameCalls = 0;
      let release: (() => void) | undefined;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      const h = twoGatewaySignals(async () => {
        blameCalls += 1;
        if (blameCalls === 1) await gate;
        return section(1);
      });
      const first = h.controller.collect(snap(1));
      h.controller.invalidateSignal("related");
      release?.();
      await first;
      await h.controller.collect(snap(2));
      // 1, not 2: `related`'s invalidation says nothing about `blame`, so
      // blame's in-flight answer still landed in blame's cache.
      expect(blameCalls).toBe(1);
    });

    test("invalidating one signal does not break another's in-flight coalescing", async () => {
      let blameCalls = 0;
      let release: (() => void) | undefined;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      const h = twoGatewaySignals(async () => {
        blameCalls += 1;
        await gate;
        return section(1);
      });
      const first = h.controller.collect(snap(1));
      h.controller.invalidateSignal("related");
      const second = h.controller.collect(snap(2));
      release?.();
      await Promise.all([first, second]);
      expect(blameCalls).toBe(1);
    });

    test("invalidating one signal still forces that signal to recollect", async () => {
      let blameCalls = 0;
      const h = twoGatewaySignals(async () => {
        blameCalls += 1;
        return section(1);
      });
      await h.controller.collect(snap(1));
      h.controller.invalidateSignal("blame");
      await h.controller.collect(snap(2));
      expect(blameCalls).toBe(2);
      expect(h.relatedCalls()).toBe(1);
    });
  });

  // Local signals cost nothing but a pass over data already in hand, so they
  // belong in the first render with their real rows. Marking them "Loading…"
  // repainted the signals mount twice per collection and made a screen reader
  // announce a loading row on every cursor rest.
  test("puts a local signal's real rows in the first render, never Loading…", async () => {
    const posted: Array<{ type: string; sections?: SignalSection[] }> = [];
    const localSpec: SignalSpec = {
      id: "problems",
      needsGateway: false,
      collect: async () => ({
        id: "problems",
        title: "Problems",
        rows: [{ label: "Line 3: boom" }],
      }),
      cacheKey: () => undefined,
    };
    const gatewaySpec: SignalSpec = {
      id: "blame",
      needsGateway: true,
      collect: async () => section(1),
      cacheKey: (s) => (s.line === undefined ? undefined : `${s.path}:${s.line}`),
    };
    const controller = createController({
      signals: [localSpec, gatewaySpec],
      signalDeps: { client: () => undefined, now: () => 0, searchLimit: () => 20 },
      connection: {
        current: () => ({ kind: "connected" }) as ConnectionState,
        onState: () => ({ dispose: () => undefined }),
      },
      post: (m) => posted.push(m as { type: string; sections?: SignalSection[] }),
      isVisible: () => true,
      log: silentLog as never,
    });
    await controller.collect(snap(1));
    const first = posted[0];
    expect(first?.type).toBe("render");
    const problems = first?.sections?.find((s) => s.id === "problems");
    expect(problems?.rows.map((r) => r.label)).toEqual(["Line 3: boom"]);
    expect(problems?.loading).toBeUndefined();
    // The Gateway-backed one is still the only late arrival.
    expect(first?.sections?.find((s) => s.id === "blame")?.loading).toBe(true);
    // Order is signal order, whichever resolves first.
    expect(first?.sections?.map((s) => s.id)).toEqual(["problems", "blame"]);
  });

  test("a local signal that throws renders an error row in the first render", async () => {
    const posted: Array<{ type: string; sections?: SignalSection[] }> = [];
    const controller = createController({
      signals: [
        {
          id: "problems",
          needsGateway: false,
          collect: async () => {
            throw new Error("local exploded");
          },
          cacheKey: () => undefined,
        },
      ],
      signalDeps: { client: () => undefined, now: () => 0, searchLimit: () => 20 },
      connection: {
        current: () => ({ kind: "connected" }) as ConnectionState,
        onState: () => ({ dispose: () => undefined }),
      },
      post: (m) => posted.push(m as { type: string; sections?: SignalSection[] }),
      isVisible: () => true,
      log: silentLog as never,
    });
    await controller.collect(snap(1));
    expect(posted[0]?.sections?.[0]?.rows[0]?.label).toContain("local exploded");
    expect(posted[0]?.sections?.[0]?.loading).toBeUndefined();
  });

  test("invalidateAll clears every signal's cache", async () => {
    let blameCalls = 0;
    let relatedCalls = 0;
    const blameSpec: SignalSpec = {
      id: "blame",
      needsGateway: true,
      collect: async () => {
        blameCalls += 1;
        return section(1);
      },
      cacheKey: (s) => (s.line === undefined ? undefined : `${s.path}:${s.line}`),
    };
    const relatedSpec: SignalSpec = {
      id: "related",
      needsGateway: true,
      collect: async () => {
        relatedCalls += 1;
        return { id: "related", title: "Related", rows: [] };
      },
      cacheKey: (s) => s.path,
    };
    const controller = createController({
      signals: [blameSpec, relatedSpec],
      signalDeps: { client: () => undefined, now: () => 0, searchLimit: () => 20 },
      connection: {
        current: () => ({ kind: "connected" }) as ConnectionState,
        onState: () => ({ dispose: () => undefined }),
      },
      post: () => undefined,
      isVisible: () => true,
      log: silentLog as never,
    });
    await controller.collect(snap(1));
    controller.invalidateAll();
    await controller.collect(snap(2));
    expect(blameCalls).toBe(2);
    expect(relatedCalls).toBe(2);
  });

  // The panel's cadence — debounce tiers, cache hits, git churn — was
  // otherwise unobservable from the output channel; see the two tests below.
  test("logs one debug line per collection, naming the signals it ran", async () => {
    const h = harness({ collect: async () => section(1) });
    await h.controller.collect(snap(1, 3));
    const debugs = h.log.lines.filter((l) => l.startsWith("[debug]"));
    expect(debugs).toHaveLength(1);
    expect(debugs[0]).toContain("src/a.ts:3");
  });

  test("says which signals were served from cache on a repeat collection", async () => {
    const h = harness({ collect: async () => section(1) });
    await h.controller.collect(snap(1, 3));
    h.log.lines.length = 0;
    await h.controller.collect(snap(2, 3));
    expect(h.log.lines.join("\n")).toContain("cached");
  });
});
