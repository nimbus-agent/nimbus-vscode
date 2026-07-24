import { describe, expect, test } from "vitest";

import {
  buildProofDocument,
  egressRowToItem,
  egressWindowPresets,
  formatEgressDetail,
  iconForResult,
  parseEgressRow,
} from "../../src/sidebar/egress.js";

function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 7,
    timestamp: 5_000,
    sourceType: "agent",
    sourceId: "sess-1",
    destination: "gmail",
    method: "send",
    payloadSummary: "to: a@b.c",
    hitlStatus: "approved",
    resultStatus: "authorized",
    rowHash: "hh",
    prevHash: "pp",
    ...over,
  };
}

describe("parseEgressRow", () => {
  test("coerces a full row", () => {
    const r = parseEgressRow(row());
    expect(r).toMatchObject({
      id: 7,
      destination: "gmail",
      method: "send",
      resultStatus: "authorized",
      hitlStatus: "approved",
      sourceId: "sess-1",
      rowHash: "hh",
      prevHash: "pp",
    });
  });

  test("preserves a null sourceId", () => {
    expect(parseEgressRow(row({ sourceId: null }))?.sourceId).toBeNull();
  });

  test("rejects rows missing destination, method, or a numeric timestamp", () => {
    expect(parseEgressRow(row({ destination: 1 }))).toBeUndefined();
    expect(parseEgressRow(row({ method: undefined }))).toBeUndefined();
    expect(parseEgressRow(row({ timestamp: "nope" }))).toBeUndefined();
    expect(parseEgressRow("garbage")).toBeUndefined();
    expect(parseEgressRow(null)).toBeUndefined();
  });

  test("defaults missing optional fields safely", () => {
    const r = parseEgressRow({ destination: "d", method: "m", timestamp: 1 });
    expect(r).toMatchObject({
      id: 0,
      sourceId: null,
      sourceType: "",
      payloadSummary: "",
      hitlStatus: "not_required",
      resultStatus: "blocked",
      rowHash: "",
      prevHash: "",
    });
  });
});

describe("iconForResult", () => {
  test("maps known and unknown statuses", () => {
    expect(iconForResult("authorized")).toBe("pass");
    expect(iconForResult("blocked")).toBe("error");
    expect(iconForResult("weird")).toBe("dash");
  });
});

describe("egressRowToItem", () => {
  test("builds label, description, icon, tooltip, and command", () => {
    const item = egressRowToItem(parseEgressRow(row()) as never, 65_000);
    expect(item).toMatchObject({
      label: "gmail.send",
      description: "1m ago",
      iconId: "pass",
      command: { command: "nimbus.openEgressEntry", title: "Open Egress Entry" },
    });
    expect(item.tooltip).toContain("authorized");
    expect(item.tooltip).toContain("approved");
    expect(item.command?.arguments?.[0]).toMatchObject({ id: 7 });
  });

  test("blocked rows render as first-class proof of denial", () => {
    const item = egressRowToItem(parseEgressRow(row({ resultStatus: "blocked" })) as never, 65_000);
    expect(item.iconId).toBe("error");
    expect(item.label).toBe("⛔ gmail.send");
    expect(item.description).toBe("blocked · 1m ago");
    expect(item.tooltip).toContain("proof of denial");
    expect(item.contextValue).toBe("nimbusEgressDenial");
  });

  test("authorized rows keep the plain rendering", () => {
    const item = egressRowToItem(parseEgressRow(row()) as never, 65_000);
    expect(item.label).toBe("gmail.send");
    expect(item.description).toBe("1m ago");
    expect(item.contextValue).toBeUndefined();
  });
});

describe("formatEgressDetail", () => {
  test("titles by id and includes hashes plus an ISO timestamp", () => {
    const detail = formatEgressDetail(row({ id: 42, timestamp: 0 }));
    expect(detail?.title).toBe("egress-42.json");
    const parsed = JSON.parse(detail?.content ?? "{}");
    expect(parsed).toMatchObject({
      id: 42,
      rowHash: "hh",
      prevHash: "pp",
      timestampIso: "1970-01-01T00:00:00.000Z",
    });
  });

  test("returns undefined for an unparseable row", () => {
    expect(formatEgressDetail("garbage")).toBeUndefined();
  });
});

describe("egressWindowPresets", () => {
  test("computes preset lower bounds relative to now; All time has none", () => {
    const now = 1_000_000_000;
    const presets = egressWindowPresets(now);
    expect(presets.map((p) => p.label)).toEqual([
      "Last hour",
      "Last 24 hours",
      "Last 7 days",
      "All time",
    ]);
    expect(presets[0]).toEqual({ label: "Last hour", since: now - 3_600_000 });
    expect(presets[1]?.since).toBe(now - 86_400_000);
    expect(presets[2]?.since).toBe(now - 604_800_000);
    expect(presets[3]).toEqual({ label: "All time" });
    expect("since" in (presets[3] as object)).toBe(false);
  });
});

describe("buildProofDocument", () => {
  const result = {
    rows: [
      {
        id: 1,
        timestamp: 1_700_000_000_000,
        destination: "slack",
        method: "message.post",
        resultStatus: "authorized",
        hitlStatus: "approved",
      },
    ],
    completeness: { tier: "authorized-actions", outboundEgressEvents: 1 },
    verify: { ok: true, verifiedRows: 42 },
    receipt: { sigB64: "c2ln", pubkeyB64: "cGti", digest: "abc123" },
  };

  test("emits a self-contained .html artifact with tier, receipt, and verify guidance", () => {
    const doc = buildProofDocument(result, 1_700_000_000_000);
    expect(doc.filename).toBe("egress-proof-1700000000000.html");
    expect(doc.content).toContain("authorized-actions");
    expect(doc.content).toContain("abc123");
    expect(doc.content).toContain("nimbus egress verify");
    // Self-contained: no external fetches of any kind.
    expect(doc.content).not.toMatch(/(src|href)="https?:/);
  });

  test("embeds the raw result JSON, parseable back to the input", () => {
    const doc = buildProofDocument(result, 1);
    const m = doc.content.match(
      /<script type="application\/json" id="nimbus-egress-proof">([\s\S]*?)<\/script>/,
    );
    expect(m).not.toBeNull();
    expect(JSON.parse(m?.[1] ?? "")).toEqual(result);
  });

  test("a failed whole-ledger verify is called out loudly", () => {
    const bad = { ...result, verify: { ok: false, verifiedRows: 3 } };
    const doc = buildProofDocument(bad, 1);
    expect(doc.content).toContain("FAILED");
  });

  test("no receipt and non-array rows render the empty-state fallbacks", () => {
    // rows is not an array (drops to []), and no receipt key is present.
    const doc = buildProofDocument({ completeness: { tier: "unknown" }, rows: null }, 1);
    expect(doc.content).toContain("No rows in this window.");
    expect(doc.content).toContain("No signed receipt attached");
    expect(doc.content).toContain("Rows in window (0)");
  });
});
