import type {
  ConflictBrief,
  GhostBrief,
  HuddleBrief,
  JanitorBrief,
  PreflightBrief,
  WhyBrief,
} from "@nimbus-dev/client";

import { formatRelativeTime } from "../sidebar/relative-time.js";

// Pure brief → markdown. Sink-agnostic by design: the editor surfaces pipe these
// strings into a read-only tab, the chat participant pipes the same strings into
// sink.markdown. One renderer, two sinks.

const LANE_HEADINGS: Record<WhyBrief["findings"][number]["lane"], string> = {
  authorship: "Authorship",
  pull_request: "Pull request",
  ticket: "Ticket",
  discussion: "Discussion",
  driver: "Driver",
  downstream: "Downstream",
};

// Shared with the chat participant's ops commands so a data gap reads the same
// wherever a brief is rendered. A thin brief must never read as a confident one.
export function gapsFooter(brief: { gaps: readonly { detail: string }[] }): string {
  if (brief.gaps.length === 0) return "";
  return `\n\n_Data gaps: ${brief.gaps.map((g) => g.detail).join("; ")}_`;
}

function plural(n: number, one: string): string {
  return `${n} ${one}${n === 1 ? "" : "s"}`;
}

export function renderWhy(brief: WhyBrief): string {
  const line = brief.query.line === null ? "" : `:${brief.query.line}`;
  const target = `\`${brief.query.ref}${line}\``;
  // subject.repoRoot is an absolute path on this machine. It is displayed
  // locally, not sent, but echoing it into a tab the user may paste elsewhere
  // leaks it just the same — so only symbol and filePath are rendered.
  const symbol =
    brief.subject?.symbol === null || brief.subject?.symbol === undefined
      ? ""
      : ` (\`${brief.subject.symbol}\`)`;
  if (brief.findings.length === 0) {
    return `No history found for ${target}${symbol}.${gapsFooter(brief)}`;
  }
  const lanes = new Map<string, string[]>();
  for (const f of brief.findings) {
    const heading = LANE_HEADINGS[f.lane];
    const label = f.url === null ? `**${f.title}**` : `[${f.title}](${f.url})`;
    const entry = f.detail.length > 0 ? `- ${label} — ${f.detail}` : `- ${label}`;
    lanes.set(heading, [...(lanes.get(heading) ?? []), entry]);
  }
  const sections = [...lanes].map(([heading, entries]) => `### ${heading}\n${entries.join("\n")}`);
  return `Why ${target}${symbol}:\n\n${sections.join("\n\n")}${gapsFooter(brief)}`;
}

export function renderGhost(brief: GhostBrief): string {
  const target = `\`${brief.query.file}\``;
  if (brief.findings.length === 0) {
    return `No knowledge-holder signals found for ${target} in the local index.${gapsFooter(brief)}`;
  }
  const lines = brief.findings.map((f) => {
    const who = f.expert ?? "unattributed";
    const context = f.context.length === 0 ? "" : ` — ${plural(f.context.length, "related item")}`;
    return `- **${who}** — ${f.rank} confidence, contact ${f.suggestedContact}${context}`;
  });
  return `Who knew ${target}:\n${lines.join("\n")}${gapsFooter(brief)}`;
}

export function renderConflicts(brief: ConflictBrief, now: number): string {
  const target = `\`${brief.query.file}\``;
  if (brief.collisions.length === 0) {
    return `Nobody else is touching ${target} right now.${gapsFooter(brief)}`;
  }
  const lines = brief.collisions.map((c) => {
    const who = c.who ?? "unattributed";
    const kind = c.collisionType.replace(/_/g, " ");
    const when = formatRelativeTime(now, c.modifiedAt);
    return `- **${who}** — ${kind} in ${c.service}, ${when}: ${c.title}`;
  });
  return `Also touching ${target}:\n${lines.join("\n")}${gapsFooter(brief)}`;
}

export function renderHuddle(brief: HuddleBrief, now: number): string {
  if (brief.contributions.length === 0) {
    return `Nothing to huddle about in this window.${gapsFooter(brief)}`;
  }
  const blocks = brief.contributions.map((c) => {
    const who = c.who ?? "unattributed";
    const counts: string[] = [];
    if (c.prs.length > 0) counts.push(plural(c.prs.length, "PR"));
    if (c.tickets.length > 0) counts.push(plural(c.tickets.length, "ticket"));
    if (c.incidents.length > 0) counts.push(plural(c.incidents.length, "incident"));
    const items = [...c.prs, ...c.tickets, ...c.incidents].map(
      (i) => `  - ${i.title} (${i.service}, ${formatRelativeTime(now, i.modifiedAt)})`,
    );
    const header = `- **${who}** — ${counts.length === 0 ? "no activity" : counts.join(", ")}`;
    return items.length === 0 ? header : `${header}\n${items.join("\n")}`;
  });
  return `Team huddle:\n${blocks.join("\n")}${gapsFooter(brief)}`;
}

// A downstream that did not answer is NOT a pass. This brief exists to inform
// deploy decisions, and a silent absence of failure is not a green light — so
// the two non-answers name themselves as unknown.
const PREFLIGHT_STATUS: Record<PreflightBrief["downstreams"][number]["status"], string> = {
  pass: "pass",
  fail: "FAIL",
  declined: "declined (no answer)",
  not_configured: "not configured (unknown)",
};

export function renderJanitor(brief: JanitorBrief): string {
  const target = `\`${brief.query.resourceRef}\``;
  const window = plural(brief.query.idleDays, "day");
  const lines: string[] = [
    brief.idle
      ? `${target} looks idle after ${window} with no activity.`
      : `${target} is still active within the last ${window}.`,
  ];

  if (brief.peersTouched.length > 0) {
    lines.push("", "### Recently touched by");
    for (const peer of brief.peersTouched) {
      const when =
        peer.lastSeenDaysAgo === null
          ? "at an unknown time"
          : `${plural(peer.lastSeenDaysAgo, "day")} ago`;
      lines.push(`- **${peer.who ?? "unattributed"}** — last seen ${when}`);
    }
  }
  if (brief.peersClear > 0) {
    lines.push("", `${plural(brief.peersClear, "peer")} reported no recent activity.`);
  }

  // Rendered, never run. Output is a suggestion, never an applied edit — the
  // rule the SCM trio already follows.
  if (brief.cleanupAction !== null) {
    lines.push(
      "",
      `Suggested cleanup: \`${brief.cleanupAction}\``,
      "",
      "_Nimbus never performs this. Run it yourself if you agree._",
    );
  }
  if (brief.proposalSuppressed) {
    lines.push("", "_No cleanup proposed: the agent suppressed it._");
  }
  return `${lines.join("\n")}${gapsFooter(brief)}`;
}

function preflightHeadline(brief: PreflightBrief, target: string): string {
  if (brief.anyFailed) return `Not safe to deploy ${target}: a downstream check failed.`;
  if (brief.anyIncomplete) return `Inconclusive for ${target}: some downstreams did not report.`;
  return `No failures reported for ${target}.`;
}

export function renderPreflight(brief: PreflightBrief): string {
  const target = `\`${brief.query.ref}\` in \`${brief.query.namespace}\``;
  const headline = preflightHeadline(brief, target);
  if (brief.downstreams.length === 0) {
    return `${headline}\n\nNo downstreams answered, so nothing was actually checked.${gapsFooter(brief)}`;
  }
  const lines = brief.downstreams.map(
    (d) => `- **${d.who ?? d.peerId}** — ${PREFLIGHT_STATUS[d.status]}: ${d.summary}`,
  );
  return `${headline}\n${lines.join("\n")}${gapsFooter(brief)}`;
}
