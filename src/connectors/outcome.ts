import type { GatedRejection } from "@nimbus-dev/client";

import { errMsg } from "../logging.js";

/**
 * One outcome for twelve RPCs that report failure four different ways:
 * `{ok:false}` resolves, a consent denial RESOLVES as GatedRejection for
 * addMcp/remove but REJECTS for a full reindex, and a real error rejects.
 * `denied` is a decision, not a breakage — the distinction the wording relies on.
 */
export type ConnectorOutcome =
  | { kind: "applied"; detail?: string }
  | { kind: "denied"; reason: string }
  | { kind: "failed"; message: string };

// Whether a REJECTED promise is a consent denial rather than a fault. Only the
// full-depth reindex path can produce one, and the client gives us no code to
// key on, so this is a heuristic over the message — deliberately conservative,
// biased to "failed": mislabelling a genuine error as a denial would invent a
// user decision; a real denial misread as a failure still carries the Gateway's
// reason verbatim. Bare "denied" or "rejected" match only with consent-domain
// context (consent/HITL/approval/owner), or accept standalone "not approved".
// Not yet calibrated against a real Gateway's denial messages — that is
// pending, in the F5 pass this surface has not had yet.
//
// Three independent literal alternations, never one regex with lookaheads. The
// pattern this replaced paired two `(?=.*\b…\b)` lookaheads, and `test` retries
// every start offset: each retry re-scanned the remainder of the line, so the
// cost grew with the SQUARE of the message length. A 120 KB rejection message —
// a stack trace, a proxy body echoed back — took ~10s to classify and blocked
// the extension host for all of it. Each pattern below is a bounded literal
// alternation: linear, with no ambiguity to backtrack over.
const NOT_APPROVED = /\bnot approved\b/i;
const DENIAL_WORD = /\b(?:denied|rejected|expired|timed out)\b/i;
const CONSENT_WORD = /\b(?:consent|HITL|approval|owner)\b/i;

// The two halves must meet on the SAME line, which is exactly what the
// lookaheads enforced: `.` never matches a line terminator, so a "rejected" on
// one line and an "approval" on another was never evidence of one denial, and
// must not become one now. These four are precisely the terminators `.`
// excludes in JavaScript.
const LINE_TERMINATOR = /[\n\r\u2028\u2029]/;

function isDenial(message: string): boolean {
  if (NOT_APPROVED.test(message)) return true;
  for (const line of message.split(LINE_TERMINATOR)) {
    if (DENIAL_WORD.test(line) && CONSENT_WORD.test(line)) return true;
  }
  return false;
}

export function fromOk(r: { ok: boolean }, detail?: string): ConnectorOutcome {
  if (!r.ok) return { kind: "failed", message: "The Gateway did not apply the change." };
  return detail === undefined ? { kind: "applied" } : { kind: "applied", detail };
}

export function fromGated<T extends { ok: true }>(
  r: T | GatedRejection,
  detail: (ok: T) => string,
): ConnectorOutcome {
  // Narrow on "status" exactly as the client's JSDoc instructs.
  if ("status" in r) return { kind: "denied", reason: r.reason };
  const text = detail(r);
  return text === "" ? { kind: "applied" } : { kind: "applied", detail: text };
}

export function fromThrown(e: unknown): ConnectorOutcome {
  const message = errMsg(e);
  return isDenial(message) ? { kind: "denied", reason: message } : { kind: "failed", message };
}

/** `verb` is the gerund of the action: "Removing", "Pausing", "Syncing". */
export function describeOutcome(verb: string, serviceId: string, o: ConnectorOutcome): string {
  switch (o.kind) {
    case "applied":
      return o.detail === undefined
        ? `${verb} ${serviceId}: done`
        : `${verb} ${serviceId}: done — ${o.detail}`;
    case "denied":
      return `${verb} ${serviceId} was not approved: ${o.reason}`;
    case "failed":
      return `${verb} ${serviceId} failed: ${o.message}`;
  }
}
