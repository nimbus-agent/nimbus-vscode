import { describe, expect, test } from "vitest";

import {
  type ConnectorOutcome,
  describeOutcome,
  fromGated,
  fromOk,
  fromThrown,
} from "../../src/connectors/outcome.js";

describe("the four wire shapes", () => {
  test("ok:true is applied", () => {
    expect(fromOk({ ok: true }, "sync started")).toEqual({
      kind: "applied",
      detail: "sync started",
    });
  });

  test("ok:false is a failure, not a denial", () => {
    expect(fromOk({ ok: false })).toEqual({
      kind: "failed",
      message: "The Gateway did not apply the change.",
    });
  });

  test("a resolved GatedRejection is denied, carrying the Gateway's reason verbatim", () => {
    expect(fromGated({ status: "rejected", reason: "consent request expired" }, () => "")).toEqual({
      kind: "denied",
      reason: "consent request expired",
    });
  });

  test("a resolved approval is applied", () => {
    expect(
      fromGated(
        { ok: true, itemsDeleted: 1204, vaultKeysRemoved: ["github/pat"] },
        (r) => `${r.itemsDeleted} items deleted`,
      ),
    ).toEqual({ kind: "applied", detail: "1204 items deleted" });
  });

  test("a thrown denial is denied — reindex rejects where the others resolve", () => {
    expect(fromThrown(new Error("HITL denied: owner rejected the request"))).toEqual({
      kind: "denied",
      reason: "HITL denied: owner rejected the request",
    });
  });

  test("a thrown transport error is a failure", () => {
    expect(fromThrown(new Error("socket hang up"))).toEqual({
      kind: "failed",
      message: "socket hang up",
    });
  });

  test("a non-Error rejection still yields a message", () => {
    expect(fromThrown("boom")).toEqual({ kind: "failed", message: "boom" });
  });

  test("a generic permission error is a failure, not a denial", () => {
    expect(fromThrown(new Error("EACCES: permission denied"))).toEqual({
      kind: "failed",
      message: "EACCES: permission denied",
    });
  });

  test("a proxy rejection without consent context is a failure", () => {
    expect(fromThrown(new Error("upstream request rejected by proxy"))).toEqual({
      kind: "failed",
      message: "upstream request rejected by proxy",
    });
  });

  test("a consent expiry is denied even without other context", () => {
    expect(fromThrown(new Error("consent request expired"))).toEqual({
      kind: "denied",
      reason: "consent request expired",
    });
  });

  test("an explicit 'not approved' phrase is denied", () => {
    expect(fromThrown(new Error("the change was not approved"))).toEqual({
      kind: "denied",
      reason: "the change was not approved",
    });
  });
});

describe("describeOutcome", () => {
  test("a denial reads as a decision, never as a breakage", () => {
    const denied: ConnectorOutcome = { kind: "denied", reason: "consent request expired" };
    const text = describeOutcome("Removing", "github", denied);
    expect(text).toBe("Removing github was not approved: consent request expired");
    expect(text.toLowerCase()).not.toContain("failed");
    expect(text.toLowerCase()).not.toContain("error");
  });

  test("an applied outcome names what changed", () => {
    expect(
      describeOutcome("Removing", "github", { kind: "applied", detail: "1204 items deleted" }),
    ).toBe("Removing github: done — 1204 items deleted");
  });

  test("an applied outcome with no detail still reads cleanly", () => {
    expect(describeOutcome("Pausing", "github", { kind: "applied" })).toBe("Pausing github: done");
  });

  test("a failure says so", () => {
    expect(
      describeOutcome("Syncing", "github", { kind: "failed", message: "socket hang up" }),
    ).toBe("Syncing github failed: socket hang up");
  });
});

describe("denial detection stays linear in the message length", () => {
  // The pattern this replaced paired two `(?=.*\b…\b)` lookaheads. `test`
  // retries every start offset and each retry re-scanned the rest of the line,
  // so the cost grew with the SQUARE of the length: measured against that
  // pattern, this exact input took 9.8s, and four times that for every
  // doubling. No correctness assertion can see backtracking — only a clock
  // can, which is why this test is wall-clock bounded. The budget sits far
  // from both ends: ~300x the slowest observed linear run (1.6ms, cold) and
  // ~1/20th of the quadratic one, so a loaded CI runner has room and the
  // regression it exists to catch still cannot slip through.
  test("a ~120 KB non-matching message is classified well inside a wall-clock budget", () => {
    const message = `denied ${"a ".repeat(60_000)}`;
    const started = performance.now();
    const outcome = fromThrown(new Error(message));
    const elapsed = performance.now() - started;
    expect(outcome.kind).toBe("failed");
    expect(elapsed).toBeLessThan(500);
  });

  // The lookaheads could never span a line terminator, because `.` does not
  // match one. Splitting the check into separate patterns must not quietly
  // widen it into a whole-message search.
  test("a denial word and a consent word on DIFFERENT lines is not a denial", () => {
    const message = "upstream rejected\nawaiting owner approval elsewhere";
    expect(fromThrown(new Error(message))).toEqual({ kind: "failed", message });
  });

  test("both halves on ONE line of a multi-line message is still a denial", () => {
    const message = "request failed\nHITL: owner denied the request\n  at connectorReindex";
    expect(fromThrown(new Error(message))).toEqual({ kind: "denied", reason: message });
  });
});
