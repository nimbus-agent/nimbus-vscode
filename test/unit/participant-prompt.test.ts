import { describe, expect, test } from "vitest";
import type { ParticipantRequest } from "../../src/chat-participant/participant-types.js";
import {
  buildParticipantPrompt,
  PARTICIPANT_MAX_TOTAL_CONTEXT_CHARS,
} from "../../src/chat-participant/prompt.js";

function req(over: Partial<ParticipantRequest>): ParticipantRequest {
  return { prompt: "", attachments: [], ...over };
}

describe("buildParticipantPrompt", () => {
  test("free-form with no attachments is just the trimmed prompt", () => {
    expect(buildParticipantPrompt(req({ prompt: "  hello  " }))).toBe("hello");
  });

  test("free-form appends a fenced, path-redacted block per attachment", () => {
    const out = buildParticipantPrompt(
      req({
        prompt: "what is this",
        attachments: [
          { path: "/home/me/src/a.ts", languageId: "typescript", code: "const a = 1;" },
        ],
      }),
    );
    expect(out).toContain("what is this");
    expect(out).toContain("File: a.ts (typescript)");
    expect(out).toContain("```typescript\nconst a = 1;\n```");
    expect(out).not.toContain("/home/me"); // absolute path redacted
  });

  test("slash command wraps the selection in the command template", () => {
    const out = buildParticipantPrompt(
      req({
        command: "explain",
        selection: { path: "/x/y/z.py", languageId: "python", code: "def f(): pass" },
      }),
    );
    expect(out.toLowerCase()).toContain("explain");
    expect(out).toContain("File: z.py (python)");
    expect(out).toContain("def f(): pass");
  });

  test("slash command with extra prompt text keeps both instruction and text", () => {
    const out = buildParticipantPrompt(
      req({
        command: "fix",
        prompt: "focus on the loop",
        selection: { path: "a.ts", languageId: "typescript", code: "x" },
      }),
    );
    expect(out).toContain("focus on the loop");
    expect(out.toLowerCase()).toContain("fix");
  });

  test("slash command with no selection returns the instruction alone", () => {
    const out = buildParticipantPrompt(req({ command: "test" }));
    expect(out.toLowerCase()).toContain("test");
    expect(out).not.toContain("```");
  });

  test("oversized attachment code is clamped and marked truncated", () => {
    const big = "x".repeat(60_000);
    const out = buildParticipantPrompt(
      req({ prompt: "q", attachments: [{ path: "big.ts", languageId: "typescript", code: big }] }),
    );
    expect(out).toContain("(truncated)");
    expect(out.length).toBeLessThan(big.length); // clamped below the raw size
  });

  test("multiple oversized attachments share one total budget, not one cap each", () => {
    const big = "x".repeat(40_000);
    const out = buildParticipantPrompt(
      req({
        prompt: "q",
        attachments: [
          { path: "a.ts", languageId: "typescript", code: big },
          { path: "b.ts", languageId: "typescript", code: big },
          { path: "c.ts", languageId: "typescript", code: big },
        ],
      }),
    );
    // 3 * 40k = 120k; a naive per-file cap would allow up to 3 * 50k = 150k.
    // The shared budget must keep the total well under that.
    expect(out.length).toBeLessThan(60_000);
    expect(out.length).toBeLessThan(PARTICIPANT_MAX_TOTAL_CONTEXT_CHARS + 5_000);
    expect(out).toContain("(truncated)");
  });
});
