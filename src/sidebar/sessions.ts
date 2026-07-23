import { formatRelativeTime } from "./relative-time.js";
import type { SidebarItem } from "./tree-view.js";

// One persisted chat session, as summarised by the Gateway's session store
// (session_id, last write time, message count). Structurally identical to the
// client's SessionListEntry; owned here so the view module stays client-free.
export interface SessionSummary {
  sessionId: string;
  lastWriteAt: number;
  chunkCount: number;
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
