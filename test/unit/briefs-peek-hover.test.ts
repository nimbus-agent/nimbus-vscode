import type { WhyPeek } from "@nimbus-dev/client";
import { describe, expect, test } from "vitest";

import {
  createPeekHover,
  HOVER_SETTLE_MS,
  type PeekHoverDeps,
} from "../../src/briefs/peek-hover.js";
import type { Logger } from "../../src/logging.js";

const silentLog: Logger = {
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
  debug: () => undefined,
} as unknown as Logger;

const TARGET = { ref: "src/a.ts", line: 3 };

function fullPeek(over: Partial<WhyPeek> = {}): WhyPeek {
  return {
    subject: { repoRoot: "/r", filePath: "src/a.ts", lineNo: 4 },
    author: "Robin Hale",
    authorEmail: null,
    commitSha: "abcdef1234",
    committedAt: 0,
    commitSubject: "fix: thing",
    pr: null,
    ticket: null,
    hasMore: false,
    ...over,
  };
}

interface Harness {
  deps: PeekHoverDeps;
  calls: Array<{ ref: string; line: number }>;
  settles: number[];
}

function harness(over: Partial<PeekHoverDeps> = {}): Harness {
  const calls: Array<{ ref: string; line: number }> = [];
  const settles: number[] = [];
  const deps: PeekHoverDeps = {
    peek: async (p) => {
      calls.push(p);
      return fullPeek();
    },
    enabled: () => true,
    settle: async (ms) => {
      settles.push(ms);
    },
    now: () => 0,
    log: silentLog,
    ...over,
  };
  return { deps, calls, settles };
}

const live = (): { isCancellationRequested: boolean } => ({ isCancellationRequested: false });

describe("createPeekHover", () => {
  test("returns undefined and never calls the Gateway when disabled", async () => {
    const h = harness({ enabled: () => false });
    const hover = createPeekHover(h.deps);
    expect(await hover.provide({ target: TARGET, docKey: "d1", token: live() })).toBeUndefined();
    expect(h.calls).toEqual([]);
  });

  test("settles before calling, so a sweeping cursor costs nothing", async () => {
    const h = harness();
    const hover = createPeekHover(h.deps);
    await hover.provide({ target: TARGET, docKey: "d1", token: live() });
    expect(h.settles).toEqual([HOVER_SETTLE_MS]);
  });

  test("renders markdown carrying the Why link on a hit", async () => {
    const h = harness();
    const hover = createPeekHover(h.deps);
    const out = await hover.provide({ target: TARGET, docKey: "d1", token: live() });
    expect(out).toContain("**Robin Hale**");
    expect(out).toContain("command:nimbus.brief.why?");
  });

  test("a token cancelled during the settle skips the call entirely", async () => {
    const token = { isCancellationRequested: false };
    const h = harness({
      settle: async () => {
        token.isCancellationRequested = true;
      },
    });
    const hover = createPeekHover(h.deps);
    expect(await hover.provide({ target: TARGET, docKey: "d1", token })).toBeUndefined();
    expect(h.calls).toEqual([]);
  });

  // The RPC takes no abort argument, so a token cancelled mid-flight cannot
  // stop the round trip — it can only stop the stale reply being rendered.
  test("a token cancelled mid-flight discards the reply", async () => {
    const token = { isCancellationRequested: false };
    const h = harness({
      peek: async () => {
        token.isCancellationRequested = true;
        return fullPeek();
      },
    });
    const hover = createPeekHover(h.deps);
    expect(await hover.provide({ target: TARGET, docKey: "d1", token })).toBeUndefined();
  });

  // The in-flight case: the older call has already reached the Gateway when a
  // newer hover arrives. Its reply comes back stale and must be dropped.
  test("a reply that arrives after a newer hover is discarded", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((res) => {
      release = res;
    });
    let entered: (() => void) | undefined;
    const firstEntered = new Promise<void>((res) => {
      entered = res;
    });
    let first = true;
    const h = harness({
      peek: async () => {
        if (first) {
          first = false;
          entered?.();
          await gate;
          return fullPeek({ author: "STALE" });
        }
        return fullPeek({ author: "FRESH" });
      },
    });
    const hover = createPeekHover(h.deps);
    const older = hover.provide({ target: TARGET, docKey: "d1", token: live() });
    await firstEntered; // the older call is now waiting on the Gateway
    const newer = hover.provide({
      target: { ref: "src/a.ts", line: 9 },
      docKey: "d1",
      token: live(),
    });
    expect(await newer).toContain("FRESH");
    release?.();
    expect(await older).toBeUndefined();
  });

  // The cheaper case, and the one that actually saves traffic: a hover
  // superseded during the settle never reaches the Gateway at all. This is what
  // makes a cursor swept down a file cost one request rather than dozens.
  test("a hover superseded during the settle never calls the Gateway", async () => {
    const h = harness();
    const hover = createPeekHover(h.deps);
    const older = hover.provide({ target: TARGET, docKey: "d1", token: live() });
    const newer = hover.provide({
      target: { ref: "src/a.ts", line: 9 },
      docKey: "d1",
      token: live(),
    });
    expect(await older).toBeUndefined();
    expect(await newer).toBeDefined();
    expect(h.calls).toEqual([{ ref: "src/a.ts", line: 9 }]);
  });

  test("hovers on different documents do not supersede each other", async () => {
    const h = harness();
    const hover = createPeekHover(h.deps);
    const a = await hover.provide({ target: TARGET, docKey: "d1", token: live() });
    const b = await hover.provide({ target: TARGET, docKey: "d2", token: live() });
    expect(a).toBeDefined();
    expect(b).toBeDefined();
  });

  test("declines when the Gateway resolved nothing", async () => {
    const h = harness({
      peek: async () =>
        fullPeek({ subject: null, author: null, commitSha: null, commitSubject: null }),
    });
    const hover = createPeekHover(h.deps);
    expect(await hover.provide({ target: TARGET, docKey: "d1", token: live() })).toBeUndefined();
  });

  // A hover that throws a visible error on every mouse-rest would be unusable,
  // and this surface is ambient rather than requested.
  test("a failing call is logged and declined, never surfaced", async () => {
    const logged: string[] = [];
    const h = harness({
      peek: async () => {
        throw new Error("IPC client is not connected");
      },
      log: { ...silentLog, debug: (m: string) => logged.push(m) } as unknown as Logger,
    });
    const hover = createPeekHover(h.deps);
    expect(await hover.provide({ target: TARGET, docKey: "d1", token: live() })).toBeUndefined();
    expect(logged.join(" ")).toContain("IPC client is not connected");
  });
});
