import { describe, expect, test } from "vitest";

import { allowedCommandIds, validateInbound } from "../../src/context/protocol.js";

describe("allowedCommandIds", () => {
  test("covers every brief command the panel can offer", () => {
    expect(allowedCommandIds().has("nimbus.brief.why")).toBe(true);
    expect(allowedCommandIds().has("nimbus.brief.preflight")).toBe(true);
  });

  test("does not admit a command the panel never offers", () => {
    expect(allowedCommandIds().has("workbench.action.terminal.sendSequence")).toBe(false);
  });
});

describe("validateInbound", () => {
  test("accepts the ready handshake", () => {
    expect(validateInbound({ type: "ready" })).toEqual({ kind: "ready" });
  });

  test("accepts an allowlisted command with no arguments", () => {
    expect(validateInbound({ type: "run", command: "nimbus.brief.huddle" })).toEqual({
      kind: "run",
      command: "nimbus.brief.huddle",
      args: [],
    });
  });

  test("accepts an allowlisted command with a well-formed editor target", () => {
    const msg = { type: "run", command: "nimbus.brief.why", args: [{ ref: "src/a.ts", line: 4 }] };
    expect(validateInbound(msg)).toEqual({
      kind: "run",
      command: "nimbus.brief.why",
      args: [{ ref: "src/a.ts", line: 4 }],
    });
  });

  test("rejects a command outside the allowlist", () => {
    const result = validateInbound({ type: "run", command: "workbench.action.reloadWindow" });
    expect(result.kind).toBe("rejected");
  });

  test("rejects an allowlisted command whose argument is malformed", () => {
    const result = validateInbound({
      type: "run",
      command: "nimbus.brief.why",
      args: [{ ref: "src/a.ts", line: "four" }],
    });
    expect(result.kind).toBe("rejected");
  });

  test("rejects more arguments than the command takes", () => {
    const result = validateInbound({
      type: "run",
      command: "nimbus.brief.why",
      args: [
        { ref: "a", line: 1 },
        { ref: "b", line: 2 },
      ],
    });
    expect(result.kind).toBe("rejected");
  });

  test("rejects anything that is not a known message shape", () => {
    expect(validateInbound(null).kind).toBe("rejected");
    expect(validateInbound("run").kind).toBe("rejected");
    expect(validateInbound({ type: "explode" }).kind).toBe("rejected");
  });
});
