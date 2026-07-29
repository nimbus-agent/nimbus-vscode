import { describe, expect, it } from "vitest";
import {
  annotationsFor,
  BROKEN_HEADING,
  classifyExpiry,
  classifyProbe,
  DECLARED_EXPIRY,
  EXPIRY_CRITICAL_DAYS,
  EXPIRY_LEAD_DAYS,
  evaluate,
  HEALTHY_HEADING,
  hasHardFailure,
  hasWarning,
  remedyFor,
  renderBody,
  SCHEDULED_HEADING,
  severityOf,
  type Verdict,
  verdictFor,
} from "../../scripts/secret-health";

const NOW = new Date("2026-07-29T00:00:00Z");

/** ISO date exactly `days` after NOW, at midnight UTC. */
function expiryDaysOut(days: number): string {
  return new Date(NOW.getTime() + days * 86_400_000).toISOString().slice(0, 10);
}

describe("classifyProbe", () => {
  it("maps the probe action's documented outputs", () => {
    expect(classifyProbe("ok")).toBe("ok");
    expect(classifyProbe("dead")).toBe("dead");
    expect(classifyProbe("not-configured")).toBe("not-configured");
    expect(classifyProbe("indeterminate")).toBe("unreachable");
  });

  it("fails closed: an unset or unrecognised output is never healthy and never a mere blip", () => {
    // A renamed step id, an `id:` typo, or an action-ref bump landing an
    // incompatible version all interpolate to something unexpected with no
    // workflow error of their own.
    expect(classifyProbe("")).toBe("unrecognised");
    expect(classifyProbe("OK")).toBe("unrecognised");
    expect(classifyProbe("healthy")).toBe("unrecognised");
    expect(severityOf(classifyProbe(""))).toBe("hard");
  });
});

describe("classifyExpiry boundaries", () => {
  it("far from the deadline is silent", () => {
    expect(classifyExpiry(expiryDaysOut(EXPIRY_LEAD_DAYS + 1), NOW)).toBe("ok");
    expect(classifyExpiry(expiryDaysOut(365), NOW)).toBe("ok");
  });

  it("entering the lead window warns, and stays a warning right up to the critical seam", () => {
    expect(classifyExpiry(expiryDaysOut(EXPIRY_LEAD_DAYS), NOW)).toBe("expiry-approaching");
    expect(classifyExpiry(expiryDaysOut(EXPIRY_LEAD_DAYS - 1), NOW)).toBe("expiry-approaching");
    expect(classifyExpiry(expiryDaysOut(EXPIRY_CRITICAL_DAYS + 1), NOW)).toBe("expiry-approaching");
  });

  it("escalates exactly at the critical window and stays escalated inside it", () => {
    expect(classifyExpiry(expiryDaysOut(EXPIRY_CRITICAL_DAYS), NOW)).toBe("expiry-critical");
    expect(classifyExpiry(expiryDaysOut(EXPIRY_CRITICAL_DAYS - 1), NOW)).toBe("expiry-critical");
    expect(classifyExpiry(expiryDaysOut(0), NOW)).toBe("expiry-critical");
  });

  it("past the deadline is overdue, a distinct verdict from the approaching one", () => {
    expect(classifyExpiry(expiryDaysOut(-1), NOW)).toBe("expiry-overdue");
    expect(classifyExpiry(expiryDaysOut(-400), NOW)).toBe("expiry-overdue");
  });

  it("a credential with no recorded expiry is never dated", () => {
    expect(classifyExpiry(undefined, NOW)).toBe("ok");
  });
});

describe("severityOf", () => {
  it("warns only for the two states where nothing is broken", () => {
    expect(severityOf("expiry-approaching")).toBe("warn");
    expect(severityOf("unreachable")).toBe("warn");
  });

  it("fails for every rejected, absent, unknown, or out-of-runway state", () => {
    for (const v of [
      "dead",
      "not-configured",
      "unrecognised",
      "expiry-critical",
      "expiry-overdue",
    ] as const) {
      expect(severityOf(v)).toBe("hard");
    }
  });

  it("ok is the only healthy verdict", () => {
    expect(severityOf("ok")).toBe("healthy");
  });
});

describe("verdictFor — dead is never downgraded", () => {
  it("a rejected token stays dead however comfortable its recorded expiry is", () => {
    // The regression this guards: softening the dated half of the report (so the
    // weekly job stops being red on a scheduled expiry) must never soften the
    // liveness half. A token the marketplace refuses is broken TODAY.
    expect(verdictFor("dead", expiryDaysOut(365), NOW)).toBe("dead");
    expect(verdictFor("dead", expiryDaysOut(EXPIRY_LEAD_DAYS), NOW)).toBe("dead");
    expect(verdictFor("dead", undefined, NOW)).toBe("dead");
    expect(severityOf(verdictFor("dead", expiryDaysOut(365), NOW))).toBe("hard");
  });

  it("an absent or unrecognised probe likewise ignores the calendar", () => {
    expect(verdictFor("not-configured", expiryDaysOut(365), NOW)).toBe("not-configured");
    expect(verdictFor("nonsense", expiryDaysOut(365), NOW)).toBe("unrecognised");
  });

  it("a live token inside the lead window is dated, not dead", () => {
    const verdict = verdictFor("ok", expiryDaysOut(53), NOW);
    expect(verdict).toBe("expiry-approaching");
    expect(severityOf(verdict)).toBe("warn");
  });

  it("a live token whose recorded expiry has passed reports the RECORD as wrong, not the token as dead", () => {
    // Reporting "expired" for a token that demonstrably works would be a lie,
    // and this monitor's credibility is the only thing that makes anyone act on
    // it. The token outlived the date: fix the date.
    const verdict = verdictFor("ok", expiryDaysOut(-3), NOW);
    expect(verdict).toBe("expiry-overdue");
    expect(verdict).not.toBe("dead");
    expect(remedyFor(verdict, "VSCE_PAT", expiryDaysOut(-3), NOW)).toContain("still authenticates");
    expect(remedyFor(verdict, "VSCE_PAT", expiryDaysOut(-3), NOW)).toContain("Do not rotate");
  });

  it("an unreachable probe outranks a merely-approaching date — we could not check", () => {
    expect(verdictFor("indeterminate", expiryDaysOut(60), NOW)).toBe("unreachable");
  });

  it("but a critical date outranks an unreachable probe", () => {
    expect(verdictFor("indeterminate", expiryDaysOut(3), NOW)).toBe("expiry-critical");
  });
});

describe("remedyFor — the two states give opposite instructions", () => {
  it("a dead token says rotate now, in words", () => {
    const remedy = remedyFor("dead", "VSCE_PAT", DECLARED_EXPIRY["VSCE_PAT"], NOW);
    expect(remedy).toContain("ROTATE NOW");
    expect(remedy).toContain("REJECTED");
  });

  it("an approaching expiry says explicitly that it is NOT a rotation emergency", () => {
    const remedy = remedyFor("expiry-approaching", "VSCE_PAT", expiryDaysOut(53), NOW);
    expect(remedy).toContain("nothing is broken");
    expect(remedy).toContain("do not treat this as a rotation emergency");
    expect(remedy).not.toContain("ROTATE NOW");
  });

  it("an absent secret says provision and explicitly says NOT to rotate", () => {
    const remedy = remedyFor("not-configured", "OVSX_PAT", undefined, NOW);
    expect(remedy).toContain("PROVISION");
    expect(remedy).toContain("Do **not** rotate");
  });

  it("an unreachable probe says it is not evidence of revocation", () => {
    expect(remedyFor("unreachable", "OVSX_PAT", undefined, NOW)).toContain(
      "not evidence of revocation",
    );
  });
});

describe("renderBody sections", () => {
  const section = (body: string, heading: string): string => {
    const start = body.indexOf(heading);
    if (start < 0) return "";
    const rest = body.slice(start + heading.length);
    const next = rest.search(/^## /m);
    return next < 0 ? rest : rest.slice(0, next);
  };

  const rows = evaluate(
    [
      { name: "VSCE_PAT", probeStatus: "ok" },
      { name: "OVSX_PAT", probeStatus: "dead" },
    ],
    NOW,
    { VSCE_PAT: expiryDaysOut(53) },
  );

  it("a dead token and a dated one land in different sections", () => {
    const body = renderBody(rows);
    expect(section(body, BROKEN_HEADING)).toContain("OVSX_PAT");
    expect(section(body, SCHEDULED_HEADING)).toContain("VSCE_PAT");
  });

  it("neither can appear in the other's section — this is the whole point", () => {
    const body = renderBody(rows);
    expect(section(body, BROKEN_HEADING)).not.toContain("VSCE_PAT");
    expect(section(body, SCHEDULED_HEADING)).not.toContain("OVSX_PAT");
  });

  it("the headings differ in glyph and in words, not just in the verdict column", () => {
    expect(BROKEN_HEADING).toContain("❌");
    expect(SCHEDULED_HEADING).toContain("🟡");
    expect(SCHEDULED_HEADING.toLowerCase()).toContain("nothing here is broken");
  });

  it("both actionable headings render even when empty, so 0 → 1 is a visible change", () => {
    const clean = renderBody(
      evaluate(
        [
          { name: "VSCE_PAT", probeStatus: "ok" },
          { name: "OVSX_PAT", probeStatus: "ok" },
        ],
        NOW,
        {},
      ),
    );
    expect(clean).toContain(BROKEN_HEADING);
    expect(clean).toContain(SCHEDULED_HEADING);
    expect(section(clean, BROKEN_HEADING)).toContain("_None._");
    expect(section(clean, HEALTHY_HEADING)).toContain("VSCE_PAT");
  });

  it("the headline alone carries the verdict counts", () => {
    expect(renderBody(rows).split("\n")[0]).toBe("**BROKEN: 1 · scheduled: 1 · healthy: 0**");
  });

  it("the body names the source of truth for the dated half", () => {
    expect(renderBody(rows)).toContain("credential-registry.ts");
  });
});

describe("annotationsFor", () => {
  it("a dated row is a ::warning:: and a rejected one an ::error::", () => {
    const rows = evaluate(
      [
        { name: "VSCE_PAT", probeStatus: "ok" },
        { name: "OVSX_PAT", probeStatus: "dead" },
      ],
      NOW,
      { VSCE_PAT: expiryDaysOut(53) },
    );
    const lines = annotationsFor(rows);
    expect(lines.find((l) => l.includes("VSCE_PAT"))).toMatch(/^::warning /);
    expect(lines.find((l) => l.includes("OVSX_PAT"))).toMatch(/^::error /);
  });

  it("healthy rows emit nothing", () => {
    const rows = evaluate([{ name: "OVSX_PAT", probeStatus: "ok" }], NOW, {});
    expect(annotationsFor(rows)).toEqual([]);
  });

  it("interpolated text can never begin a second workflow command", () => {
    // Commands are recognised only at the start of a line, so encoding every
    // CR/LF is the property that matters.
    const [line] = annotationsFor([
      {
        name: "EVIL\n::error::spoofed",
        probeStatus: "dead",
        verdict: "dead" satisfies Verdict,
        severity: "hard",
        remedy: "100% broken\r\nsecond line",
      },
    ]);
    expect(line?.split(/\r|\n/)).toHaveLength(1);
    expect(line?.split(/^::/gm)).toHaveLength(2);
    expect(line).toMatch(/^::error /);
    expect(line).toContain("%0A");
    expect(line).toContain("%0D");
    expect(line).toContain("%25");
  });
});

describe("job outcome", () => {
  it("an approaching expiry alone does NOT fail the job, but does warn", () => {
    const rows = evaluate(
      [
        { name: "VSCE_PAT", probeStatus: "ok" },
        { name: "OVSX_PAT", probeStatus: "ok" },
      ],
      NOW,
      { VSCE_PAT: expiryDaysOut(53) },
    );
    expect(hasHardFailure(rows)).toBe(false);
    expect(hasWarning(rows)).toBe(true);
  });

  it("the same expiry inside the critical window DOES fail the job", () => {
    const rows = evaluate([{ name: "VSCE_PAT", probeStatus: "ok" }], NOW, {
      VSCE_PAT: expiryDaysOut(EXPIRY_CRITICAL_DAYS - 1),
    });
    expect(hasHardFailure(rows)).toBe(true);
  });

  it("a dead token fails the job even while another credential is merely dated", () => {
    const rows = evaluate(
      [
        { name: "VSCE_PAT", probeStatus: "ok" },
        { name: "OVSX_PAT", probeStatus: "dead" },
      ],
      NOW,
      { VSCE_PAT: expiryDaysOut(53) },
    );
    expect(hasHardFailure(rows)).toBe(true);
  });

  it("an all-healthy run neither fails nor warns", () => {
    const rows = evaluate(
      [
        { name: "VSCE_PAT", probeStatus: "ok" },
        { name: "OVSX_PAT", probeStatus: "ok" },
      ],
      NOW,
      {},
    );
    expect(hasHardFailure(rows)).toBe(false);
    expect(hasWarning(rows)).toBe(false);
  });
});

describe("DECLARED_EXPIRY mirror", () => {
  it("records VSCE_PAT's own expiry, not the global-PAT decommission date", () => {
    // Pinned so the earlier, real date cannot silently regress to the
    // 2026-12-01 decommission, which does not apply to an org-scoped token —
    // the same assertion the Nimbus registry test makes on the source of truth.
    expect(DECLARED_EXPIRY["VSCE_PAT"]).toBe("2026-09-20");
    expect(DECLARED_EXPIRY["VSCE_PAT"]).not.toBe("2026-12-01");
  });

  it("every declared expiry is an ISO date", () => {
    for (const iso of Object.values(DECLARED_EXPIRY)) {
      expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("OVSX_PAT is deliberately undated — it rotates on cadence, not against a deadline", () => {
    expect(DECLARED_EXPIRY["OVSX_PAT"]).toBeUndefined();
  });
});
