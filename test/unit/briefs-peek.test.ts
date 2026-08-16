import type { WhyPeek } from "@nimbus-dev/client";
import { describe, expect, test } from "vitest";

import { peekFields, renderPeek } from "../../src/briefs/peek.js";

const NOW = 1_000_000_000_000;
const TARGET = { ref: "src/auth/session.ts", line: 41 };

const EMPTY = {
  subject: null,
  author: null,
  authorEmail: null,
  commitSha: null,
  committedAt: null,
  commitSubject: null,
  pr: null,
  ticket: null,
  hasMore: false,
};

function peek(over: Partial<WhyPeek> = {}): WhyPeek {
  return {
    subject: { repoRoot: "/home/dev/proj", filePath: "src/auth/session.ts", lineNo: 42 },
    author: "Robin Hale",
    authorEmail: "robin@example.test",
    commitSha: "a1b2c3d4e5f6",
    committedAt: NOW - 3 * 60 * 60 * 1000,
    commitSubject: "fix: clear the retry loop",
    pr: { number: 412, title: "Rework session refresh", url: "https://example.test/pr/412" },
    ticket: {
      key: "NIM-88",
      title: "Session drops under load",
      url: "https://example.test/NIM-88",
    },
    hasMore: true,
    ...over,
  };
}

describe("peekFields", () => {
  test("declines when nothing resolved", () => {
    expect(peekFields(EMPTY, 1_000)).toBeUndefined();
  });

  test("shortens the sha to seven characters", () => {
    const fields = peekFields({ ...EMPTY, commitSha: "abcdef1234567890" }, 1_000);
    expect(fields?.shortSha).toBe("abcdef1");
  });

  test("formats the commit time relative to now", () => {
    const fields = peekFields({ ...EMPTY, author: "Ada", committedAt: 0 }, 60_000);
    expect(fields?.author).toBe("Ada");
    expect(fields?.relativeTime).toBeDefined();
  });

  test("labels a PR by number and a ticket by key, carrying their urls", () => {
    const fields = peekFields(
      {
        ...EMPTY,
        pr: { number: 42, title: "t", url: "https://example.test/pr/42" },
        ticket: { key: "OPS-7", title: "t", url: null },
      },
      1_000,
    );
    expect(fields?.pr).toEqual({ label: "PR #42", url: "https://example.test/pr/42" });
    expect(fields?.ticket).toEqual({ label: "OPS-7" });
  });

  test("never exposes the author email — it is a personal identifier nobody asked to display", () => {
    const fields = peekFields({ ...EMPTY, author: "Ada", authorEmail: "ada@example.test" }, 1_000);
    expect(JSON.stringify(fields)).not.toContain("ada@example.test");
  });
});

describe("renderPeek", () => {
  test("leads with author, age and short sha", () => {
    const out = renderPeek(peek(), TARGET, NOW) ?? "";
    expect(out).toContain("**Robin Hale**");
    expect(out).toContain("3h ago");
    expect(out).toContain("`a1b2c3d`");
  });

  test("shows the commit subject", () => {
    expect(renderPeek(peek(), TARGET, NOW) ?? "").toContain("fix: clear the retry loop");
  });

  test("links the PR and the ticket when they carry a url", () => {
    const out = renderPeek(peek(), TARGET, NOW) ?? "";
    expect(out).toContain("[PR #412](https://example.test/pr/412)");
    expect(out).toContain("[NIM-88](https://example.test/NIM-88)");
  });

  test("renders a PR or ticket without a url as plain text, not a broken link", () => {
    const out =
      renderPeek(
        peek({
          pr: { number: 7, title: "x", url: null },
          ticket: { key: "NIM-1", title: "y", url: null },
        }),
        TARGET,
        NOW,
      ) ?? "";
    expect(out).toContain("PR #7");
    expect(out).toContain("NIM-1");
    expect(out).not.toContain("](null)");
    expect(out).not.toContain("[PR #7]");
  });

  // The link must carry the location the user actually hovered, so the full
  // brief never re-asks for it — and it must be 0-based, because
  // nimbus.brief.why applies toOneBased itself. Double-converting would answer
  // about the wrong line.
  test("the Why link carries the raw 0-based target as encoded command args", () => {
    const out = renderPeek(peek(), TARGET, NOW) ?? "";
    const expected = encodeURIComponent(JSON.stringify([{ ref: "src/auth/session.ts", line: 41 }]));
    expect(out).toContain(`command:nimbus.brief.why?${expected}`);
  });

  test("never echoes the absolute repoRoot", () => {
    expect(renderPeek(peek(), TARGET, NOW) ?? "").not.toContain("/home/dev/proj");
  });

  test("never echoes the author's email", () => {
    expect(renderPeek(peek(), TARGET, NOW) ?? "").not.toContain("robin@example.test");
  });

  test("declines entirely when the Gateway resolved nothing", () => {
    expect(
      renderPeek(
        peek({
          subject: null,
          author: null,
          commitSha: null,
          committedAt: null,
          commitSubject: null,
          pr: null,
          ticket: null,
          hasMore: false,
        }),
        TARGET,
        NOW,
      ),
    ).toBeUndefined();
  });

  test("renders what it has when only some fields resolved", () => {
    const out =
      renderPeek(
        peek({ pr: null, ticket: null, commitSubject: null, committedAt: null }),
        TARGET,
        NOW,
      ) ?? "";
    expect(out).toContain("**Robin Hale**");
    expect(out).toContain("`a1b2c3d`");
  });
});
