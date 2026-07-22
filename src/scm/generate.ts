import { buildQuickAskPrompt } from "../quick-ask.js";

// Conventional test filenames per language. The value is a template over the
// base name; anything not listed falls back to `<base>.test.<ext>`.
const TEST_NAME_BY_EXT: Readonly<Record<string, (base: string, ext: string) => string>> = {
  py: (base) => `test_${base}.py`,
  java: (base) => `${base}Test.java`,
  kt: (base) => `${base}Test.kt`,
  rb: (base) => `${base}_spec.rb`,
  go: (base) => `${base}_test.go`,
};

// Name only — never a directory. The buffer opens untitled, so Save presents a
// location picker and the user places it; guessing the directory would need
// filesystem probing for very little gain.
export function deriveTestFileName(sourcePath: string): string {
  const fileName = sourcePath.split(/[\\/]/).at(-1) ?? sourcePath;
  const dot = fileName.lastIndexOf(".");
  if (dot <= 0) return `${fileName}.test`;
  const base = fileName.slice(0, dot);
  const ext = fileName.slice(dot + 1);
  const special = TEST_NAME_BY_EXT[ext];
  return special === undefined ? `${base}.test.${ext}` : special(base, ext);
}

// Agents wrap code in a fence and often add prose around it. Take the first
// fenced block; if there is none, assume the whole reply is bare code.
export function extractCode(reply: string): string {
  // Scanned rather than matched with /```[^\n]*\n([\s\S]*?)```/: the lazy inner
  // group between two fences backtracks super-linearly on a reply carrying many
  // stray backticks. Same semantics — first fence, its line terminator, then the
  // next fence — in linear time.
  const open = reply.indexOf("```");
  const afterOpen = open === -1 ? -1 : reply.indexOf("\n", open + 3);
  const close = afterOpen === -1 ? -1 : reply.indexOf("```", afterOpen + 1);
  if (close === -1) return reply.trim();
  return reply.slice(afterOpen + 1, close).replace(/\n$/, "");
}

// Rebuild a whole document with the selected range replaced, so the docstrings
// diff shows only the annotated region instead of a whole-file mismatch.
// Offsets are clamped: a stale selection must not silently produce garbage.
export function spliceSelection(
  full: string,
  start: number,
  end: number,
  replacement: string,
): string {
  const lo = Math.max(0, Math.min(start, full.length));
  const hi = Math.max(lo, Math.min(end, full.length));
  return full.slice(0, lo) + replacement + full.slice(hi);
}

// Agents asked to annotate a selection sometimes return the WHOLE file instead
// — helpfully, in their view. Splicing a whole-file reply into a selection's
// offsets duplicates everything around it and produces a nonsense diff.
//
// The signal is crisp and needs no guessing: if the reply repeats a non-empty
// line that lives OUTSIDE the selection, it is not a selection rewrite. The
// caller then diffs whole-file instead of splicing — which is exactly what the
// user wants when the agent returned a whole file.
export function isWholeFileRewrite(
  rewritten: string,
  fullText: string,
  start: number,
  end: number,
): boolean {
  const outside = [fullText.slice(0, start), fullText.slice(end)];
  for (const region of outside) {
    for (const line of region.split("\n")) {
      const trimmed = line.trim();
      // Short lines ("}", ")") recur everywhere and would false-positive.
      if (trimmed.length < 12) continue;
      if (rewritten.includes(trimmed)) return true;
    }
  }
  return false;
}

interface GeneratePromptInput {
  code: string;
  filePath: string;
  languageId: string;
  truncated?: boolean;
}

// Both reuse quick-ask's fenced-context builder; only the instruction differs.
function build(question: string, input: GeneratePromptInput): string {
  return buildQuickAskPrompt({
    question,
    code: input.code,
    filePath: input.filePath,
    languageId: input.languageId,
    ...(input.truncated === true ? { truncated: true } : {}),
  });
}

export function buildTestsPrompt(input: GeneratePromptInput): string {
  return build(
    [
      "Write a complete, runnable test suite for the following code.",
      "Use the testing framework and conventions idiomatic to this language.",
      "Cover the meaningful edge cases, not just the happy path.",
      "Reply with the test file contents only, in a single fenced code block.",
    ].join(" "),
    input,
  );
}

export function buildDocstringsPrompt(input: GeneratePromptInput): string {
  return build(
    [
      "Add documentation comments to the following code.",
      "Return the same code with docs added and the logic left unchanged —",
      "do not rename, reformat, or restructure anything.",
      "Reply with the code only, in a single fenced code block.",
    ].join(" "),
    input,
  );
}
