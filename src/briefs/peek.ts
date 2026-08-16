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

/** A `WhyPeek` reduced to display-ready fields. No markup, no links. */
export interface PeekFields {
  readonly author: string | undefined;
  readonly relativeTime: string | undefined;
  readonly shortSha: string | undefined;
  readonly commitSubject: string | undefined;
  readonly pr: { readonly label: string; readonly url?: string } | undefined;
  readonly ticket: { readonly label: string; readonly url?: string } | undefined;
}

// One interpretation of a WhyPeek, two renderings: the hover's markdown below
// and the context panel's rows. authorEmail is deliberately absent — it is a
// personal identifier the user did not ask to put on screen, and the name
// already attributes the line.
export function peekFields(peek: WhyPeek, now: number): PeekFields | undefined {
  if (peek.author === null && peek.commitSha === null && peek.pr === null && peek.ticket === null) {
    return undefined;
  }
  return {
    author: peek.author ?? undefined,
    relativeTime: peek.committedAt === null ? undefined : formatRelativeTime(now, peek.committedAt),
    shortSha: peek.commitSha === null ? undefined : shortSha(peek.commitSha),
    commitSubject: peek.commitSubject ?? undefined,
    pr:
      peek.pr === null
        ? undefined
        : {
            label: `PR #${peek.pr.number ?? "?"}`,
            ...(peek.pr.url === null ? {} : { url: peek.pr.url }),
          },
    ticket:
      peek.ticket === null
        ? undefined
        : {
            label: peek.ticket.key,
            ...(peek.ticket.url === null ? {} : { url: peek.ticket.url }),
          },
  };
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
  const fields = peekFields(peek, now);
  if (fields === undefined) return undefined;

  const head: string[] = [];
  if (fields.author !== undefined) head.push(`**${fields.author}**`);
  if (fields.relativeTime !== undefined) head.push(fields.relativeTime);
  if (fields.shortSha !== undefined) head.push(`\`${fields.shortSha}\``);

  const lines: string[] = [];
  if (head.length > 0) lines.push(head.join(" · "));
  if (fields.commitSubject !== undefined) lines.push(fields.commitSubject);

  const refs: string[] = [];
  if (fields.pr !== undefined) {
    refs.push(
      fields.pr.url === undefined ? fields.pr.label : `[${fields.pr.label}](${fields.pr.url})`,
    );
  }
  if (fields.ticket !== undefined) {
    refs.push(
      fields.ticket.url === undefined
        ? fields.ticket.label
        : `[${fields.ticket.label}](${fields.ticket.url})`,
    );
  }
  if (refs.length > 0) lines.push(refs.join(" · "));

  // subject.repoRoot is an absolute path on this machine; it is never rendered.
  lines.push(whyLink(target));
  return lines.join("\n\n");
}
