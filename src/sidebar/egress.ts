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
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function proofRowsTable(rows: EgressRow[]): string {
  if (rows.length === 0) return "<p>No rows in this window.</p>";
  const body = rows
    .map((r) => {
      const action = `${r.destination}.${r.method}`;
      return (
        `<tr><td>${escapeHtml(new Date(r.timestamp).toISOString())}</td>` +
        `<td>${escapeHtml(action)}</td>` +
        `<td>${escapeHtml(r.resultStatus)}</td>` +
        `<td>${escapeHtml(r.hitlStatus)}</td></tr>`
      );
    })
    .join("\n");
  return `<table><thead><tr><th>Time (UTC)</th><th>Action</th><th>Result</th><th>Consent</th></tr></thead><tbody>${body}</tbody></table>`;
}

/**
 * The egress-bearing source classes, in the gateway's own key-sorted order
 * (`egress/egress-coverage.ts`). Listed in full, including classes at `none`,
 * because a reader has to be able to see what was NOT observed.
 */
const EGRESS_COVERAGE_CLASSES = [
  "http",
  "mcp",
  "model",
  "peer",
  "session",
  "sync",
  "task",
] as const;

const EGRESS_GRANULARITIES = new Set(["none", "per-run", "per-call"]);

/**
 * The completeness section of the proof artifact.
 *
 * Replaces a single line that read "Completeness tier: authorized-actions —
 * every gateway-authorized outbound action in the window, recorded before
 * dispatch." That sentence was wrong in two ways at once, which is why it is
 * gone rather than reworded:
 *
 *  - It asserted totality ("every ... outbound action") across ALL egress,
 *    while the gateway only ever observed the classes marked non-`none`. A
 *    class at `none` was never watched, and this document must not imply
 *    otherwise — this is a report someone hands to an auditor.
 *  - `tier` was a single scalar. The gateway now observes four classes at two
 *    different granularities, which no one string can describe; it was removed
 *    from the wire in @nimbus-dev/client 0.16.0.
 *
 * An `indeterminate` window prints NO count at all. A bare "0 events" when no
 * boot marker covers the window is the precise false-negative the whole
 * coverage mechanism exists to prevent.
 */
function renderCompleteness(completeness: Record<string, unknown>): string {
  const coverage = asRecord(completeness["coverage"]) ?? {};
  // Fail closed, matching @nimbus-dev/client's own reader: an absent or
  // non-boolean `indeterminate` reads as TRUE. A gateway too old to send the
  // field is exactly a gateway whose coverage this document cannot vouch for.
  const indeterminate =
    typeof completeness["indeterminate"] === "boolean" ? completeness["indeterminate"] : true;
  const events =
    typeof completeness["outboundEgressEvents"] === "number"
      ? completeness["outboundEgressEvents"]
      : undefined;

  const granularityOf = (cls: string): string => {
    const g = coverage[cls];
    // An unrecognised granularity understates rather than overstates.
    return typeof g === "string" && EGRESS_GRANULARITIES.has(g) ? g : "none";
  };

  const tableRows = EGRESS_COVERAGE_CLASSES.map((cls) => {
    const g = granularityOf(cls);
    const cell = g === "none" ? `<em>not observed</em>` : escapeHtml(g);
    return `<tr><td><code>${escapeHtml(cls)}</code></td><td>${cell}</td></tr>`;
  }).join("");
  const table = `<table><thead><tr><th>Egress class</th><th>Coverage</th></tr></thead><tbody>${tableRows}</tbody></table>`;

  if (indeterminate) {
    return (
      `<p class="bad">Completeness: INDETERMINATE — no boot marker covers this window, so there is no evidence that any egress class was being observed.</p>` +
      `<p>Any count of rows below is therefore <strong>not</strong> evidence that nothing left the machine.</p>${table}`
    );
  }

  const observed = EGRESS_COVERAGE_CLASSES.filter((c) => granularityOf(c) !== "none");
  const observedList = observed.map((c) => `<code>${escapeHtml(c)}</code>`).join(", ");
  const scope =
    observed.length === 0 ? "no egress class was observed" : `observed classes: ${observedList}`;
  const eventNoun = events === 1 ? "event" : "events";
  const countText =
    events === undefined
      ? "The event count is absent from this response."
      : `<strong>${events}</strong> authorized outbound ${eventNoun} recorded before dispatch.`;
  return `<p>Completeness: ${countText} This covers ${scope} only — a class marked <em>not observed</em> below was never watched, and this document makes no claim about it.</p>${table}`;
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
  const completenessBlock = renderCompleteness(completeness);
  const verifyOk = verify["ok"] === true;
  const verifiedRows = typeof verify["verifiedRows"] === "number" ? verify["verifiedRows"] : 0;
  // `</script>`-safe: escape `<` inside the JSON payload; JSON.parse restores it.
  const embedded = JSON.stringify(result, null, 2).replaceAll("<", String.raw`\u003c`);
  const receiptBlock =
    receipt === undefined
      ? "<p>No signed receipt attached (no signing key configured).</p>"
      : `<dl><dt>Digest</dt><dd><code>${escapeHtml(str(receipt["digest"], ""))}</code></dd>` +
        `<dt>Signature (Ed25519, base64)</dt><dd><code>${escapeHtml(str(receipt["sigB64"], ""))}</code></dd>` +
        `<dt>Public key (base64)</dt><dd><code>${escapeHtml(str(receipt["pubkeyB64"], ""))}</code></dd></dl>`;
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
${completenessBlock}
<p>Generated ${escapeHtml(new Date(now).toISOString())}.</p>
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
