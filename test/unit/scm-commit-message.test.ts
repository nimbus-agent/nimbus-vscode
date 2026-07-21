import { describe, expect, test } from "vitest";

import {
  buildCommitPrompt,
  COMMIT_STYLE_EXAMPLES,
  composeInputBoxValue,
  filterStyleExamples,
  sanitizeCommitMessage,
} from "../../src/scm/commit-message.js";

describe("filterStyleExamples", () => {
  test("keeps human subject lines, newest first", () => {
    expect(filterStyleExamples(["feat: a", "fix: b"], 10)).toEqual(["feat: a", "fix: b"]);
  });
  test("uses only the subject line of a multi-line message", () => {
    expect(filterStyleExamples(["feat: a\n\nlong body here"], 10)).toEqual(["feat: a"]);
  });
  test("drops merge commits", () => {
    const out = filterStyleExamples(
      [
        "Merge branch 'main'",
        "Merge pull request #3 from x",
        "Merge remote-tracking branch 'o/m'",
        "feat: a",
      ],
      10,
    );
    expect(out).toEqual(["feat: a"]);
  });
  test("drops release-automation commits", () => {
    const out = filterStyleExamples(
      ["chore(release): 0.5.0", "chore: release 1.2.3", "Release v2.0.0", "fix: b"],
      10,
    );
    expect(out).toEqual(["fix: b"]);
  });
  test("drops dependency bumps", () => {
    const out = filterStyleExamples(
      ["Bump lodash from 1 to 2", "build(deps): bump x", "chore(deps): bump y", "feat: c"],
      10,
    );
    expect(out).toEqual(["feat: c"]);
  });
  test("drops blank messages", () => {
    expect(filterStyleExamples(["", "   ", "feat: a"], 10)).toEqual(["feat: a"]);
  });
  test("caps at the requested limit", () => {
    const many = Array.from({ length: 30 }, (_, i) => `feat: change ${i}`);
    expect(filterStyleExamples(many, COMMIT_STYLE_EXAMPLES)).toHaveLength(COMMIT_STYLE_EXAMPLES);
  });
  test("returns empty when the log is nothing but automation", () => {
    expect(filterStyleExamples(["Merge branch 'x'", "chore(release): 1.0.0"], 10)).toEqual([]);
  });
});

describe("buildCommitPrompt", () => {
  test("includes the diff and the style examples", () => {
    const p = buildCommitPrompt({
      diffBlock: "File: a.ts\n```diff\n+a\n```",
      examples: ["feat: a", "fix: b"],
    });
    expect(p).toContain("+a");
    expect(p).toContain("feat: a");
    expect(p).toContain("fix: b");
    expect(p).toContain("72");
  });
  test("falls back to a conventional-commit instruction with no examples", () => {
    const p = buildCommitPrompt({ diffBlock: "d", examples: [] });
    expect(p).toContain("Conventional Commits");
    expect(p).not.toContain("Recent commit messages");
  });
  test("asks for the message only, with no commentary", () => {
    expect(buildCommitPrompt({ diffBlock: "d", examples: [] })).toContain("no commentary");
  });
});

describe("sanitizeCommitMessage", () => {
  test("strips a surrounding code fence", () => {
    expect(sanitizeCommitMessage("```\nfeat: a\n```")).toBe("feat: a");
  });
  test("strips a language-tagged fence", () => {
    expect(sanitizeCommitMessage("```text\nfeat: a\n```")).toBe("feat: a");
  });
  test("strips conversational preamble", () => {
    expect(sanitizeCommitMessage("Here's a commit message:\n\nfeat: a")).toBe("feat: a");
    expect(sanitizeCommitMessage("Here is the commit message:\nfix: b")).toBe("fix: b");
  });
  test("strips a conversational preamble followed by a plain fence", () => {
    expect(sanitizeCommitMessage("Here's a commit message:\n\n```\nfeat: a\n```")).toBe("feat: a");
  });
  test("strips a conversational preamble followed by a language-tagged fence", () => {
    expect(sanitizeCommitMessage("Here's a commit message:\n\n```text\nfeat: a\n```")).toBe(
      "feat: a",
    );
  });
  test("strips a fence followed by trailing commentary", () => {
    expect(sanitizeCommitMessage("```\nfeat: a\n```\nHope that helps")).toBe("feat: a");
  });
  test("keeps a body intact", () => {
    expect(sanitizeCommitMessage("feat: a\n\nWhy this matters.")).toBe(
      "feat: a\n\nWhy this matters.",
    );
  });
  test("trims trailing whitespace on every line", () => {
    expect(sanitizeCommitMessage("feat: a   \n\nbody  \n\n")).toBe("feat: a\n\nbody");
  });
  test("returns empty for a blank reply", () => {
    expect(sanitizeCommitMessage("   \n  ")).toBe("");
  });
  test("does not truncate a long subject", () => {
    const long = `feat: ${"x".repeat(120)}`;
    expect(sanitizeCommitMessage(long)).toBe(long);
  });
});

describe("composeInputBoxValue", () => {
  test("replace discards the existing text", () => {
    expect(composeInputBoxValue("wip", "feat: a", "replace")).toBe("feat: a");
  });
  test("append joins with a blank line", () => {
    expect(composeInputBoxValue("wip", "feat: a", "append")).toBe("wip\n\nfeat: a");
  });
  test("append to an empty box does not add leading blank lines", () => {
    expect(composeInputBoxValue("", "feat: a", "append")).toBe("feat: a");
  });
  test("append trims trailing whitespace on the existing text first", () => {
    expect(composeInputBoxValue("wip\n\n", "feat: a", "append")).toBe("wip\n\nfeat: a");
  });
  test("append is a no-op when the draft is already present", () => {
    expect(composeInputBoxValue("feat: a", "feat: a", "append")).toBe("feat: a");
    expect(composeInputBoxValue("wip\n\nfeat: a", "feat: a", "append")).toBe("wip\n\nfeat: a");
  });
});
