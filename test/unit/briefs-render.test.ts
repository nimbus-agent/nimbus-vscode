import type {
  ConflictBrief,
  GhostBrief,
  HuddleBrief,
  JanitorBrief,
  PreflightBrief,
  WhyBrief,
} from "@nimbus-dev/client";
import { describe, expect, test } from "vitest";

import {
  gapsFooter,
  renderConflicts,
  renderGhost,
  renderHuddle,
  renderJanitor,
  renderPreflight,
  renderWhy,
} from "../../src/briefs/render.js";

// Typed rather than `as const`: AgentBriefBase.gaps is a mutable GapNote[], and
// a readonly [] from `as const` is not assignable to it.
const BASE: {
  agentVersion: 1;
  generatedAt: number;
  latencyMs: number;
  gaps: WhyBrief["gaps"];
} = { agentVersion: 1, generatedAt: 0, latencyMs: 12, gaps: [] };
const NOW = 1_000_000_000_000;

function why(over: Partial<WhyBrief> = {}): WhyBrief {
  return {
    ...BASE,
    kind: "why",
    query: { ref: "src/auth/session.ts", line: 42 },
    subject: null,
    findings: [],
    ...over,
  } as WhyBrief;
}

describe("gapsFooter", () => {
  test("is empty when there are no gaps", () => {
    expect(gapsFooter({ gaps: [] })).toBe("");
  });

  test("joins every gap detail", () => {
    expect(gapsFooter({ gaps: [{ detail: "no chat connector" }, { detail: "empty index" }] })).toBe(
      "\n\n_Data gaps: no chat connector; empty index_",
    );
  });
});

describe("renderWhy", () => {
  test("says so plainly when nothing was found", () => {
    const out = renderWhy(why());
    expect(out).toContain("No history found for `src/auth/session.ts:42`");
  });

  test("groups findings by lane and links those with a url", () => {
    const out = renderWhy(
      why({
        findings: [
          {
            lane: "pull_request",
            title: "Fix retry loop",
            detail: "PR #412",
            url: "https://example.test/pr/412",
            occurredAt: null,
            entityId: null,
          },
          {
            lane: "ticket",
            title: "NIM-88",
            detail: "Session drops under load",
            url: null,
            occurredAt: null,
            entityId: null,
          },
        ],
      }),
    );
    expect(out).toContain("### Pull request");
    expect(out).toContain("[Fix retry loop](https://example.test/pr/412) — PR #412");
    expect(out).toContain("### Ticket");
    expect(out).toContain("**NIM-88** — Session drops under load");
  });

  test("never echoes the subject's absolute repoRoot", () => {
    const out = renderWhy(
      why({
        subject: {
          repoRoot: "/home/dev/secret-project",
          filePath: "src/auth/session.ts",
          lineNo: 42,
          symbol: "refreshToken",
        },
      }),
    );
    expect(out).toContain("refreshToken");
    expect(out).not.toContain("/home/dev/secret-project");
  });

  test("appends the gaps footer", () => {
    expect(
      renderWhy(why({ gaps: [{ category: "empty_index", detail: "index is empty" }] })),
    ).toContain("_Data gaps: index is empty_");
  });
});

describe("renderGhost", () => {
  const ghost = (findings: GhostBrief["findings"]): GhostBrief =>
    ({
      ...BASE,
      kind: "ghost",
      query: { file: "src/auth/session.ts" },
      startEntityId: null,
      findings,
    }) as GhostBrief;

  test("says so plainly when nothing was found", () => {
    expect(renderGhost(ghost([]))).toContain(
      "No knowledge-holder signals found for `src/auth/session.ts`",
    );
  });

  test("names the expert, the rank and who to contact", () => {
    const out = renderGhost(
      ghost([
        {
          peerId: "peer-1",
          expert: "Robin Hale",
          rank: "high",
          context: [],
          suggestedContact: "#team-auth",
        },
      ]),
    );
    expect(out).toContain("**Robin Hale** — high confidence, contact #team-auth");
  });

  test("falls back to 'unattributed' when the expert is null", () => {
    const out = renderGhost(
      ghost([
        { peerId: "peer-2", expert: null, rank: "low", context: [], suggestedContact: "#general" },
      ]),
    );
    expect(out).toContain("**unattributed** — low confidence, contact #general");
  });
});

describe("renderConflicts", () => {
  const conflicts = (collisions: ConflictBrief["collisions"]): ConflictBrief =>
    ({
      ...BASE,
      kind: "conflict",
      query: { file: "src/auth/session.ts" },
      startEntityId: null,
      collisions,
    }) as ConflictBrief;

  test("says so plainly when nobody else is touching it", () => {
    expect(renderConflicts(conflicts([]), NOW)).toContain(
      "Nobody else is touching `src/auth/session.ts`",
    );
  });

  test("names who, what kind of collision, and how long ago", () => {
    const out = renderConflicts(
      conflicts([
        {
          peerId: "peer-1",
          who: "Sam Okafor",
          service: "auth",
          collisionType: "open_pr",
          title: "Rework session refresh",
          snippet: "…",
          modifiedAt: NOW - 3 * 60 * 60 * 1000,
        },
      ]),
      NOW,
    );
    expect(out).toContain("**Sam Okafor** — open pr in auth, 3h ago: Rework session refresh");
  });
});

describe("renderHuddle", () => {
  const huddle = (contributions: HuddleBrief["contributions"]): HuddleBrief =>
    ({ ...BASE, kind: "huddle", query: { sinceMs: 86_400_000 }, contributions }) as HuddleBrief;

  test("says so plainly when the window is empty", () => {
    expect(renderHuddle(huddle([]), NOW)).toContain("Nothing to huddle about");
  });

  test("counts each contributor's PRs, tickets and incidents", () => {
    const out = renderHuddle(
      huddle([
        {
          peerId: "peer-1",
          who: "Robin Hale",
          prs: [{ title: "Fix retry", snippet: "", service: "auth", modifiedAt: NOW }],
          tickets: [],
          incidents: [
            { title: "Auth outage", snippet: "", service: "auth", modifiedAt: NOW - 7_200_000 },
          ],
        },
      ]),
      NOW,
    );
    expect(out).toContain("**Robin Hale** — 1 PR, 1 incident");
    expect(out).toContain("Fix retry");
    expect(out).toContain("Auth outage");
  });
});

function janitor(over: Partial<JanitorBrief> = {}): JanitorBrief {
  return {
    ...BASE,
    kind: "janitor",
    query: { resourceRef: "svc/legacy-billing", idleDays: 90 },
    idle: true,
    proposalSuppressed: false,
    cleanupAction: null,
    peersClear: 0,
    peersTouched: [],
    ...over,
  } as JanitorBrief;
}

function preflight(over: Partial<PreflightBrief> = {}): PreflightBrief {
  return {
    ...BASE,
    kind: "preflight",
    query: { ref: "release-1.4", namespace: "billing" },
    downstreams: [],
    anyFailed: false,
    anyIncomplete: false,
    ...over,
  } as PreflightBrief;
}

describe("renderJanitor", () => {
  test("an idle resource names the window it was idle for", () => {
    expect(renderJanitor(janitor())).toContain("`svc/legacy-billing` looks idle after 90 days");
  });

  test("an active resource does not read as idle", () => {
    const out = renderJanitor(janitor({ idle: false }));
    expect(out).toContain("still active");
    expect(out).not.toContain("looks idle");
  });

  test("a cleanup action is a suggestion, never an action taken", () => {
    const out = renderJanitor(janitor({ cleanupAction: "archive svc/legacy-billing" }));
    expect(out).toContain("`archive svc/legacy-billing`");
    expect(out).toContain("Nimbus never performs this");
  });

  test("a suppressed proposal says so instead of staying silent", () => {
    expect(renderJanitor(janitor({ proposalSuppressed: true }))).toContain("No cleanup proposed");
  });

  test("peers who touched it are named with how long ago", () => {
    const out = renderJanitor(
      janitor({
        idle: false,
        peersClear: 2,
        peersTouched: [{ peerId: "p1", who: "Dana", lastSeenDaysAgo: 3 }],
      }),
    );
    expect(out).toContain("**Dana** — last seen 3 days ago");
    expect(out).toContain("2 peers reported no recent activity");
  });

  test("an unknown last-seen is not rendered as zero days", () => {
    const out = renderJanitor(
      janitor({ peersTouched: [{ peerId: "p1", who: null, lastSeenDaysAgo: null }] }),
    );
    expect(out).toContain("**unattributed** — last seen at an unknown time");
    expect(out).not.toContain("0 days ago");
  });

  test("gap notes reach the footer", () => {
    expect(
      renderJanitor(janitor({ gaps: [{ category: "empty_index", detail: "no peer answered" }] })),
    ).toContain("_Data gaps: no peer answered_");
  });
});

describe("renderPreflight", () => {
  test("a failure is stated as not safe to deploy", () => {
    const out = renderPreflight(
      preflight({
        anyFailed: true,
        downstreams: [{ peerId: "p1", who: "checkout", status: "fail", summary: "smoke failed" }],
      }),
    );
    expect(out).toContain("Not safe to deploy");
    expect(out).toContain("**checkout** — FAIL: smoke failed");
  });

  test("an incomplete answer reads as inconclusive, not as a pass", () => {
    const out = renderPreflight(
      preflight({
        anyIncomplete: true,
        downstreams: [
          { peerId: "p1", who: null, status: "not_configured", summary: "no checks defined" },
        ],
      }),
    );
    expect(out).toContain("Inconclusive");
    expect(out).not.toContain("No failures reported");
    expect(out).toContain("not configured (unknown)");
  });

  test("no downstreams says nothing was checked, not that everything passed", () => {
    const out = renderPreflight(preflight());
    expect(out).toContain("nothing was actually checked");
  });

  test("a clean run names the ref and namespace it checked", () => {
    const out = renderPreflight(
      preflight({
        downstreams: [{ peerId: "p1", who: "checkout", status: "pass", summary: "all green" }],
      }),
    );
    expect(out).toContain("No failures reported for `release-1.4` in `billing`");
  });

  test("a declined downstream is named rather than dropped", () => {
    const out = renderPreflight(
      preflight({
        anyIncomplete: true,
        downstreams: [{ peerId: "p9", who: null, status: "declined", summary: "peer opted out" }],
      }),
    );
    expect(out).toContain("**p9** — declined (no answer): peer opted out");
  });
});
