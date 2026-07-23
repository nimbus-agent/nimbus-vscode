import { describe, expect, test, vi } from "vitest";

import { runOpsCommand } from "../../src/chat-participant/ops-commands.js";
import type {
  ChatResponseSink,
  ParticipantClientLike,
  ParticipantRequest,
} from "../../src/chat-participant/participant-types.js";

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

function client(over: Partial<ParticipantClientLike>): ParticipantClientLike {
  return {
    askStream: () => {
      throw new Error("askStream must not be called by ops commands");
    },
    searchRanked: async () => [],
    agentsExpert: async () => {
      throw new Error("not faked");
    },
    agentsImpact: async () => {
      throw new Error("not faked");
    },
    agentsCatchup: async () => {
      throw new Error("not faked");
    },
    metricsDora: async () => {
      throw new Error("not faked");
    },
    egressHead: async () => {
      throw new Error("not faked");
    },
    ...over,
  };
}

function req(over: Partial<ParticipantRequest>): ParticipantRequest {
  return { prompt: "", attachments: [], ...over };
}

const noWarn = { warn: () => undefined };

const briefBase = { agentVersion: 1 as const, generatedAt: 1, latencyMs: 5, gaps: [] };

describe("/blast", () => {
  test("renders impact findings for the prompt-named target", async () => {
    const agentsImpact = vi.fn(async () => ({
      ...briefBase,
      kind: "impact" as const,
      query: { fileOrPrUrl: "src/pay.ts" },
      startEntityId: "e1",
      affected: [
        {
          category: "service" as const,
          affectedItemId: "i1",
          affectedTitle: "billing-api",
          serviceId: "github",
          hops: 2,
          pathSummary: "pay.ts → checkout → billing-api",
        },
      ],
    }));
    const c = sinkCapture();
    await runOpsCommand(
      client({ agentsImpact }),
      req({ command: "blast", prompt: "src/pay.ts" }),
      c.sink,
      noWarn,
    );
    expect(agentsImpact).toHaveBeenCalledWith({ fileOrPrUrl: "src/pay.ts" });
    expect(c.all()).toContain("billing-api");
    expect(c.all()).toContain("2 hop");
    expect(c.all()).toContain("pay.ts → checkout → billing-api");
  });

  test("falls back to the active selection's file and reports empty honestly with gaps", async () => {
    const agentsImpact = vi.fn(async () => ({
      ...briefBase,
      gaps: [{ category: "missing_connector" as const, detail: "no CI connector indexed" }],
      kind: "impact" as const,
      query: { fileOrPrUrl: "/w/a.tf" },
      startEntityId: null,
      affected: [],
    }));
    const c = sinkCapture();
    await runOpsCommand(
      client({ agentsImpact }),
      req({ command: "blast", selection: { path: "/w/a.tf", languageId: "terraform", code: "x" } }),
      c.sink,
      noWarn,
    );
    expect(agentsImpact).toHaveBeenCalledWith({ fileOrPrUrl: "/w/a.tf" });
    expect(c.all()).toContain("No downstream dependents");
    expect(c.all()).toContain("no CI connector indexed");
  });

  test("without a target renders usage, calling nothing", async () => {
    const agentsImpact = vi.fn();
    const c = sinkCapture();
    await runOpsCommand(client({}), req({ command: "blast" }), c.sink, noWarn);
    expect(agentsImpact).not.toHaveBeenCalled();
    expect(c.all()).toContain("/blast");
  });
});

describe("/owns", () => {
  test("renders ranked experts with confidence and signal counts", async () => {
    const agentsExpert = vi.fn(async () => ({
      ...briefBase,
      kind: "expert" as const,
      query: { topicOrFile: "billing" },
      ranked: [
        {
          personId: "p1",
          displayName: "Dana K",
          evidence: [
            {
              itemId: "x",
              type: "pr_authored" as const,
              serviceId: "github",
              title: "t",
              modifiedAt: 1,
              weight: 1,
            },
          ],
          score: 0.9,
          confidence: "high" as const,
        },
      ],
    }));
    const c = sinkCapture();
    await runOpsCommand(
      client({ agentsExpert }),
      req({ command: "owns", prompt: "billing" }),
      c.sink,
      noWarn,
    );
    expect(agentsExpert).toHaveBeenCalledWith({ topicOrFile: "billing", limit: 5 });
    expect(c.all()).toContain("Dana K");
    expect(c.all()).toContain("high confidence");
    expect(c.all()).toContain("1 signal");
  });
});

describe("/incident", () => {
  test("renders per-service sections for the last 24h, scoping to a named service", async () => {
    const agentsCatchup = vi.fn(async () => ({
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
      client({ agentsCatchup }),
      req({ command: "incident", prompt: "pagerduty" }),
      c.sink,
      noWarn,
    );
    expect(agentsCatchup).toHaveBeenCalledWith({ sinceMs: 86_400_000, service: "pagerduty" });
    expect(c.all()).toContain("pagerduty");
    expect(c.all()).toContain("SEV2: checkout 500s");
    expect(c.all()).toContain("incident open");
  });
});

describe("/deploys", () => {
  test("renders the four DORA metrics, nulls as gaps", async () => {
    const metricsDora = vi.fn(async () => ({
      service: "checkout",
      since_ms: 1,
      computed_at: "t",
      metrics: {
        deployment_frequency: { value: 4.2, unit: "per_week", sample: 12, gap: null },
        lead_time_for_changes: { value: null, unit: "hours", sample: 0, gap: "no_repos" as const },
        change_failure_rate: { value: 0.1, unit: "ratio", sample: 10, gap: null },
        mttr: { value: 2.5, unit: "hours", sample: 3, gap: null },
      },
    }));
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
    const agentsImpact = vi.fn(async () => {
      throw new Error("agent timed out");
    });
    const c = sinkCapture();
    await runOpsCommand(client({ agentsImpact }), req({ command: "blast", prompt: "x" }), c.sink, {
      warn: (m: string) => warnings.push(m),
    });
    expect(c.all()).toContain("agent timed out");
    expect(warnings.length).toBe(1);
  });
});
