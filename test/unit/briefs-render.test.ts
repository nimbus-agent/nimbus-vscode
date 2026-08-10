import type { ConflictBrief, GhostBrief, HuddleBrief, WhyBrief } from "@nimbus-dev/client";
import { describe, expect, test } from "vitest";

import {
  gapsFooter,
  renderConflicts,
  renderGhost,
  renderHuddle,
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
