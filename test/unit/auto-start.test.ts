import { EventEmitter } from "node:events";
import { describe, expect, test, vi } from "vitest";

import { type AutoStartDeps, createAutoStarter } from "../../src/connection/auto-start.js";

class FakeChild extends EventEmitter {
  killed = false;
  unref = vi.fn();
  kill = vi.fn(() => {
    this.killed = true;
  });
}

function makeDeps(opts: { spawnFails?: boolean; socketAppearsAfterMs?: number }): AutoStartDeps {
  let socketReady = false;
  setTimeout(() => {
    socketReady = true;
  }, opts.socketAppearsAfterMs ?? 5);
  return {
    spawn: vi.fn(() => {
      if (opts.spawnFails === true) {
        const child = new FakeChild();
        setTimeout(() => child.emit("error", new Error("ENOENT")), 1);
        return child as unknown as never;
      }
      return new FakeChild() as unknown as never;
    }),
    pingSocket: vi.fn(async () => socketReady),
    log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
    timeoutMs: 200,
    pollIntervalMs: 5,
  };
}

describe("AutoStarter.spawn", () => {
  test("returns success when socket appears within timeout", async () => {
    const deps = makeDeps({ socketAppearsAfterMs: 20 });
    const starter = createAutoStarter(deps);
    const r = await starter.spawn("/run/nimbus-test/x.sock");
    expect(r.kind).toBe("ok");
  });

  test("returns timeout when socket never appears", async () => {
    const deps = makeDeps({ socketAppearsAfterMs: 99999 });
    const starter = createAutoStarter(deps);
    const r = await starter.spawn("/run/nimbus-test/x.sock");
    expect(r.kind).toBe("timeout");
  });

  test("returns spawn-error when binary not found", async () => {
    const deps = makeDeps({ spawnFails: true });
    const starter = createAutoStarter(deps);
    const r = await starter.spawn("/run/nimbus-test/x.sock");
    expect(r.kind).toBe("spawn-error");
  });

  test("returns spawn-error with the thrown message when spawn() itself throws synchronously", async () => {
    // Distinct from spawnFails above: that simulates an async "error" event on
    // the child process; this simulates node's child_process.spawn throwing
    // synchronously (e.g. EACCES on the command itself, or a mocked-out spawn
    // in an unusual host environment).
    const deps = makeDeps({});
    const throwingDeps: AutoStartDeps = {
      ...deps,
      spawn: vi.fn(() => {
        throw new Error("EACCES: permission denied");
      }),
    };
    const starter = createAutoStarter(throwingDeps);
    const r = await starter.spawn("/run/nimbus-test/x.sock");
    expect(r).toEqual({ kind: "spawn-error", message: "EACCES: permission denied" });
  });
});
