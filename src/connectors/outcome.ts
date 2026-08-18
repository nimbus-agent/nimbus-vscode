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
// Calibrated against observed Gateway denial messages during the F5 pass.
const DENIAL = /\bnot approved\b|(?=.*\b(?:denied|rejected|expired|timed out)\b)(?=.*\b(?:consent|HITL|approval|owner)\b)/i;

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
  return DENIAL.test(message) ? { kind: "denied", reason: message } : { kind: "failed", message };
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
