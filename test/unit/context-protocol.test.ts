import { describe, expect, test } from "vitest";

import { BRIEF_CATALOG, needsEditor } from "../../src/briefs/catalog.js";
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

  test("rejects args that are not an array at all", () => {
    const result = validateInbound({ type: "run", command: "nimbus.brief.why", args: "boom" });
    expect(result.kind).toBe("rejected");
    expect(result.kind === "rejected" && result.reason).toBe("args is not an array");
  });

  test("rejects an argument handed to a command that takes none", () => {
    const result = validateInbound({
      type: "run",
      command: "nimbus.brief.huddle",
      args: [{ ref: "src/a.ts", line: 4 }],
    });
    expect(result.kind).toBe("rejected");
  });

  test("rejects anything that is not a known message shape", () => {
    expect(validateInbound(null).kind).toBe("rejected");
    expect(validateInbound("run").kind).toBe("rejected");
    expect(validateInbound({ type: "explode" }).kind).toBe("rejected");
  });
});

// The set of commands that may carry an EditorTarget is derived from the catalog
// through needsEditor rather than hand-written, so the panel can never render a
// pre-filled button whose message this validator then refuses. A seventh brief
// with `context: "file"` used to be exactly that trap; this pins it shut.
describe("which commands may carry an editor target", () => {
  const target = { ref: "src/a.ts", line: 4 };

  test("accepts one exactly for the catalog commands needsEditor names", () => {
    const accepts = BRIEF_CATALOG.filter(
      (spec) =>
        validateInbound({ type: "run", command: spec.command, args: [target] }).kind === "run",
    ).map((spec) => spec.command);
    expect(accepts).toEqual(
      BRIEF_CATALOG.filter((spec) => needsEditor(spec)).map((s) => s.command),
    );
  });

  test("that set is neither empty nor the whole catalog, so the test can fail", () => {
    const editorBacked = BRIEF_CATALOG.filter((spec) => needsEditor(spec));
    expect(editorBacked.length).toBeGreaterThan(0);
    expect(editorBacked.length).toBeLessThan(BRIEF_CATALOG.length);
  });
});
