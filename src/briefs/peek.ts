import type { WhyPeek } from "@nimbus-dev/client";

import { formatRelativeTime } from "../sidebar/relative-time.js";
import type { EditorTarget } from "./params.js";

// WhyPeek → hover markdown. Pure: the vscode MarkdownString is built in
// real-hover.ts, which is also where `isTrusted` is set so the command link
// below is clickable.
//
// whyPeek is NOT a brief: no timeoutMs, no `brief` string, no AgentBriefBase.
// It is a synchronous git-and-index lookup that never reaches a model, which is
// what makes it safe to run on every mouse-rest and exempt from the egress gate.

const SHORT_SHA = 7;

function shortSha(sha: string): string {
  return sha.slice(0, SHORT_SHA);
}

// A vscode command link. Args must be a JSON *array* of the command's
// parameters, URI-encoded. The line stays 0-based — nimbus.brief.why converts
// via toOneBased, and pre-converting here would answer about the wrong line.
function whyLink(target: EditorTarget): string {
  const args = encodeURIComponent(JSON.stringify([{ ref: target.ref, line: target.line }]));
  return `[Why? →](command:nimbus.brief.why?${args})`;
}

export function renderPeek(peek: WhyPeek, target: EditorTarget, now: number): string | undefined {
  // Nothing resolved — decline the hover rather than render an empty box. This
  // is the common case until the repo root is indexed (`nimbus init`).
  if (peek.author === null && peek.commitSha === null && peek.pr === null && peek.ticket === null) {
    return undefined;
  }

  const head: string[] = [];
  if (peek.author !== null) head.push(`**${peek.author}**`);
  if (peek.committedAt !== null) head.push(formatRelativeTime(now, peek.committedAt));
  // authorEmail is deliberately never rendered: it is a personal identifier the
  // user did not ask to put on screen, and the name already attributes the line.
  if (peek.commitSha !== null) head.push(`\`${shortSha(peek.commitSha)}\``);

  const lines: string[] = [];
  if (head.length > 0) lines.push(head.join(" · "));
  if (peek.commitSubject !== null) lines.push(peek.commitSubject);

  const refs: string[] = [];
  if (peek.pr !== null) {
    const label = `PR #${peek.pr.number ?? "?"}`;
    refs.push(peek.pr.url === null ? label : `[${label}](${peek.pr.url})`);
  }
  if (peek.ticket !== null) {
    refs.push(
      peek.ticket.url === null ? peek.ticket.key : `[${peek.ticket.key}](${peek.ticket.url})`,
    );
  }
  if (refs.length > 0) lines.push(refs.join(" · "));

  // subject.repoRoot is an absolute path on this machine; it is never rendered.
  lines.push(whyLink(target));
  return lines.join("\n\n");
}
