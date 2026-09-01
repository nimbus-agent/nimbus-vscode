import { describe, expect, test } from "vitest";

import {
  type ConnectorOutcome,
  describeOutcome,
  fromGated,
  fromOk,
  fromThrown,
  fromThrownGated,
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
  // so the cost grew with the SQUARE of the length — measured at four times
  // the cost for every doubling of the input. No correctness assertion can
  // see backtracking; only a clock can, which is why this test is wall-clock
  // bounded.
  //
  // Both ends of the budget are measured, and they are measured very
  // differently, so both are quoted rather than folded into one ratio.
  // Reverting the fix and re-running THIS test pins the upper end: it reports
  // 4.85s, i.e. ~10x the budget. (A standalone run of the same input on a
  // colder path measured 9.8s and 22.4s; the in-process 4.85s is the
  // conservative number and the one to trust.) The lower end is the passing
  // run: ~1.6ms at its slowest, cold. So the budget sits ~300x above a
  // healthy run and ~10x below the regression it exists to catch — room for
  // a loaded CI runner, without letting the regression through.
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

// --- Finding 1: consent that never arrives ---------------------------------
// Gateway 7.1.0 raises connector consent as a `consent.request` notification,
// but @nimbus-dev/client 0.17.0's subscribeHitl listens on `agent.hitlBatch`,
// which that Gateway never emits (the string is absent from its binary). So a
// HITL-gated call is never answerable from the editor: it blocks until the
// client's request timeout and surfaces as a bare IPC timeout, which reads as
// a Gateway fault rather than what it is.
describe("fromThrownGated", () => {
  test("an IPC timeout on a gated call reports consent as unreachable", () => {
    const o = fromThrownGated(new Error("IPC request timed out after 30000ms: connector.addMcp"));
    expect(o.kind).toBe("unreachable");
  });

  test("it explains where the request can still be answered", () => {
    const o = fromThrownGated(new Error("IPC request timed out after 30000ms: connector.remove"));
    const text = describeOutcome("Removing", "gmail", o);
    expect(text).toContain("approval");
    expect(text).toContain("Nimbus CLI");
    // Never claims the user decided anything: nobody was ever asked.
    expect(text).not.toContain("not approved");
  });

  test("a genuine fault on a gated call is still a failure", () => {
    const o = fromThrownGated(new Error("ENOENT: socket is gone"));
    expect(o.kind).toBe("failed");
  });

  test("a real denial on a gated call is still a denial", () => {
    const o = fromThrownGated(new Error("consent denied by the owner"));
    expect(o.kind).toBe("denied");
  });

  test("the ungated classifier is unchanged — a timeout there is a plain failure", () => {
    // Only the three gated calls may read a timeout as unreachable consent;
    // for everything else it is what it says it is.
    expect(fromThrown(new Error("IPC request timed out after 30000ms: connector.sync")).kind).toBe(
      "failed",
    );
  });
});
