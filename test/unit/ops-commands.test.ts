import type { DoraMetricsResult, ExpertBrief, ImpactBrief } from "@nimbus-dev/client";
import { describe, expect, test, vi } from "vitest";

import { runOpsCommand } from "../../src/chat-participant/ops-commands.js";
import type {
  ChatResponseSink,
  ParticipantClientLike,
  ParticipantRequest,
} from "../../src/chat-participant/participant-types.js";
import type { ParticipantBriefs } from "../../src/egress/gated-client.js";

function sinkCapture(): { sink: ChatResponseSink; md: string[]; all: () => string } {
  const md: string[] = [];
  return {
    md,
    all: () => md.join("\n"),
    sink: {
      markdown: (t) => md.push(t),
      progress: () => undefined,
      citation: () => undefined,
      button: () => undefined,
    },
  };
}

// `over.briefs` overrides individual brief methods; the rest stay as
// never-called stubs, same shape as the pre-seam ...over spread this replaces.
function client(
  over: Partial<Omit<ParticipantClientLike, "briefs">> & { briefs?: Partial<ParticipantBriefs> },
): ParticipantClientLike {
  const { briefs, ...rest } = over;
  return {
    askStream: () => {
      throw new Error("askStream must not be called by ops commands");
    },
    searchRanked: async () => [],
    briefs: {
      expert: async () => {
        throw new Error("not faked");
      },
      impact: async () => {
        throw new Error("not faked");
      },
      catchup: async () => {
        throw new Error("not faked");
      },
      ...briefs,
    },
    metricsDora: async () => {
      throw new Error("not faked");
    },
    egressHead: async () => {
      throw new Error("not faked");
    },
    ...rest,
  };
}

function req(over: Partial<ParticipantRequest>): ParticipantRequest {
  return { prompt: "", attachments: [], ...over };
}

const noWarn = { warn: () => undefined };

const briefBase = { agentVersion: 1 as const, generatedAt: 1, latencyMs: 5, gaps: [] };

// The exact EgressMeta each handler passes — asserted alongside params so a
// call is proven to have gone through client.briefs.*, not some other path.
const IMPACT_META = { action: "Blast radius (agents.impact)", files: [], omissions: [] };
const EXPERT_META = { action: "Who owns this (agents.expert)", files: [], omissions: [] };
const CATCHUP_META = { action: "Catch me up (agents.catchup)", files: [], omissions: [] };

// Fixture builders. Each renders through a real brief type, so a field the
// Gateway renames fails the build here rather than at the assertion — and each
// test overrides only the field it is actually about.
function affected(
  over: Partial<ImpactBrief["affected"][number]> = {},
): ImpactBrief["affected"][number] {
  return {
    category: "service",
    affectedItemId: "i1",
    affectedTitle: "billing-api",
    serviceId: "github",
    hops: 2,
    pathSummary: "pay.ts → checkout → billing-api",
    ...over,
  };
}

function impactBrief(over: Partial<ImpactBrief> = {}): ImpactBrief {
  return {
    ...briefBase,
    kind: "impact",
    query: { fileOrPrUrl: "src/pay.ts" },
    startEntityId: "e1",
    affected: [affected()],
    ...over,
  };
}

function evidence(itemId = "x"): ExpertBrief["ranked"][number]["evidence"][number] {
  return { itemId, type: "pr_authored", serviceId: "github", title: "t", modifiedAt: 1, weight: 1 };
}

function expertBrief(over: Partial<ExpertBrief> = {}): ExpertBrief {
  return {
    ...briefBase,
    kind: "expert",
    query: { topicOrFile: "billing" },
    ranked: [
      {
        personId: "p1",
        displayName: "Dana K",
        evidence: [evidence()],
        score: 0.9,
        confidence: "high",
      },
    ],
    ...over,
  };
}

function doraResult(over: Partial<DoraMetricsResult["metrics"]> = {}): DoraMetricsResult {
  return {
    service: "checkout",
    since_ms: 1,
    computed_at: "t",
    metrics: {
      deployment_frequency: { value: 4.2, unit: "per_week", sample: 12, gap: null },
      lead_time_for_changes: { value: 1, unit: "hours", sample: 2, gap: null },
      change_failure_rate: { value: 0.1, unit: "ratio", sample: 10, gap: null },
      mttr: { value: 2.5, unit: "hours", sample: 3, gap: null },
      ...over,
    },
  };
}

describe("/blast", () => {
  test("renders impact findings for the prompt-named target", async () => {
    const impact = vi.fn(async () => impactBrief());
    const c = sinkCapture();
    await runOpsCommand(
      client({ briefs: { impact } }),
      req({ command: "blast", prompt: "src/pay.ts" }),
      c.sink,
      noWarn,
    );
    expect(impact).toHaveBeenCalledWith({ fileOrPrUrl: "src/pay.ts" }, IMPACT_META);
    expect(c.all()).toContain("billing-api");
    expect(c.all()).toContain("2 hop");
    expect(c.all()).toContain("pay.ts → checkout → billing-api");
  });

  test("falls back to the active selection's file, redacted to a basename, and reports empty honestly with gaps", async () => {
    const impact = vi.fn(async () =>
      impactBrief({
        gaps: [{ category: "missing_connector", detail: "no CI connector indexed" }],
        query: { fileOrPrUrl: "a.tf" },
        startEntityId: null,
        affected: [],
      }),
    );
    const c = sinkCapture();
    await runOpsCommand(
      client({ briefs: { impact } }),
      req({ command: "blast", selection: { path: "/w/a.tf", languageId: "terraform", code: "x" } }),
      c.sink,
      noWarn,
    );
    expect(impact).toHaveBeenCalledWith({ fileOrPrUrl: "a.tf" }, IMPACT_META);
    expect(c.all()).toContain("No downstream dependents");
    expect(c.all()).toContain("no CI connector indexed");
  });

  test("with no argument sends a basename, never the absolute local path", async () => {
    const sent: unknown[] = [];
    const impact = vi.fn(async (p: unknown) => {
      sent.push(p);
      return impactBrief({
        query: { fileOrPrUrl: "session.ts" },
        startEntityId: null,
        affected: [],
      });
    });
    const c = sinkCapture();
    await runOpsCommand(
      client({ briefs: { impact } }),
      req({
        command: "blast",
        selection: { path: "/home/dev/proj/src/session.ts", languageId: "ts", code: "" },
      }),
      c.sink,
      noWarn,
    );
    expect(sent[0]).toEqual({ fileOrPrUrl: "session.ts" });
  });

  test("without a target renders usage, calling nothing", async () => {
    const impact = vi.fn();
    const c = sinkCapture();
    await runOpsCommand(client({ briefs: { impact } }), req({ command: "blast" }), c.sink, noWarn);
    expect(impact).not.toHaveBeenCalled();
    expect(c.all()).toContain("/blast");
  });
});

describe("/owns", () => {
  test("renders ranked experts with confidence and signal counts", async () => {
    const expert = vi.fn(async () => expertBrief());
    const c = sinkCapture();
    await runOpsCommand(
      client({ briefs: { expert } }),
      req({ command: "owns", prompt: "billing" }),
      c.sink,
      noWarn,
    );
    expect(expert).toHaveBeenCalledWith({ topicOrFile: "billing", limit: 5 }, EXPERT_META);
    expect(c.all()).toContain("Dana K");
    expect(c.all()).toContain("high confidence");
    expect(c.all()).toContain("1 signal");
  });

  test("with no argument sends a basename, never the absolute local path", async () => {
    const sent: unknown[] = [];
    const expert = vi.fn(async (p: unknown) => {
      sent.push(p);
      return expertBrief({ query: { topicOrFile: "session.ts" }, ranked: [] });
    });
    const c = sinkCapture();
    await runOpsCommand(
      client({ briefs: { expert } }),
      req({
        command: "owns",
        selection: { path: "/home/dev/proj/src/session.ts", languageId: "ts", code: "" },
      }),
      c.sink,
      noWarn,
    );
    expect(sent[0]).toEqual({ topicOrFile: "session.ts", limit: 5 });
  });
});

describe("/incident", () => {
  test("renders per-service sections for the last 24h, scoping to a named service", async () => {
    const catchup = vi.fn(async () => ({
      ...briefBase,
      kind: "catchup" as const,
      query: { sinceMs: 86_400_000 },
      selfPersonId: null,
      involvement: {
        ownedServices: [],
        activeRepos: [],
        incidentServices: [],
        collaboratorPersonIds: [],
      },
      sections: [
        {
          serviceId: "pagerduty",
          totalItemsInWindow: 3,
          items: [
            {
              itemId: "i",
              title: "SEV2: checkout 500s",
              modifiedAt: 2,
              relevanceScore: 1,
              relevanceReasons: ["incident open"],
            },
          ],
        },
      ],
    }));
    const c = sinkCapture();
    await runOpsCommand(
      client({ briefs: { catchup } }),
      req({ command: "incident", prompt: "pagerduty" }),
      c.sink,
      noWarn,
    );
    expect(catchup).toHaveBeenCalledWith(
      { sinceMs: 86_400_000, service: "pagerduty" },
      CATCHUP_META,
    );
    expect(c.all()).toContain("pagerduty");
    expect(c.all()).toContain("SEV2: checkout 500s");
    expect(c.all()).toContain("incident open");
  });
});

describe("/deploys", () => {
  test("renders the four DORA metrics, nulls as gaps", async () => {
    const metricsDora = vi.fn(async () =>
      doraResult({
        lead_time_for_changes: { value: null, unit: "hours", sample: 0, gap: "no_repos" },
      }),
    );
    const c = sinkCapture();
    await runOpsCommand(
      client({ metricsDora }),
      req({ command: "deploys", prompt: "checkout 7d" }),
      c.sink,
      noWarn,
    );
    expect(metricsDora).toHaveBeenCalledWith({ service: "checkout", since: "7d" });
    expect(c.all()).toContain("4.2 per_week");
    expect(c.all()).toContain("no data (no_repos)");
  });

  test("without a service renders usage", async () => {
    const c = sinkCapture();
    await runOpsCommand(client({}), req({ command: "deploys" }), c.sink, noWarn);
    expect(c.all()).toContain("/deploys <service>");
  });
});

describe("failure path", () => {
  test("a thrown brief error becomes markdown and a warning", async () => {
    const warnings: string[] = [];
    const impact = vi.fn(async () => {
      throw new Error("agent timed out");
    });
    const c = sinkCapture();
    await runOpsCommand(
      client({ briefs: { impact } }),
      req({ command: "blast", prompt: "x" }),
      c.sink,
      { warn: (m: string) => warnings.push(m) },
    );
    expect(c.all()).toContain("agent timed out");
    expect(warnings).toHaveLength(1);
  });
});
describe("singular vs plural", () => {
  // One hop is "1 hop", not "1 hops". The blast-radius line is the first thing a
  // reader sees, and the plural is computed, not hard-coded.
  test("a single hop reads as one hop", async () => {
    const impact = vi.fn(async () =>
      impactBrief({ affected: [affected({ hops: 1, pathSummary: "pay.ts → billing-api" })] }),
    );
    const c = sinkCapture();
    await runOpsCommand(
      client({ briefs: { impact } }),
      req({ command: "blast", prompt: "src/pay.ts" }),
      c.sink,
      noWarn,
    );
    expect(c.all()).toContain("1 hop)");
    expect(c.all()).not.toContain("1 hops");
  });

  test("two signals read as signals", async () => {
    const expert = vi.fn(async () =>
      expertBrief({
        ranked: [
          {
            personId: "p1",
            displayName: "Dana K",
            evidence: [evidence("x"), evidence("y")],
            score: 0.9,
            confidence: "high",
          },
        ],
      }),
    );
    const c = sinkCapture();
    await runOpsCommand(
      client({ briefs: { expert } }),
      req({ command: "owns", prompt: "billing" }),
      c.sink,
      noWarn,
    );
    expect(c.all()).toContain("2 signals");
  });
});

describe("/owns without a target", () => {
  // /blast already refuses to guess; /owns must too. Sending an empty topic
  // would spend a gated brief call on a question nobody asked.
  test("renders usage and calls no brief", async () => {
    const expert = vi.fn(async () => {
      throw new Error("expert must not be called");
    });
    const c = sinkCapture();
    await runOpsCommand(client({ briefs: { expert } }), req({ command: "owns" }), c.sink, noWarn);
    expect(c.all()).toContain("/owns <topic, service, or file>");
    expect(expert).not.toHaveBeenCalled();
  });
});

describe("/deploys window parsing", () => {
  // The window is a duration the Gateway understands. Anything else is the
  // user's typo, and forwarding it would trade a sensible default for an error
  // from a service that never saw the word they typed.
  test.each([
    ["24h", "24h"],
    ["30d", "30d"],
    ["last-week", "7d"],
    ["7", "7d"],
    ["7dd", "7d"],
  ])("a window of %s is sent as %s", async (typed, sent) => {
    const metricsDora = vi.fn(async () => doraResult());
    const c = sinkCapture();
    await runOpsCommand(
      client({ metricsDora }),
      req({ command: "deploys", prompt: `checkout ${typed}` }),
      c.sink,
      noWarn,
    );
    expect(metricsDora).toHaveBeenCalledWith({ service: "checkout", since: sent });
  });

  // A metric can be null with no reason attached. "no data ()" would read as a
  // rendering bug; say the reason is missing instead.
  test("a null metric with no stated gap says so rather than trailing empty parentheses", async () => {
    const metricsDora = vi.fn(async () =>
      doraResult({ deployment_frequency: { value: null, unit: "per_week", sample: 0, gap: null } }),
    );
    const c = sinkCapture();
    await runOpsCommand(
      client({ metricsDora }),
      req({ command: "deploys", prompt: "checkout" }),
      c.sink,
      noWarn,
    );
    expect(c.all()).toContain("Deployment frequency: no data (unqualified)");
  });
});

describe("a turn that is not a slash command", () => {
  // ParticipantCommand is a closed union of the four handled below, so the
  // switch's default arm is reachable only for a free-form turn — which the
  // participant answers itself. Falling through must be silent: writing
  // anything here would double-answer it.
  test("calls nothing and writes nothing", async () => {
    const c = sinkCapture();
    await runOpsCommand(client({}), req({ prompt: "hello" }), c.sink, noWarn);
    expect(c.md).toEqual([]);
  });
});
