import { describe, expect, test } from "vitest";

import {
  buildDocstringsPrompt,
  buildTestsPrompt,
  deriveTestFileName,
  extractCode,
  isWholeFileRewrite,
  spliceSelection,
} from "../../src/scm/generate.js";

describe("deriveTestFileName", () => {
  test("uses the language's conventional test name", () => {
    expect(deriveTestFileName("src/quick-ask.ts")).toBe("quick-ask.test.ts");
    expect(deriveTestFileName("src/main.tsx")).toBe("main.test.tsx");
    expect(deriveTestFileName("app/helpers.py")).toBe("test_helpers.py");
    expect(deriveTestFileName("src/Widget.java")).toBe("WidgetTest.java");
    expect(deriveTestFileName("lib/thing.rb")).toBe("thing_spec.rb");
    expect(deriveTestFileName("pkg/server.go")).toBe("server_test.go");
  });
  test("falls back to <base>.test.<ext> for unknown extensions", () => {
    expect(deriveTestFileName("src/a.zig")).toBe("a.test.zig");
  });
  test("takes only the basename, never the directory", () => {
    expect(deriveTestFileName("/home/dev/secret-project/src/a.ts")).toBe("a.test.ts");
    expect(deriveTestFileName("C:\\Users\\dev\\src\\a.ts")).toBe("a.test.ts");
  });
  test("handles dotted names", () => {
    expect(deriveTestFileName("src/a.config.ts")).toBe("a.config.test.ts");
  });
  test("handles an extensionless file", () => {
    expect(deriveTestFileName("scripts/build")).toBe("build.test");
  });
  test("degrades gracefully for an unsaved buffer (fileName is 'Untitled-1')", () => {
    // VS Code reports a bare label, not a path, for untitled documents. No
    // throw, no path leak, just an extensionless name the user renames on Save.
    expect(deriveTestFileName("Untitled-1")).toBe("Untitled-1.test");
  });
  test("handles a dotfile with no extension", () => {
    expect(deriveTestFileName(".gitignore")).toBe(".gitignore.test");
  });
});

describe("extractCode", () => {
  test("returns the contents of a fenced block", () => {
    expect(extractCode("Sure:\n```ts\nconst a = 1;\n```\nHope that helps")).toBe("const a = 1;");
  });
  test("returns the first block when there are several", () => {
    expect(extractCode("```ts\nA\n```\ntext\n```ts\nB\n```")).toBe("A");
  });
  test("falls back to the whole reply when there is no fence", () => {
    expect(extractCode("const a = 1;")).toBe("const a = 1;");
  });
  test("preserves indentation inside the block", () => {
    expect(extractCode("```python\ndef f():\n    return 1\n```")).toBe("def f():\n    return 1");
  });
});

describe("spliceSelection", () => {
  test("replaces the selected range", () => {
    expect(spliceSelection("abcdef", 2, 4, "XY")).toBe("abXYef");
  });
  test("handles a selection at the start", () => {
    expect(spliceSelection("abcdef", 0, 2, "X")).toBe("Xcdef");
  });
  test("handles a selection at the end", () => {
    expect(spliceSelection("abcdef", 4, 6, "X")).toBe("abcdX");
  });
  test("handles an empty selection as an insertion", () => {
    expect(spliceSelection("abcdef", 3, 3, "X")).toBe("abcXdef");
  });
  test("clamps out-of-range offsets rather than producing undefined slices", () => {
    expect(spliceSelection("abc", -5, 99, "X")).toBe("X");
  });
});

describe("isWholeFileRewrite", () => {
  const full =
    "import { thing } from './somewhere-else';\nconst selected = 1;\nexport default selected;\n";
  const start = full.indexOf("const selected");
  const end = start + "const selected = 1;".length;

  test("is false for an honest selection-only rewrite", () => {
    expect(isWholeFileRewrite("// doc\nconst selected = 1;", full, start, end)).toBe(false);
  });
  test("is true when the reply echoes a line from before the selection", () => {
    const whole = "import { thing } from './somewhere-else';\n// doc\nconst selected = 1;";
    expect(isWholeFileRewrite(whole, full, start, end)).toBe(true);
  });
  test("is true when the reply echoes a line from after the selection", () => {
    const whole = "// doc\nconst selected = 1;\nexport default selected;";
    expect(isWholeFileRewrite(whole, full, start, end)).toBe(true);
  });
  test("ignores short lines that recur everywhere", () => {
    const braces = "function f() {\n}\nconst selected = 1;\n}\n";
    const s = braces.indexOf("const selected");
    expect(isWholeFileRewrite("// doc\nconst selected = 1;\n}", braces, s, s + 19)).toBe(false);
  });
  test("is false when the selection is the whole document", () => {
    expect(isWholeFileRewrite("// doc\n".concat(full), full, 0, full.length)).toBe(false);
  });
});

describe("prompts", () => {
  test("the tests prompt asks for a runnable suite and includes the code", () => {
    const p = buildTestsPrompt({
      code: "const a = 1;",
      filePath: "a.ts",
      languageId: "typescript",
    });
    expect(p).toContain("const a = 1;");
    expect(p).toContain("File: a.ts (typescript)");
    expect(p.toLowerCase()).toContain("test");
  });
  test("the docstrings prompt asks for the same code back with docs added", () => {
    const p = buildDocstringsPrompt({
      code: "def f(): pass",
      filePath: "a.py",
      languageId: "python",
    });
    expect(p).toContain("def f(): pass");
    expect(p.toLowerCase()).toContain("unchanged");
  });
  test("both mark a truncated context", () => {
    const p = buildTestsPrompt({
      code: "x",
      filePath: "a.ts",
      languageId: "typescript",
      truncated: true,
    });
    expect(p).toContain("(truncated)");
  });
});
