import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

// The dev-workflow-trio review found that nothing asserted "nothing absolute
// crosses into agentInvoke" beyond four call sites each independently doing the
// right thing — fine that day, no guardrail for the fifth. This is the
// assertion. Every agent-bound call goes through src/egress/gated-client.ts,
// which is the only file allowed to reach the raw client.
//
// If this fails, route the offending file through gateRawAgentInvoke /
// gateRawAskStream. Do NOT widen ALLOWED — that defeats the entire point.
//
// Guard the CALL shape (a leading dot), not the bare identifier, so interface
// declarations like `agentInvoke(input: string, ...)` do not false-positive.
// Same trick as no-raw-sql-guard.test.ts.

// The choke point itself, plus the five consumer modules. A consumer only ever
// holds a seam INJECTED by extension.ts, never a real NimbusClient — and for
// agentInvoke that seam's type requires the EgressMeta argument, so the raw
// client does not even satisfy it. What this list must never contain is
// extension.ts, the one place a real client exists: keeping it out is why a
// new surface cannot quietly wire an ungated client through.
const ALLOWED = [
  "egress/gated-client.ts",
  "scm/commands.ts",
  "lm-tools/lm-tools.ts",
  "chat/chat-controller.ts",
  "chat-participant/participant.ts",
  "diagnostics/commands.ts",
];
const CALLS = [".agentInvoke(", ".askStream(", ".workflowRunStream("];

// Every agents* call in src/ that is gated. The built-in briefs and the
// participant's three ops briefs alike — the only shape allowed to appear
// outside the choke point is the one documented exemption below.
const GATED_BRIEF_CALLS = [
  ".agentsWhy(",
  ".agentsGhost(",
  ".agentsConflicts(",
  ".agentsHuddle(",
  ".agentsJanitor(",
  ".agentsPreflight(",
  ".agentsCatchup(",
  ".agentsExpert(",
  ".agentsImpact(",
];

// agents* calls that are deliberately NOT gated.
//
// `.agentsWhyPeek(` is the only one, and it is on evidence rather than
// convenience: it takes no timeoutMs, returns synchronously, and carries no
// `brief` string or AgentBriefBase — it never reaches a model, so there is
// nothing for a pre-flight preview to show. Verified live: it answers in 1-5ms
// with raw git-blame and index fields.
const UNGATED_BY_DESIGN = [".agentsWhyPeek("];

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTsFiles(p));
    else if (entry.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

const SRC = join(__dirname, "..", "..", "src");
const REPO = join(__dirname, "..", "..");

describe("agent-bound calls have exactly one choke point", () => {
  const norm = (f: string): string => f.slice(REPO.length + 1).replace(/\\/g, "/");

  for (const call of CALLS) {
    test(`${call} appears only in the choke point and its known consumers`, () => {
      const offenders = listTsFiles(SRC)
        .map(norm)
        .filter((f) => readFileSync(join(REPO, f), "utf8").includes(call))
        .filter((f) => !ALLOWED.some((a) => f.endsWith(a)));
      expect(offenders).toEqual([]);
    });
  }

  // The invariant that actually matters: extension.ts is the only place holding
  // a real NimbusClient, so it must reach the agent solely through this module.
  //
  // Checks member ACCESS (".agentInvoke"), not just the call shape, because
  // `client.askStream.bind(client)` would otherwise sail straight past — it was
  // in fact the first thing written here.
  test("extension.ts never touches the raw client's agent methods", () => {
    const src = readFileSync(join(SRC, "extension.ts"), "utf8");
    for (const member of [".agentInvoke", ".askStream", ".workflowRunStream"]) {
      expect(src).not.toContain(member);
    }
  });

  // workflowCancel is deliberately NOT guarded: it STOPS egress rather than
  // causing any, so routing it through the gate would mean asking permission to
  // stop sending. workflowList / workflowListRuns are read-only and reach no
  // model. Only the run itself is agent-bound.
  test("workflow.cancel is reachable without the gate, by design", () => {
    const gated = readFileSync(join(SRC, "egress", "gated-client.ts"), "utf8");
    expect(gated).not.toContain(".workflowCancel(");
  });

  // Guards the guard: if the call shapes are ever renamed, the tests above
  // would pass vacuously by matching nothing at all.
  test("the choke point really does contain both call shapes", () => {
    const gated = readFileSync(join(SRC, "egress", "gated-client.ts"), "utf8");
    for (const call of CALLS) expect(gated).toContain(call);
  });

  // The brief family. Same invariant, narrower list — see GATED_BRIEF_CALLS.
  for (const call of GATED_BRIEF_CALLS) {
    test(`${call} appears only in the choke point`, () => {
      const offenders = listTsFiles(SRC)
        .map(norm)
        .filter((f) => readFileSync(join(REPO, f), "utf8").includes(call))
        .filter((f) => !f.endsWith("egress/gated-client.ts"));
      expect(offenders).toEqual([]);
    });
  }

  // Checks member ACCESS, not just the call shape, so `client.agentsWhy.bind(…)`
  // cannot sail past. The boundary matters: `.agentsWhy` is a PREFIX of
  // `.agentsWhyPeek`, which extension.ts legitimately calls — whyPeek is the
  // documented gate exemption. A bare substring check flagged it as a violation.
  test("extension.ts never touches the raw client's gated brief methods", () => {
    const src = readFileSync(join(SRC, "extension.ts"), "utf8");
    for (const member of GATED_BRIEF_CALLS.map((c) => c.slice(0, -1))) {
      const access = new RegExp(`${member.replace(".", "\\.")}(?![A-Za-z])`);
      expect(access.test(src), `${member} must not be reached directly`).toBe(false);
    }
  });

  test("the choke point really does contain every gated brief call shape", () => {
    const gated = readFileSync(join(SRC, "egress", "gated-client.ts"), "utf8");
    for (const call of GATED_BRIEF_CALLS) expect(gated).toContain(call);
  });

  // Discovered, not listed: a new agents* call anywhere in src/ shows up here
  // even if whoever added it never touched this file. That is the point — a
  // hand-maintained list can only catch names someone remembered to add, which
  // is exactly how an ungated agent call would slip in.
  //
  // It scans comments too, so prose must not spell a call shape literally.
  // Write "agents*" in comments, not a dotted example with a paren.
  test("whyPeek is the only agents* call exempt from the gate", () => {
    const found = new Set<string>();
    for (const file of listTsFiles(SRC)) {
      for (const m of readFileSync(file, "utf8").matchAll(/\.agents[A-Z]\w*\(/g)) {
        found.add(m[0]);
      }
    }
    const unaccounted = [...found].filter((c) => !GATED_BRIEF_CALLS.includes(c)).sort();
    expect(unaccounted).toEqual(UNGATED_BY_DESIGN);
  });
});
