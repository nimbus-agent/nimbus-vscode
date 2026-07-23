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
  // A blocked row is not noise — it is the ledger's proof that an action was
  // stopped BEFORE dispatch (the fail-closed half of the egress story), so it
  // renders as loudly as an authorized one renders quietly.
  const blocked = row.resultStatus === "blocked";
  const when = formatRelativeTime(now, row.timestamp);
  return {
    label: `${blocked ? "⛔ " : ""}${row.destination}.${row.method}`,
    description: blocked ? `blocked · ${when}` : when,
    tooltip: blocked
      ? `${row.destination}.${row.method} · blocked · consent ${row.hitlStatus} — proof of denial: stopped before dispatch`
      : `${row.destination}.${row.method} · ${row.resultStatus} · consent ${row.hitlStatus}`,
    iconId: iconForResult(row.resultStatus),
    ...(blocked ? { contextValue: "nimbusEgressDenial" } : {}),
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

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function proofRowsTable(rows: EgressRow[]): string {
  if (rows.length === 0) return "<p>No rows in this window.</p>";
  const body = rows
    .map(
      (r) =>
        `<tr><td>${escapeHtml(new Date(r.timestamp).toISOString())}</td>` +
        `<td>${escapeHtml(`${r.destination}.${r.method}`)}</td>` +
        `<td>${escapeHtml(r.resultStatus)}</td>` +
        `<td>${escapeHtml(r.hitlStatus)}</td></tr>`,
    )
    .join("\n");
  return `<table><thead><tr><th>Time (UTC)</th><th>Action</th><th>Result</th><th>Consent</th></tr></thead><tbody>${body}</tbody></table>`;
}

// The proof artifact: a SELF-CONTAINED HTML report (inline CSS, no external
// requests) presenting the egressProveWindow result, with the raw RPC JSON
// embedded verbatim for machine verification. In-file BLAKE3/Ed25519
// verification is deliberately out of scope — the artifact points at
// `nimbus egress verify` / `nimbus prove` instead. Named with an epoch-ms
// stamp (deterministic, filesystem-safe, sortable).
export function buildProofDocument(
  result: unknown,
  now: number,
): { filename: string; content: string } {
  const rec = asRecord(result) ?? {};
  const rawRows = Array.isArray(rec["rows"]) ? rec["rows"] : [];
  const rows = rawRows.map(parseEgressRow).filter((r): r is EgressRow => r !== undefined);
  const completeness = asRecord(rec["completeness"]) ?? {};
  const verify = asRecord(rec["verify"]) ?? {};
  const receipt = asRecord(rec["receipt"]);
  const tier = typeof completeness["tier"] === "string" ? completeness["tier"] : "unknown";
  const verifyOk = verify["ok"] === true;
  const verifiedRows = typeof verify["verifiedRows"] === "number" ? verify["verifiedRows"] : 0;
  // `</script>`-safe: escape `<` inside the JSON payload; JSON.parse restores it.
  const embedded = JSON.stringify(result, null, 2).replace(/</g, "\\u003c");
  const receiptBlock =
    receipt === undefined
      ? "<p>No signed receipt attached (no signing key configured).</p>"
      : `<dl><dt>Digest</dt><dd><code>${escapeHtml(String(receipt["digest"] ?? ""))}</code></dd>` +
        `<dt>Signature (Ed25519, base64)</dt><dd><code>${escapeHtml(String(receipt["sigB64"] ?? ""))}</code></dd>` +
        `<dt>Public key (base64)</dt><dd><code>${escapeHtml(String(receipt["pubkeyB64"] ?? ""))}</code></dd></dl>`;
  const verifyBadge = verifyOk
    ? `<p class="ok">Whole-ledger chain verify: OK (${verifiedRows} rows)</p>`
    : `<p class="bad">Whole-ledger chain verify: FAILED — this window claim is NOT sound</p>`;
  const content = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Nimbus egress proof</title>
<style>
body { font-family: system-ui, sans-serif; margin: 2rem auto; max-width: 60rem; color: #1a1a1a; }
table { border-collapse: collapse; width: 100%; } th, td { border: 1px solid #ccc; padding: 4px 8px; text-align: left; font-size: 0.9rem; }
.ok { color: #116329; font-weight: 600; } .bad { color: #a40e26; font-weight: 700; }
code { background: #f2f2f2; padding: 1px 4px; word-break: break-all; }
</style>
</head>
<body>
<h1>Nimbus egress proof</h1>
<p>Completeness tier: <strong>${escapeHtml(tier)}</strong> — every gateway-authorized outbound action in the window, recorded before dispatch. Generated ${escapeHtml(new Date(now).toISOString())}.</p>
${verifyBadge}
<h2>Rows in window (${rows.length})</h2>
${proofRowsTable(rows)}
<h2>Signed receipt</h2>
${receiptBlock}
<h2>How to verify</h2>
<p>On any machine with the ledger: <code>nimbus egress verify</code> re-walks the BLAKE3 hash chain; <code>nimbus prove</code> re-derives this window. The machine-readable proof below is byte-equivalent to the gateway's <code>egress.proveWindow</code> response.</p>
<script type="application/json" id="nimbus-egress-proof">${embedded}</script>
</body>
</html>
`;
  return { filename: `egress-proof-${now}.html`, content };
}
