import { asRecord } from "./parse-helpers.js";
import { formatRelativeTime } from "./relative-time.js";
import type { SidebarItem } from "./tree-view.js";

// The client types egress rows, but we parse defensively — consistent with the
// Audit view and resilient to shape drift. Mirrors the Gateway's EgressRow.
export interface EgressRow {
  id: number;
  timestamp: number;
  sourceType: string;
  sourceId: string | null;
  destination: string;
  method: string;
  payloadSummary: string;
  hitlStatus: string;
  resultStatus: string;
  rowHash: string;
  prevHash: string;
}

function str(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

// Coerce one unknown ledger row into a typed row, or undefined when it lacks the
// fields a row needs to render (a destination + method and a numeric timestamp).
export function parseEgressRow(raw: unknown): EgressRow | undefined {
  const rec = asRecord(raw);
  if (rec === undefined) return undefined;
  const destination = rec["destination"];
  const method = rec["method"];
  const timestamp = rec["timestamp"];
  if (typeof destination !== "string" || typeof method !== "string") return undefined;
  if (typeof timestamp !== "number") return undefined;
  return {
    id: typeof rec["id"] === "number" ? rec["id"] : 0,
    timestamp,
    sourceType: str(rec["sourceType"], ""),
    sourceId: typeof rec["sourceId"] === "string" ? rec["sourceId"] : null,
    destination,
    method,
    payloadSummary: str(rec["payloadSummary"], ""),
    hitlStatus: str(rec["hitlStatus"], "not_required"),
    resultStatus: str(rec["resultStatus"], "blocked"),
    rowHash: str(rec["rowHash"], ""),
    prevHash: str(rec["prevHash"], ""),
  };
}

// Icon keys off resultStatus — the security-relevant signal. Per the 0.4.0
// client types resultStatus is "authorized" | "blocked"; "dash" is only a
// defensive fallback for an unexpected value.
export function iconForResult(resultStatus: string): string {
  if (resultStatus === "authorized") return "pass";
  if (resultStatus === "blocked") return "error";
  return "dash";
}

export function egressRowToItem(row: EgressRow, now: number): SidebarItem {
  return {
    label: `${row.destination}.${row.method}`,
    description: formatRelativeTime(now, row.timestamp),
    tooltip: `${row.destination}.${row.method} · ${row.resultStatus} · consent ${row.hitlStatus}`,
    iconId: iconForResult(row.resultStatus),
    command: {
      command: "nimbus.openEgressEntry",
      title: "Open Egress Entry",
      arguments: [row],
    },
  };
}

// Read-only detail document for one row: a stable title and the full row
// (hashes included) with an added ISO timestamp. Accepts unknown so the command
// handler can pass a tree-item argument straight through.
export function formatEgressDetail(raw: unknown): { title: string; content: string } | undefined {
  const row = parseEgressRow(raw);
  if (row === undefined) return undefined;
  const body = { ...row, timestampIso: new Date(row.timestamp).toISOString() };
  return { title: `egress-${row.id}.json`, content: JSON.stringify(body, null, 2) };
}

export interface EgressWindowPreset {
  label: string;
  since?: number;
  until?: number;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const WEEK_MS = 604_800_000;

// Ordered prove-window presets. `until` is left open; "All time" has no bounds.
export function egressWindowPresets(now: number): EgressWindowPreset[] {
  return [
    { label: "Last hour", since: now - HOUR_MS },
    { label: "Last 24 hours", since: now - DAY_MS },
    { label: "Last 7 days", since: now - WEEK_MS },
    { label: "All time" },
  ];
}

// The proof artifact: the egressProveWindow result verbatim, named with an
// epoch-ms stamp (deterministic, filesystem-safe, sortable).
export function buildProofDocument(
  result: unknown,
  now: number,
): { filename: string; content: string } {
  return {
    filename: `egress-proof-${now}.json`,
    content: JSON.stringify(result, null, 2),
  };
}
