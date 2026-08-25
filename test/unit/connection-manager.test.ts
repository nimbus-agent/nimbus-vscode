import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  type ConnectionDeps,
  type ConnectionState,
  createConnectionManager,
  isTransportDead,
} from "../../src/connection/connection-manager.js";

class FakeClient {
  closed = false;
  async close(): Promise<void> {
    this.closed = true;
  }
}

function makeDeps(opts: { openSequence: Array<"ok" | "eacces" | "enoent"> }): {
  deps: ConnectionDeps;
  events: ConnectionState[];
  openCalls: number;
} {
  const events: ConnectionState[] = [];
  let openCallIndex = 0;
  const deps: ConnectionDeps = {
    open: async () => {
      const outcome = opts.openSequence[openCallIndex] ?? "ok";
      openCallIndex += 1;
      if (outcome === "eacces") {
        const err = new Error("permission denied") as NodeJS.ErrnoException;
        err.code = "EACCES";
        throw err;
      }
      if (outcome === "enoent") {
        const err = new Error("no such file") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      return new FakeClient();
    },
    discoverSocket: async () => ({
      socketPath: "/run/nimbus-test/test.sock",
      source: "default" as const,
    }),
    log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
    reconnectDelayMs: 5,
  };
  const mgr = createConnectionManager(deps);
  mgr.onState((s) => events.push(s));
  return { deps, events, openCalls: 0 };
}

describe("ConnectionManager", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("transitions connecting → connected on success", async () => {
    const { deps } = makeDeps({ openSequence: ["ok"] });
    const mgr = createConnectionManager(deps);
    const collected: ConnectionState[] = [];
    mgr.onState((s) => collected.push(s));
    await mgr.start();
    expect(collected.map((s) => s.kind)).toContain("connected");
    await mgr.dispose();
  });

  test("transitions to permission-denied on EACCES", async () => {
    const deps: ConnectionDeps = {
      open: async () => {
        const err = new Error("permission denied") as NodeJS.ErrnoException;
        err.code = "EACCES";
        throw err;
      },
      discoverSocket: async () => ({
        socketPath: "/run/nimbus-test/x.sock",
        source: "default" as const,
      }),
      log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
      reconnectDelayMs: 1000,
    };
    const mgr = createConnectionManager(deps);
    const states: ConnectionState[] = [];
    mgr.onState((s) => states.push(s));
    await mgr.start();
    const last = states.at(-1);
    expect(last?.kind).toBe("permission-denied");
    if (last?.kind === "permission-denied") {
      expect(last.socketPath).toBe("/run/nimbus-test/x.sock");
    }
    await mgr.dispose();
  });

  test("retries on ENOENT until success", async () => {
    const deps: ConnectionDeps = (() => {
      let i = 0;
      return {
        open: async () => {
          i += 1;
          if (i < 3) {
            const err = new Error("nope") as NodeJS.ErrnoException;
            err.code = "ENOENT";
            throw err;
          }
          return new FakeClient();
        },
        discoverSocket: async () => ({
          socketPath: "/run/nimbus-test/y.sock",
          source: "default" as const,
        }),
        log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
        reconnectDelayMs: 1,
      };
    })();
    const mgr = createConnectionManager(deps);
    const states: ConnectionState[] = [];
    mgr.onState((s) => states.push(s));
    await mgr.start();
    await new Promise((r) => setTimeout(r, 50));
    const kinds = states.map((s) => s.kind);
    expect(kinds).toContain("connected");
    await mgr.dispose();
  });
});

// A Gateway restart kills the pipe under a live client. Nothing in the manager
// noticed: the state only left "connected" when a CONNECT attempt failed, so a
// dead transport left it reporting "connected" forever, and reconnectNow()
// early-returned on that stale state. The extension was stuck until the window
// was reloaded. See issue #82.
describe("recovering from a Gateway restart", () => {
  // makeDeps binds its `events` array to a throwaway manager it never returns,
  // so these tests subscribe to their own instance.
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe("isTransportDead", () => {
    test("recognises a dead pipe", () => {
      expect(isTransportDead(new Error("IPC client is not connected"))).toBe(true);
      expect(isTransportDead(new Error("read ECONNRESET"))).toBe(true);
      expect(isTransportDead(new Error("write EPIPE"))).toBe(true);
      expect(isTransportDead(new Error("socket closed"))).toBe(true);
      expect(isTransportDead(new Error("socket hang up"))).toBe(true);
    });

    // The Gateway answering with an error means the transport is FINE. Tearing
    // the connection down on an ordinary RPC failure would reconnect-loop on
    // every bad request.
    test("leaves ordinary RPC failures alone", () => {
      expect(isTransportDead(new Error("no such workflow"))).toBe(false);
      expect(isTransportDead(new Error("Invalid params"))).toBe(false);
      expect(isTransportDead(new Error("agents.why: no resolvable subject"))).toBe(false);
      expect(isTransportDead(undefined)).toBe(false);
    });
  });

  test("noteTransportFailure moves a live connection to disconnected", async () => {
    const { deps } = makeDeps({ openSequence: ["ok"] });
    const mgr = createConnectionManager(deps);
    const seen: ConnectionState[] = [];
    mgr.onState((s) => seen.push(s));
    await mgr.start();
    expect(mgr.current().kind).toBe("connected");

    mgr.noteTransportFailure(new Error("IPC client is not connected"));

    expect(mgr.current().kind).toBe("disconnected");
    // Listeners must hear it — the status bar and every sidebar view render
    // from this event, so a silent transition would leave them claiming a live
    // connection.
    expect(seen.at(-1)).toMatchObject({ kind: "disconnected" });
  });

  test("noteTransportFailure ignores an ordinary RPC error", async () => {
    const { deps } = makeDeps({ openSequence: ["ok"] });
    const mgr = createConnectionManager(deps);
    await mgr.start();

    mgr.noteTransportFailure(new Error("no such workflow"));

    expect(mgr.current().kind).toBe("connected");
  });

  test("a dead transport self-heals via the existing backoff", async () => {
    const { deps, openCalls } = makeDeps({ openSequence: ["ok", "ok"] });
    const mgr = createConnectionManager(deps);
    await mgr.start();
    mgr.noteTransportFailure(new Error("IPC client is not connected"));
    expect(mgr.current().kind).toBe("disconnected");

    await vi.advanceTimersByTimeAsync(10);

    expect(mgr.current().kind).toBe("connected");
    void openCalls;
  });

  // The manual escape hatch must work even if the auto-detection never fires —
  // e.g. the status-bar badge is off and no poll has run yet.
  test("reconnectNow reconnects even while the state still says connected", async () => {
    const opened: FakeClient[] = [];
    const { deps } = makeDeps({ openSequence: ["ok", "ok"] });
    const wrapped: ConnectionDeps = {
      ...deps,
      open: async (p) => {
        const c = (await deps.open(p)) as FakeClient;
        opened.push(c);
        return c;
      },
    };
    const mgr = createConnectionManager(wrapped);
    await mgr.start();
    const stale = mgr.client();
    expect(mgr.current().kind).toBe("connected");

    await mgr.reconnectNow();

    expect(mgr.current().kind).toBe("connected");
    expect(mgr.client()).not.toBe(stale);
    // The superseded client is closed rather than leaked.
    expect((stale as FakeClient).closed).toBe(true);
  });
});
// Guards on the edges of the reconnect machinery: a manager that keeps
// reconnecting after dispose reopens a socket the extension has already let go
// of, and one that resets its backoff on every failing poll turns a dead
// Gateway into a reconnect storm.
describe("reconnect edges", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("reconnectNow after dispose opens nothing", async () => {
    let opens = 0;
    const { deps } = makeDeps({ openSequence: ["ok", "ok"] });
    const mgr = createConnectionManager({
      ...deps,
      open: async (p) => {
        opens += 1;
        return await deps.open(p);
      },
    });
    await mgr.start();
    expect(opens).toBe(1);
    await mgr.dispose();

    await mgr.reconnectNow();

    expect(opens).toBe(1);
    expect(mgr.client()).toBeUndefined();
  });

  // A second failure report while already disconnected must not re-enter the
  // backoff: a poll that keeps firing would otherwise reset the timer forever
  // and the reconnect would never come due.
  test("a second transport failure while disconnected changes nothing", async () => {
    const { deps } = makeDeps({ openSequence: ["ok", "enoent", "ok"] });
    const mgr = createConnectionManager(deps);
    const seen: ConnectionState[] = [];
    mgr.onState((s) => seen.push(s));
    await mgr.start();
    mgr.noteTransportFailure(new Error("socket hang up"));
    expect(mgr.current().kind).toBe("disconnected");
    const before = seen.length;

    mgr.noteTransportFailure(new Error("socket hang up"));

    expect(seen).toHaveLength(before);
    expect(mgr.current().kind).toBe("disconnected");
    await mgr.dispose();
  });

  // 3s, and it is the manager's own default rather than the caller's: every
  // production wiring omits reconnectDelayMs, so an accidental 0 here would busy-
  // loop the extension host against a Gateway that is down.
  test("without an injected delay it waits the default 3s before retrying", async () => {
    const { deps } = makeDeps({ openSequence: ["enoent", "ok"] });
    const { reconnectDelayMs: _omitted, ...withoutDelay } = deps;
    const mgr = createConnectionManager(withoutDelay);
    await mgr.start();
    expect(mgr.current().kind).toBe("disconnected");

    await vi.advanceTimersByTimeAsync(2_900);
    expect(mgr.current().kind).toBe("disconnected");

    await vi.advanceTimersByTimeAsync(200);
    expect(mgr.current().kind).toBe("connected");
    await mgr.dispose();
  });

  test("disposing the same subscription twice does not drop another listener", async () => {
    const { deps } = makeDeps({ openSequence: ["ok"] });
    const mgr = createConnectionManager(deps);
    const first: ConnectionState[] = [];
    const second: ConnectionState[] = [];
    const sub = mgr.onState((s) => first.push(s));
    mgr.onState((s) => second.push(s));
    sub.dispose();
    sub.dispose();

    await mgr.start();

    expect(first).toHaveLength(1); // the immediate replay at subscribe time only
    expect(second.map((s) => s.kind)).toContain("connected");
    await mgr.dispose();
  });
});
describe("dispose while a connect is still in flight", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // deactivate() is not synchronised with an open() that has not answered yet.
  // If that open then fails, the failure path must NOT arm the backoff: a timer
  // left running past deactivate reopens a socket the extension has let go of,
  // and nothing is left to close it.
  test("a connect that fails after dispose arms no reconnect timer", async () => {
    let opens = 0;
    let rejectOpen: (e: unknown) => void = () => undefined;
    const mgr = createConnectionManager({
      open: async () => {
        opens += 1;
        return await new Promise<never>((_resolve, reject) => {
          rejectOpen = reject;
        });
      },
      discoverSocket: async () => ({ socketPath: "/run/nimbus-test/test.sock", source: "default" }),
      log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
      reconnectDelayMs: 5,
    });
    const started = mgr.start();
    // start() awaits discoverSocket before it opens anything, so let the
    // microtask queue drain before asserting the attempt is in flight.
    await vi.advanceTimersByTimeAsync(0);
    expect(opens).toBe(1);

    await mgr.dispose();
    const enoent = new Error("no such file") as NodeJS.ErrnoException;
    enoent.code = "ENOENT";
    rejectOpen(enoent);
    await started;

    // Asserted on the TIMER, not only on the open count: tryConnect refuses to
    // run while stopped as well, so counting opens alone would still pass with a
    // timer left armed — and a pending timer past deactivate is the leak.
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(50);
    expect(opens).toBe(1);
  });
});
