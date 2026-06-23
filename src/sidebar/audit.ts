import type { SidebarItem } from "./tree-view.js";

export type HitlStatus = "approved" | "rejected" | "not_required";

// The client's `auditList()` is typed as unknown[], so the extension parses
// rows defensively. This mirrors the Gateway's AuditEntry shape.
export interface AuditEntry {
  id: number;
  actionType: string;
  hitlStatus: HitlStatus;
  actionJson: string;
  timestamp: number;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function asHitlStatus(value: unknown): HitlStatus {
  return value === "approved" || value === "rejected" ? value : "not_required";
}

// Coerce one unknown audit row into a typed entry, or undefined when it lacks
// the fields a row needs to be rendered (an actionType and a timestamp).
export function parseAuditEntry(raw: unknown): AuditEntry | undefined {
  const rec = asRecord(raw);
  if (rec === undefined) return undefined;
  const actionType = rec["actionType"];
  const timestamp = rec["timestamp"];
  if (typeof actionType !== "string" || typeof timestamp !== "number") return undefined;
  return {
    id: typeof rec["id"] === "number" ? rec["id"] : 0,
    actionType,
    hitlStatus: asHitlStatus(rec["hitlStatus"]),
    actionJson: typeof rec["actionJson"] === "string" ? rec["actionJson"] : "",
    timestamp,
  };
}

const ICON_BY_STATUS: Record<HitlStatus, string> = {
  approved: "pass",
  rejected: "error",
  not_required: "dash",
};

export function iconForStatus(status: HitlStatus): string {
  return ICON_BY_STATUS[status];
}

const STATUS_LABEL: Record<HitlStatus, string> = {
  approved: "approved",
  rejected: "rejected",
  not_required: "no consent required",
};

// Compact "x ago" relative time. `now` is injected so callers/tests are
// deterministic. Future timestamps (clock skew) read as "just now".
export function formatRelativeTime(now: number, timestamp: number): string {
  const deltaSec = Math.floor((now - timestamp) / 1000);
  if (deltaSec < 5) return "just now";
  if (deltaSec < 60) return `${deltaSec}s ago`;
  const min = Math.floor(deltaSec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

export function auditEntryToItem(entry: AuditEntry, now: number): SidebarItem {
  return {
    label: entry.actionType,
    description: formatRelativeTime(now, entry.timestamp),
    tooltip: `${entry.actionType} · ${STATUS_LABEL[entry.hitlStatus]}`,
    iconId: iconForStatus(entry.hitlStatus),
    command: {
      command: "nimbus.openAuditEntry",
      title: "Open Audit Entry",
      arguments: [entry],
    },
  };
}

function prettyActionJson(actionJson: string): unknown {
  if (actionJson.length === 0) return null;
  try {
    return JSON.parse(actionJson);
  } catch {
    // Not valid JSON — surface the raw string rather than dropping it.
    return actionJson;
  }
}

// Build the read-only detail document for an audit entry: a stable title and a
// pretty-printed JSON body (with actionJson expanded inline). Accepts unknown
// so the command handler can pass a tree-item argument straight through.
export function formatAuditDetail(raw: unknown): { title: string; content: string } | undefined {
  const entry = parseAuditEntry(raw);
  if (entry === undefined) return undefined;
  const body = {
    id: entry.id,
    actionType: entry.actionType,
    hitlStatus: entry.hitlStatus,
    timestamp: entry.timestamp,
    timestampIso: new Date(entry.timestamp).toISOString(),
    action: prettyActionJson(entry.actionJson),
  };
  return {
    title: `audit-${entry.id}.json`,
    content: JSON.stringify(body, null, 2),
  };
}
