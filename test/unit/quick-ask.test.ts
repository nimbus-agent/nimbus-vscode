import { describe, expect, test } from "vitest";

import {
  buildQuickAskPrompt,
  clampContext,
  extractReply,
  QUICK_ASK_MAX_CONTEXT_CHARS,
  redactPath,
  validateQuestion,
} from "../../src/quick-ask.js";

describe("clampContext", () => {
  test("returns the input unchanged when within max", () => {
    expect(clampContext("abc", 10)).toEqual({ code: "abc", truncated: false });
    expect(clampContext("abcde", 5)).toEqual({ code: "abcde", truncated: false });
  });
  test("truncates to max and flags truncation when over", () => {
    expect(clampContext("abcdef", 3)).toEqual({ code: "abc", truncated: true });
  });
  test("the exported cap is 50_000", () => {
    expect(QUICK_ASK_MAX_CONTEXT_CHARS).toBe(50_000);
  });
});

describe("buildQuickAskPrompt", () => {
  test("includes the question, file path, language fence, and code", () => {
    const p = buildQuickAskPrompt({
      question: "What does this do?",
      code: "const x = 1;",
      filePath: "src/a.ts",
      languageId: "typescript",
    });
    expect(p).toContain("What does this do?");
    expect(p).toContain("File: src/a.ts (typescript)");
    expect(p).toContain("```typescript");
    expect(p).toContain("const x = 1;");
  });
  test("marks the header when truncated", () => {
    const p = buildQuickAskPrompt({
      question: "q",
      code: "code",
      filePath: "src/a.ts",
      languageId: "typescript",
      truncated: true,
    });
    expect(p).toContain("File: src/a.ts (typescript) (truncated)");
  });
  test("omits the fenced block for blank code, sending the question alone", () => {
    expect(
      buildQuickAskPrompt({
        question: "  just this  ",
        code: "   ",
        filePath: "src/a.ts",
        languageId: "typescript",
      }),
    ).toBe("just this");
  });
  test("preserves leading indentation of the code verbatim", () => {
    const code = "    if x:\n        return 1";
    const p = buildQuickAskPrompt({ question: "q", code, filePath: "a.py", languageId: "python" });
    expect(p).toContain(`\`\`\`python\n${code}\n\`\`\``);
  });
});

describe("extractReply", () => {
  test("returns a trimmed non-empty reply", () => {
    expect(extractReply({ reply: "  hello  " })).toBe("hello");
  });
  test("returns undefined for missing / non-string / blank replies", () => {
    expect(extractReply({})).toBeUndefined();
    expect(extractReply({ reply: 42 })).toBeUndefined();
    expect(extractReply({ reply: "   " })).toBeUndefined();
    expect(extractReply("nope")).toBeUndefined();
    expect(extractReply(null)).toBeUndefined();
  });
});

describe("validateQuestion", () => {
  test("rejects blank/whitespace and accepts real text", () => {
    expect(validateQuestion("")).toBe("Please enter a question");
    expect(validateQuestion("   ")).toBe("Please enter a question");
    expect(validateQuestion("why is this slow?")).toBeUndefined();
  });
});

describe("redactPath", () => {
  test("reduces an absolute path to its basename (Windows and POSIX)", () => {
    expect(redactPath("C:\\Users\\alice\\proj\\src\\a.ts")).toBe("a.ts");
    expect(redactPath("/home/alice/proj/src/a.ts")).toBe("a.ts");
  });
  test("returns a bare filename unchanged", () => {
    expect(redactPath("a.ts")).toBe("a.ts");
  });
});
