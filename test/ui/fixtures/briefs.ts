import type {
  ConflictBrief,
  GhostBrief,
  HuddleBrief,
  JanitorBrief,
  PreflightBrief,
  WhyBrief,
  WhyPeek,
} from "@nimbus-dev/client";

const BASE = { agentVersion: 1 as const, generatedAt: 0, latencyMs: 5, gaps: [] };

export const WHY_BRIEF: WhyBrief = {
  ...BASE,
  kind: "why",
  query: { ref: "src/session.ts", line: 3 },
  subject: null,
  findings: [
    {
      lane: "pull_request",
      title: "PR #42 — add session cache",
      detail: "merged",
      url: null,
      occurredAt: null,
      entityId: null,
    },
  ],
};

export const GHOST_BRIEF: GhostBrief = {
  ...BASE,
  kind: "ghost",
  query: { file: "src/session.ts" },
  startEntityId: null,
  findings: [
    {
      peerId: "p1",
      expert: "Dana",
      rank: "high",
      context: [],
      suggestedContact: "dana@example.com",
    },
  ],
};

export const CONFLICT_BRIEF: ConflictBrief = {
  ...BASE,
  kind: "conflict",
  query: { file: "src/session.ts" },
  startEntityId: null,
  collisions: [],
};

export const HUDDLE_BRIEF: HuddleBrief = {
  ...BASE,
  kind: "huddle",
  query: { sinceMs: 86_400_000 },
  contributions: [],
};

export const JANITOR_BRIEF: JanitorBrief = {
  ...BASE,
  kind: "janitor",
  query: { resourceRef: "svc/legacy-billing", idleDays: 90 },
  idle: true,
  proposalSuppressed: false,
  cleanupAction: null,
  peersClear: 0,
  peersTouched: [],
};

export const PREFLIGHT_BRIEF: PreflightBrief = {
  ...BASE,
  kind: "preflight",
  query: { ref: "release-1.4", namespace: "billing" },
  downstreams: [],
  anyFailed: false,
  anyIncomplete: false,
};

export const WHY_PEEK: WhyPeek = {
  subject: { repoRoot: "/fixture", filePath: "src/session.ts", lineNo: 3 },
  author: "Dana",
  authorEmail: "dana@example.com",
  commitSha: "abc1234",
  committedAt: 0,
  commitSubject: "add session cache",
  pr: null,
  ticket: null,
  hasMore: false,
};

/** agent name (the `agents.<name>` suffix) → the findings it answers with. */
export const BRIEF_BY_AGENT: Record<string, unknown> = {
  why: WHY_BRIEF,
  ghost: GHOST_BRIEF,
  conflicts: CONFLICT_BRIEF,
  huddle: HUDDLE_BRIEF,
  janitor: JANITOR_BRIEF,
  preflight: PREFLIGHT_BRIEF,
};
