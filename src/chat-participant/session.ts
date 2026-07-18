// Key under which the Nimbus session id rides in ChatResult.metadata, so a
// conversation's follow-up turns thread the same server-side session. This keys
// the session to *this* VS Code conversation (history is per-conversation), so
// concurrent chat tabs never cross-talk — no global map, no cleanup.
export const NIMBUS_SESSION_META_KEY = "nimbusSessionId";

// Minimal structural shape of a history turn we read — matches
// vscode.ChatResponseTurn for the one field we use, so it is unit-testable with
// plain objects.
interface ResultTurnLike {
  result?: { metadata?: Record<string, unknown> };
}

// Walk history newest-first for the most recent turn carrying our session id.
export function readPriorSessionId(history: ReadonlyArray<unknown>): string | undefined {
  for (let i = history.length - 1; i >= 0; i--) {
    const turn = history[i] as ResultTurnLike;
    const v = turn?.result?.metadata?.[NIMBUS_SESSION_META_KEY];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

// Build the ChatResult.metadata for a turn that resolved `sessionId`.
export function toResultMetadata(sessionId: string | undefined): Record<string, string> {
  return sessionId !== undefined && sessionId.length > 0
    ? { [NIMBUS_SESSION_META_KEY]: sessionId }
    : {};
}
