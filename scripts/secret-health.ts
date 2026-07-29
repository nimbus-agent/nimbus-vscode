/**
 * Classifies the weekly publish-credential probes into a verdict per credential,
 * and renders the report `secret-health.yml` files.
 *
 * The one thing this file exists to keep apart:
 *
 * - **Rejected** — the marketplace answered "no" to a token we sent it, just now.
 *   Something IS broken; a release is blocked today.
 * - **Dated** — a token still authenticates, and a *calendar* says it will stop
 *   working on a known date. Nothing is broken; there is work to schedule.
 *
 * Those two need opposite responses (rotate now vs. put it in the calendar) and
 * for most of the year the dated one is true while the rejected one is not. If
 * both render the same, the standing dated signal trains the reader to skim, and
 * the rejected one arrives into a channel nobody reads any more. So they never
 * share a heading, a colour, or a remedy sentence.
 */

/** The probe action's documented outputs. Anything else is unrecognised and fails closed. */
const KNOWN_PROBE_STATUSES = ["ok", "dead", "not-configured", "indeterminate"] as const;

export type Verdict =
  /** The marketplace rejected a configured token. Rotate. */
  | "dead"
  /** The secret is absent entirely. Provision — there is nothing to rotate. */
  | "not-configured"
  /** The probe reported something this gate does not understand. Fail closed. */
  | "unrecognised"
  /** Authenticates, but the recorded expiry has already passed — the record is wrong. */
  | "expiry-overdue"
  /** Authenticates, and the recorded expiry is inside the replacement window. */
  | "expiry-critical"
  /** Authenticates, and the recorded expiry is on the horizon. Schedule it. */
  | "expiry-approaching"
  /** The probe could not reach the service. NOT evidence of revocation. */
  | "unreachable"
  | "ok";

export type Severity = "hard" | "warn" | "healthy";

/**
 * Known hard expiries, keyed by secret name.
 *
 * **MIRROR — not the source of truth.** The authority is
 * `scripts/release/credential-registry.ts` in `nimbus-agent/Nimbus`, whose weekly
 * monitor audits this repo's secrets org-wide. This copy exists only so *this*
 * repo's own alert can tell an approaching expiry apart from a dead token
 * without a cross-repo network call inside a credential monitor.
 *
 * If the two ever disagree, the registry wins. The blast radius of drift is
 * bounded on purpose: a stale date here can produce a spurious *warning*, never
 * a false "healthy" — the liveness probe is what decides whether a token works,
 * and it is never softened by anything in this file.
 *
 * When a token is regenerated, update the registry first, then this line.
 */
export const DECLARED_EXPIRY: Readonly<Record<string, string>> = {
  // Azure DevOps PAT, org-scoped to `asafgolombek`. Its own expiry — deliberately
  // NOT the 2026-12-01 global-PAT decommission, which does not apply to an
  // org-scoped token. See nimbus-vscode#34.
  VSCE_PAT: "2026-09-20",
  // OVSX_PAT has no hard expiry date; Open VSX offers no OIDC path, so it is
  // rotated on a cadence rather than against a deadline. Absent from this map on
  // purpose — an unlisted credential is simply never dated.
};

/** Mirrors `HARD_DEADLINE_LEAD_DAYS` in the Nimbus credential registry. */
export const EXPIRY_LEAD_DAYS = 90;

/**
 * Mirrors `HARD_DEADLINE_CRITICAL_DAYS` in the Nimbus credential registry: the
 * point where a date stops being scheduled work and becomes a failure.
 *
 * 14 days is two runs of this workflow's weekly cron, so one lost or evicted
 * scheduled run still leaves an alarm while the token is alive. 7 would leave
 * exactly one; 21 would buy a third run at the price of a third week of standing
 * red, and standing red is the failure mode this split exists to prevent.
 */
export const EXPIRY_CRITICAL_DAYS = 14;

const MS_PER_DAY = 86_400_000;

/** Whole days from `now` to `iso` (negative once the date has passed). */
export function daysUntil(iso: string, now: Date): number {
  return Math.floor((new Date(`${iso}T00:00:00Z`).getTime() - now.getTime()) / MS_PER_DAY);
}

/**
 * Severity, ordered most urgent first. `verdictFor` resolves a probe verdict and
 * a calendar verdict by taking whichever appears earlier here, so the ordering
 * is the tie-break rule, written once.
 */
const PRECEDENCE: readonly Verdict[] = [
  "dead",
  "not-configured",
  "unrecognised",
  "expiry-overdue",
  "expiry-critical",
  // Above `expiry-approaching` deliberately: "we could not check" is a more
  // urgent operational fact than "a date is 60 days out".
  "unreachable",
  "expiry-approaching",
  "ok",
];

export function severityOf(verdict: Verdict): Severity {
  switch (verdict) {
    // Both tokens are REQUIRED to publish, so a missing one is as blocking as a
    // rejected one — reported separately because the remedies are opposites.
    case "dead":
    case "not-configured":
    case "unrecognised":
    case "expiry-overdue":
    case "expiry-critical":
      return "hard";
    case "unreachable":
    case "expiry-approaching":
      return "warn";
    case "ok":
      return "healthy";
    default:
      return unclassified(verdict);
  }
}

/**
 * The `never` parameter makes omitting a case above a COMPILE error; the body
 * covers a value that reached us past the type system and fails it closed.
 */
function unclassified(verdict: never): Severity {
  console.error(
    `secret-health: unclassified verdict ${JSON.stringify(verdict)} — treating as hard`,
  );
  return "hard";
}

/** What the live probe alone says. Never softened by any date. */
export function classifyProbe(status: string): Verdict {
  // Anything outside the action's documented output set — an empty string from a
  // renamed step id, an `id:` typo, or an action-ref bump landing an
  // incompatible version — is `unrecognised`. Never healthy, never a mere blip.
  if (!(KNOWN_PROBE_STATUSES as readonly string[]).includes(status)) return "unrecognised";
  if (status === "dead") return "dead";
  if (status === "not-configured") return "not-configured";
  if (status === "indeterminate") return "unreachable";
  return "ok";
}

/** What the calendar alone says about a credential that still authenticates. */
export function classifyExpiry(expiryIso: string | undefined, now: Date): Verdict {
  if (expiryIso === undefined) return "ok";
  const remaining = daysUntil(expiryIso, now);
  if (remaining < 0) return "expiry-overdue";
  if (remaining <= EXPIRY_CRITICAL_DAYS) return "expiry-critical";
  if (remaining <= EXPIRY_LEAD_DAYS) return "expiry-approaching";
  return "ok";
}

/**
 * The single verdict for one credential.
 *
 * A rejected, absent, or unrecognised probe short-circuits: it is already the
 * worst news available, and no date may soften it. `dead` in particular can
 * never be downgraded by this function — a token the marketplace refuses is
 * broken today whether or not its recorded expiry is comfortably far away.
 */
export function verdictFor(probeStatus: string, expiryIso: string | undefined, now: Date): Verdict {
  const probe = classifyProbe(probeStatus);
  if (probe === "dead" || probe === "not-configured" || probe === "unrecognised") return probe;
  const calendar = classifyExpiry(expiryIso, now);
  const rank = (v: Verdict): number => {
    const i = PRECEDENCE.indexOf(v);
    return i < 0 ? 0 : i;
  };
  return rank(probe) <= rank(calendar) ? probe : calendar;
}

/**
 * The remedy sentence, per verdict.
 *
 * Written per-row rather than as one shared paragraph listing every possibility,
 * because a paragraph that explains both "rotate" and "do not rotate" leaves the
 * reader to work out which one applies at 3am.
 */
export function remedyFor(
  verdict: Verdict,
  name: string,
  expiryIso: string | undefined,
  now: Date,
): string {
  const dated = expiryIso === undefined ? "" : ` recorded expiry ${expiryIso}`;
  switch (verdict) {
    case "dead":
      return `**ROTATE NOW.** The marketplace REJECTED this configured token — it is revoked or expired as of this run. Generate a replacement and update the \`${name}\` secret. The next extension release is blocked until you do.`;
    case "not-configured":
      return `**PROVISION.** The \`${name}\` secret is absent entirely. Do **not** rotate — there is no credential to rotate. Create the token and add the secret.`;
    case "unrecognised":
      return `**DIAGNOSE.** The probe returned a value this gate does not recognise, so nothing about \`${name}\` has been established. Treat it as equally urgent to a rejection until you know otherwise — check the probe action's ref and its output names.`;
    case "expiry-overdue":
      return `**CORRECT THE RECORD.** \`${name}\` still authenticates, but${dated} has already passed by ${Math.abs(daysUntil(expiryIso ?? "", now))}d. Nothing is rejected — either the token was regenerated without updating \`credential-registry.ts\` in nimbus-agent/Nimbus (fix the date there, then the mirror in \`scripts/secret-health.ts\`), or the recorded date was wrong. Do not rotate blindly.`;
    case "expiry-critical":
      return `**REPLACE THIS WEEK.** \`${name}\` still authenticates and has NOT been rejected —${dated} is ${daysUntil(expiryIso ?? "", now)}d away, which is inside the replacement window. This is a scheduled expiry that has run out of runway, not a revocation.`;
    case "expiry-approaching":
      return `Scheduled work, nothing is broken. \`${name}\` authenticates normally;${dated} is ${daysUntil(expiryIso ?? "", now)}d away and escalates to a failure at ${EXPIRY_CRITICAL_DAYS}d. Put the regeneration in the calendar — do not treat this as a rotation emergency.`;
    case "unreachable":
      return `The probe could not reach the service, so \`${name}\`'s state is UNKNOWN. This is not evidence of revocation and must not be actioned as one; re-run the workflow.`;
    case "ok":
      return "Authenticates, and no recorded expiry is within the warning window.";
    default:
      return unreachableRemedy(verdict);
  }
}

function unreachableRemedy(verdict: never): string {
  return `Unclassified verdict ${JSON.stringify(verdict)} — treat as broken.`;
}

export interface CredentialProbe {
  readonly name: string;
  readonly probeStatus: string;
}

export interface CredentialRow {
  readonly name: string;
  readonly probeStatus: string;
  readonly verdict: Verdict;
  readonly severity: Severity;
  readonly remedy: string;
}

export function evaluate(
  probes: readonly CredentialProbe[],
  now: Date,
  expiries: Readonly<Record<string, string>> = DECLARED_EXPIRY,
): CredentialRow[] {
  return probes.map((p) => {
    const expiryIso = expiries[p.name];
    const verdict = verdictFor(p.probeStatus, expiryIso, now);
    return {
      name: p.name,
      probeStatus: p.probeStatus,
      verdict,
      severity: severityOf(verdict),
      remedy: remedyFor(verdict, p.name, expiryIso, now),
    };
  });
}

export const BROKEN_HEADING = "## ❌ BROKEN — rejected, absent, or out of runway";
export const SCHEDULED_HEADING = "## 🟡 SCHEDULED — dated work; nothing here is broken";
export const HEALTHY_HEADING = "## ✅ Healthy";

function tableFor(rows: readonly CredentialRow[]): string {
  return [
    "| Credential | Probe | Verdict | What to do |",
    "|---|---|---|---|",
    ...rows.map((r) => `| \`${r.name}\` | \`${r.probeStatus}\` | \`${r.verdict}\` | ${r.remedy} |`),
  ].join("\n");
}

/**
 * The report body.
 *
 * Sectioned rather than flat for the same reason the Nimbus monitor is: a dated
 * row can be true for 76 consecutive days, and in a flat table a token that died
 * overnight would arrive looking exactly like it — same shape, same place, one
 * word different. Under sections a rejection appears beneath a heading that was
 * empty, and a dated row can never appear there.
 */
export function renderBody(rows: readonly CredentialRow[]): string {
  const hard = rows.filter((r) => r.severity === "hard");
  const warn = rows.filter((r) => r.severity === "warn");
  const healthy = rows.filter((r) => r.severity === "healthy");
  const parts: string[] = [
    `**BROKEN: ${hard.length} · scheduled: ${warn.length} · healthy: ${healthy.length}**`,
    `${BROKEN_HEADING} (${hard.length})`,
    "Every row here has been rejected by the marketplace, is missing entirely, or has run out of the runway a replacement needs. These block the next extension release.",
    hard.length === 0 ? "_None._" : tableFor(hard),
    `${SCHEDULED_HEADING} (${warn.length})`,
    `Nothing here has been rejected by anything. A dated row moves up into BROKEN at ${EXPIRY_CRITICAL_DAYS} days out.`,
    warn.length === 0 ? "_None._" : tableFor(warn),
  ];
  if (healthy.length > 0) {
    parts.push(`${HEALTHY_HEADING} (${healthy.length})`, tableFor(healthy));
  }
  parts.push(
    [
      "> **Reading this report.** A `dead` verdict comes from a **live probe**: the marketplace",
      "> rejected the token during this run. An `expiry-*` verdict comes from the **calendar**",
      "> mirrored in `scripts/secret-health.ts` from `scripts/release/credential-registry.ts` in",
      "> nimbus-agent/Nimbus, which is the source of truth: the token still authenticates and the",
      "> date is when it is expected to stop. They are different findings with opposite remedies",
      "> and never share a section.",
    ].join("\n"),
  );
  return parts.join("\n\n");
}

// GitHub workflow commands are recognised only at the start of a line, so every
// CR/LF in interpolated text must be encoded or a row could begin a command of
// its own. `%` goes first, or the later escapes' own percent signs are
// double-encoded.
function escapeData(value: string): string {
  return value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}

function escapeProperty(value: string): string {
  return escapeData(value).replaceAll(":", "%3A").replaceAll(",", "%2C");
}

/**
 * One annotation per non-healthy row, at a level matching its severity — so the
 * run page separates dated from rejected even for a reader who never opens the
 * issue.
 */
export function annotationsFor(rows: readonly CredentialRow[]): string[] {
  const lines: string[] = [];
  for (const r of rows) {
    if (r.severity === "healthy") continue;
    const level = r.severity === "hard" ? "error" : "warning";
    const title = r.severity === "hard" ? "BROKEN credential" : "Scheduled credential work";
    lines.push(
      `::${level} title=${escapeProperty(`${title}: ${r.name}`)}::${escapeData(
        `${r.name} — ${r.verdict} — ${r.remedy}`,
      )}`,
    );
  }
  return lines;
}

export function hasHardFailure(rows: readonly CredentialRow[]): boolean {
  return rows.some((r) => r.severity === "hard");
}

export function hasWarning(rows: readonly CredentialRow[]): boolean {
  return rows.some((r) => r.severity === "warn");
}

// --- entry point ---

/* c8 ignore start -- thin env/FS shell over the pure functions above */
if (import.meta.main) {
  const { appendFileSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");

  const rows = evaluate(
    [
      { name: "VSCE_PAT", probeStatus: process.env["VSCE_STATUS"] ?? "" },
      { name: "OVSX_PAT", probeStatus: process.env["OVSX_STATUS"] ?? "" },
    ],
    new Date(),
  );
  const body = renderBody(rows);

  for (const line of annotationsFor(rows)) console.log(line);
  console.log(body);

  const stepSummary = process.env["GITHUB_STEP_SUMMARY"];
  if (stepSummary) appendFileSync(stepSummary, `# Publish credential health\n\n${body}\n`);

  // The body reaches `gh` through a FILE, never through an argument or an
  // `$GITHUB_OUTPUT` value: it is multi-line markdown, and both of those
  // channels mangle or truncate it.
  const bodyFile = join(process.env["RUNNER_TEMP"] ?? tmpdir(), "secret-health-body.md");
  writeFileSync(bodyFile, body, "utf8");

  const out = process.env["GITHUB_OUTPUT"];
  if (out) {
    appendFileSync(
      out,
      `hard=${hasHardFailure(rows)}\nwarn=${hasWarning(rows)}\nbody_file=${bodyFile}\n`,
    );
  }
  // Always exit 0: the workflow's reporting step decides the job's outcome, so
  // that a hard verdict still gets its issue filed before the job goes red.
  process.exitCode = 0;
}
/* c8 ignore stop */
