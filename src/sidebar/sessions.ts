import { asFiniteNumber, asRecord } from "./parse-helpers.js";
import { formatRelativeTime } from "./relative-time.js";
import type { SidebarItem } from "./tree-view.js";

// One persisted chat session, as summarised by the Gateway's session store
// (session_id, last write time, message count).
export interface SessionSummary {
  sessionId: string;
  lastWriteAt: number;
  chunkCount: number;
}

// Coerce one query row (or any unknown) into a SessionSummary, or undefined
// when it lacks a usable session id / timestamp.
export function parseSessionRow(raw: unknown): SessionSummary | undefined {
  const rec = asRecord(raw);
  if (rec === undefined) return undefined;
  const sessionId = rec["sessionId"];
  const lastWriteAt = rec["lastWriteAt"];
  if (typeof sessionId !== "string" || sessionId.length === 0) return undefined;
  if (typeof lastWriteAt !== "number" || !Number.isFinite(lastWriteAt)) return undefined;
  return { sessionId, lastWriteAt, chunkCount: asFiniteNumber(rec["chunkCount"]) ?? 0 };
}

function shortId(sessionId: string): string {
  return sessionId.length > 12 ? sessionId.slice(0, 8) : sessionId;
}

export function sessionToItem(summary: SessionSummary, now: number): SidebarItem {
  const msgs = `${summary.chunkCount} msg${summary.chunkCount === 1 ? "" : "s"}`;
  return {
    label: `Session ${shortId(summary.sessionId)}`,
    description: `${formatRelativeTime(now, summary.lastWriteAt)} · ${msgs}`,
    tooltip: `${summary.sessionId}\nLast active ${new Date(summary.lastWriteAt).toISOString()} · ${msgs}`,
    iconId: "comment-discussion",
    command: {
      command: "nimbus.openSession",
      title: "Open Session",
      arguments: [summary.sessionId],
    },
  };
}
