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
    expect(fromOk({ ok: true }, "sync started")).toEqual({ kind: "applied", detail: "sync started" });
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
      fromGated({ ok: true, itemsDeleted: 1204, vaultKeysRemoved: ["github/pat"] }, (r) =>
        `${r.itemsDeleted} items deleted`,
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
    expect(describeOutcome("Removing", "github", { kind: "applied", detail: "1204 items deleted" })).toBe(
      "Removing github: done — 1204 items deleted",
    );
  });

  test("an applied outcome with no detail still reads cleanly", () => {
    expect(describeOutcome("Pausing", "github", { kind: "applied" })).toBe("Pausing github: done");
  });

  test("a failure says so", () => {
    expect(describeOutcome("Syncing", "github", { kind: "failed", message: "socket hang up" })).toBe(
      "Syncing github failed: socket hang up",
    );
  });
});
