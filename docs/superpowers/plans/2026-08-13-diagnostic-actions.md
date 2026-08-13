# Diagnostic Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put three Nimbus actions behind the lightbulb on a diagnostic — explain the problem, suggest a fix as a diff, and search the local index for prior occurrences.

**Architecture:** Five pure modules under `src/diagnostics/` (normalize, context, prompts, actions, commands-over-injected-deps) plus one `vscode`-touching glue file (`real-provider.ts`) that is the only place `registerCodeActionsProvider` is called. The two model-bound actions route through the existing pre-flight gate under a new `"diagnostic"` kind; the index-only action is ungated and reuses the existing search Quick Pick.

**Tech Stack:** TypeScript strict (no `any`), Vitest with `vscode` aliased to `test/unit/vscode-stub.ts`, Biome, esbuild, bun.

**Spec:** `docs/superpowers/specs/2026-08-13-diagnostic-actions-design.md` — read it before Task 1. Its review record is `docs/superpowers/specs/2026-08-13-diagnostic-actions-design-feedback.md`.

## Global Constraints

- **No `any`.** External/untyped data is `unknown`. Biome enforces (`noExplicitAny`).
- **No `console`.** Log through the injected `Logger` (`src/logging.ts`); Biome enforces `noConsole` in `src/`.
- **No non-null assertions** (`!`). Biome enforces `noNonNullAssertion`.
- **`vscode` is only touched through `src/vscode-shim.ts`** or a dedicated `real-*.ts` glue file. `src/diagnostics/real-provider.ts` is this feature's one exception, mirroring `src/briefs/real-hover.ts`.
- **`.agentInvoke(` / `.askStream(` may appear only in `src/egress/gated-client.ts`.** `test/unit/egress-choke-point.test.ts` enforces this. Consumer modules declare a structural client interface whose `agentInvoke` takes a **required third `meta` argument**, so a raw `NimbusClient` cannot be wired in by accident.
- **Output is always a suggestion, never an applied edit.** No `WorkspaceEdit` is ever applied by this feature. Every `CodeAction` carries a `command` and no `edit`.
- **No action ever sets `isPreferred`.** Auto Fix (`Shift+Alt+.`) considers only preferred actions; a lint-tidy keystroke must never fire a gated model call.
- **Every `nimbus.*` setting must be documented in `docs/settings.md`** or `bun run check-settings-docs` fails.
- Imports of local modules use the `.js` extension (`from "./normalize.js"`), including from tests (`from "../../src/diagnostics/normalize.js"`).
- Commit messages are Conventional Commits — the PR title is what Release Please reads.

**Verification commands** (run from the worktree root):

```bash
bun run test          # vitest run
bun run typecheck     # tsc --noEmit
bun run lint          # biome check .
bun run check-settings-docs
```

---

### Task 1: Normalize a diagnostic message into an index query

**Files:**
- Create: `src/diagnostics/normalize.ts`
- Test: `test/unit/diagnostics-normalize.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type QuotedTokenPolicy = "keep" | "drop"`
  - `const QUOTED_TOKEN_POLICY: Record<string, QuotedTokenPolicy>`
  - `const NORMALIZED_QUERY_MAX_CHARS = 300`
  - `const NORMALIZED_QUERY_MIN_CHARS = 12`
  - `function normalizeDiagnosticMessage(input: { message: string; source?: string; code?: string | number }): string`

- [ ] **Step 1: Write the failing test**

Create `test/unit/diagnostics-normalize.test.ts`:

```ts
import { describe, expect, test } from "vitest";

import {
  NORMALIZED_QUERY_MAX_CHARS,
  normalizeDiagnosticMessage,
} from "../../src/diagnostics/normalize.js";

describe("normalizeDiagnosticMessage", () => {
  test("prepends the diagnostic code, which is the highest-signal exact token", () => {
    expect(
      normalizeDiagnosticMessage({
        message: "Object is possibly 'undefined'.",
        source: "ts",
        code: 2532,
      }),
    ).toBe("2532 Object is possibly 'undefined'.");
  });

  test("omits the code when there isn't one", () => {
    expect(normalizeDiagnosticMessage({ message: "Object is possibly undefined." })).toBe(
      "Object is possibly undefined.",
    );
  });

  test("collapses the newlines multi-line messages carry", () => {
    expect(
      normalizeDiagnosticMessage({ message: "Type 'A' is not assignable.\n  Types differ.\n" }),
    ).toBe("Type 'A' is not assignable. Types differ.");
  });

  test("strips paths — a token with BOTH a separator and a dot extension", () => {
    expect(
      normalizeDiagnosticMessage({
        message: "Cannot find module './widgets/thing.ts' or its type declarations.",
      }),
    ).toBe("Cannot find module or its type declarations.");
  });

  test("strips a Windows absolute path", () => {
    expect(
      normalizeDiagnosticMessage({ message: "Failed reading C:\\Users\\dev\\repo\\src\\a.ts here" }),
    ).toBe("Failed reading here");
  });

  test("keeps type-shaped tokens that merely look path-ish", () => {
    // No dot extension, so the conjunction rule keeps it.
    expect(normalizeDiagnosticMessage({ message: "Type 'Array<string>' is not assignable." })).toBe(
      "Type 'Array<string>' is not assignable.",
    );
  });

  test("strips positions in all three shapes", () => {
    expect(
      normalizeDiagnosticMessage({ message: "Parsing error at line 42 :17:9 near here (12,4)" }),
    ).toBe("Parsing error at near here");
  });

  test("keeps quoted tokens by default, because compilers quote types", () => {
    expect(
      normalizeDiagnosticMessage({
        message: "Argument of type 'string' is not assignable to parameter of type 'number'.",
        source: "ts",
        code: "2345",
      }),
    ).toBe(
      "2345 Argument of type 'string' is not assignable to parameter of type 'number'.",
    );
  });

  test("drops quoted tokens for eslint, which quotes this call site's identifiers", () => {
    expect(
      normalizeDiagnosticMessage({
        message: "'handleFooBarBaz' is defined but never used.",
        source: "eslint",
        code: "no-unused-vars",
      }),
    ).toBe("no-unused-vars is defined but never used.");
  });

  test("drops quoted tokens for biome too", () => {
    expect(
      normalizeDiagnosticMessage({
        message: "This let declares 'thing' which is never reassigned.",
        source: "biome",
      }),
    ).toBe("This let declares which is never reassigned.");
  });

  test("unlisted sources fall through to keep rather than being guessed at", () => {
    // rustc and pyright quote identifiers AND types; a single verdict is the
    // wrong shape for them, so they get the safe default. See spec Part 9.
    for (const source of ["rustc", "pyright", "gopls"]) {
      expect(
        normalizeDiagnosticMessage({ message: "expected `u32`, found `String`", source }),
      ).toBe("expected `u32`, found `String`");
    }
  });

  test("clamps to the max on a word boundary", () => {
    const long = `${"alpha ".repeat(200)}omega`;
    const out = normalizeDiagnosticMessage({ message: long });
    expect(out.length).toBeLessThanOrEqual(NORMALIZED_QUERY_MAX_CHARS);
    expect(out.endsWith("alpha")).toBe(true);
  });

  test("returns empty when nothing survives normalization", () => {
    expect(normalizeDiagnosticMessage({ message: "  :3:9  " })).toBe("");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bunx vitest run test/unit/diagnostics-normalize.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/diagnostics/normalize.js"`.

- [ ] **Step 3: Write the implementation**

Create `src/diagnostics/normalize.ts`:

```ts
// A diagnostic message mixes INVARIANT PROSE (which another occurrence of the
// same problem shares) with CALL-SITE TOKENS (paths, positions, local
// identifiers) that are unique to this line and poison a semantic query. This
// module keeps the first and drops the second.

export type QuotedTokenPolicy = "keep" | "drop";

// Keyed on `diagnostic.source`. DEFAULT IS "keep": compilers quote types, which
// is the useful half of their message. Only linters that quote the offending
// identifier are listed. Sources whose messages quote BOTH (rustc, pyright) are
// deliberately absent — a single per-source verdict is the wrong shape for
// them, and guessing would make their queries worse. See the spec, Part 9.
export const QUOTED_TOKEN_POLICY: Record<string, QuotedTokenPolicy> = {
  eslint: "drop",
  biome: "drop",
};

// searchRanked's `name` is a free-text query; past a few hundred characters the
// call-site noise outweighs the signal.
export const NORMALIZED_QUERY_MAX_CHARS = 300;

// Below this a query is a bare code or an empty husk — it would return noise, so
// actions.ts withholds the action entirely rather than offering a dud.
export const NORMALIZED_QUERY_MIN_CHARS = 12;

// A path token: contains a separator AND a dot-extension. The conjunction is the
// point — it drops `src/widgets/thing.ts` while keeping `Array<string>`.
//
// The optional quote group + backreference matters: messages quote their paths
// ("Cannot find module './widgets/thing.ts'"), and the character class stops at
// the quote, so without this the removal would leave an empty '' behind. A
// separate empty-quote cleanup pass would be worse — it matches the closing and
// opening quotes of two ADJACENT quoted tokens ("'a' 'b'"). A backreference to a
// group that did not participate matches the empty string, so the unquoted
// Windows-path case still works.
const PATH_TOKEN = /(['"`])?(?:[A-Za-z]:)?[^\s'"`()]*[\\/][^\s'"`()]*\.[A-Za-z0-9]+\1?/g;

// `line 42`, `:17:9`, `(12,4)`.
const POSITION = /\bline \d+\b|:\d+:\d+|\(\d+,\s*\d+\)/g;

// Single quotes, double quotes and backticks — the three conventions in use.
const QUOTED = /(['"`])(?:(?!\1).)*\1/g;

function policyFor(source: string | undefined): QuotedTokenPolicy {
  if (source === undefined) return "keep";
  return QUOTED_TOKEN_POLICY[source.toLowerCase()] ?? "keep";
}

// Cut on a word boundary so the tail of the query is never half a token.
function clampOnWord(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trimEnd();
}

export function normalizeDiagnosticMessage(input: {
  message: string;
  source?: string;
  code?: string | number;
}): string {
  let text = input.message;
  // Paths first: a path can contain digits that POSITION would otherwise eat,
  // leaving a fragment behind instead of removing the whole token.
  text = text.replace(PATH_TOKEN, " ");
  text = text.replace(POSITION, " ");
  if (policyFor(input.source) === "drop") text = text.replace(QUOTED, " ");
  // Collapse last: every rule above leaves gaps behind.
  text = text.replace(/\s+/g, " ").trim();
  // Tidy the space a removed token leaves in front of its punctuation.
  text = text.replace(/\s+([.,;:])/g, "$1");

  const code = input.code === undefined ? "" : String(input.code).trim();
  const joined = code.length > 0 ? `${code} ${text}`.trim() : text;
  return clampOnWord(joined, NORMALIZED_QUERY_MAX_CHARS);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bunx vitest run test/unit/diagnostics-normalize.test.ts`
Expected: PASS, 13 tests.

If the "strips positions in all three shapes" case fails on spacing, the fix is in the collapse/punctuation order at the end of `normalizeDiagnosticMessage` — do not loosen the assertion.

- [ ] **Step 5: Lint and typecheck**

Run: `bun run typecheck && bun run lint`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add src/diagnostics/normalize.ts test/unit/diagnostics-normalize.test.ts
git commit -m "feat(diagnostics): normalize a diagnostic message into an index query"
```

---

### Task 2: Build the payload context around a diagnostic

**Files:**
- Create: `src/diagnostics/context.ts`
- Test: `test/unit/diagnostics-context.test.ts`

**Interfaces:**
- Consumes: `clampContext`, `QUICK_ASK_MAX_CONTEXT_CHARS`, `redactPath` from `src/quick-ask.js`.
- Produces:
  - `const DIAGNOSTIC_CONTEXT_LINES = 20`
  - `interface PositionLike { line: number; character: number }`
  - `interface DiagnosticLike { message: string; severity: number; source?: string; code?: string | number; range: { start: PositionLike; end: PositionLike } }`
  - `interface DiagnosticContext { fileName: string; languageId: string; message: string; severityLabel: "error" | "warning"; source: string; code: string; startLine: number; endLine: number; snippet: string; truncated: boolean; offsets: { start: number; end: number } }`
  - `function lineStartOffsets(text: string): readonly number[]`
  - `function buildDiagnosticContext(input: { fullText: string; fileName: string; languageId: string; diagnostic: DiagnosticLike }): DiagnosticContext`

**Severity numbering** is VS Code's: `0` Error, `1` Warning, `2` Information, `3` Hint.

- [ ] **Step 1: Write the failing test**

Create `test/unit/diagnostics-context.test.ts`:

```ts
import { describe, expect, test } from "vitest";

import {
  buildDiagnosticContext,
  type DiagnosticLike,
  lineStartOffsets,
} from "../../src/diagnostics/context.js";

const lines = (n: number): string =>
  Array.from({ length: n }, (_, i) => `line ${i}`).join("\n");

const at = (line: number): DiagnosticLike => ({
  message: "boom",
  severity: 0,
  source: "ts",
  code: 2345,
  range: { start: { line, character: 2 }, end: { line, character: 6 } },
});

const build = (fullText: string, diagnostic: DiagnosticLike) =>
  buildDiagnosticContext({ fullText, fileName: "/home/dev/repo/src/a.ts", languageId: "typescript", diagnostic });

describe("lineStartOffsets", () => {
  test("gives the offset each line starts at, CRLF included", () => {
    expect(lineStartOffsets("ab\ncd")).toEqual([0, 3]);
    expect(lineStartOffsets("ab\r\ncd")).toEqual([0, 4]);
  });
});

describe("buildDiagnosticContext", () => {
  test("takes 20 lines either side of the diagnostic", () => {
    const ctx = build(lines(200), at(100));
    expect(ctx.snippet.split("\n")).toHaveLength(41);
    expect(ctx.snippet.startsWith("line 80")).toBe(true);
    expect(ctx.snippet.endsWith("line 120")).toBe(true);
  });

  test("clamps at the start of the file without padding", () => {
    const ctx = build(lines(200), at(3));
    expect(ctx.snippet.startsWith("line 0")).toBe(true);
    expect(ctx.snippet.split("\n")).toHaveLength(24);
  });

  test("clamps at the end of the file without padding", () => {
    const ctx = build(lines(30), at(28));
    expect(ctx.snippet.endsWith("line 29")).toBe(true);
  });

  test("redacts the path to a basename — never the directory", () => {
    expect(build(lines(5), at(1)).fileName).toBe("a.ts");
  });

  test("reports 1-based display lines, because editors count from 1", () => {
    const ctx = build(lines(30), at(9));
    expect(ctx.startLine).toBe(10);
    expect(ctx.endLine).toBe(10);
  });

  test("carries character offsets for the splice", () => {
    const ctx = build(lines(30), at(2));
    // "line 0\nline 1\n" is 14 chars; +2 for the range's start character.
    expect(ctx.offsets).toEqual({ start: 16, end: 20 });
  });

  test("labels severity, mapping VS Code's numbering", () => {
    expect(build(lines(5), { ...at(1), severity: 0 }).severityLabel).toBe("error");
    expect(build(lines(5), { ...at(1), severity: 1 }).severityLabel).toBe("warning");
  });

  test("normalizes a missing source and code to empty strings", () => {
    const ctx = build(lines(5), { ...at(1), source: undefined, code: undefined });
    expect(ctx.source).toBe("");
    expect(ctx.code).toBe("");
  });

  test("truncates a minified file where twenty lines is the whole bundle", () => {
    const ctx = build("x".repeat(60_000), {
      ...at(0),
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } },
    });
    expect(ctx.truncated).toBe(true);
    expect(ctx.snippet.length).toBe(50_000);
  });

  test("does not flag truncation for an ordinary file", () => {
    expect(build(lines(200), at(100)).truncated).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bunx vitest run test/unit/diagnostics-context.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `src/diagnostics/context.ts`:

```ts
import { clampContext, QUICK_ASK_MAX_CONTEXT_CHARS, redactPath } from "../quick-ask.js";

// Lines of surrounding code sent either side of the diagnostic. Enough for an
// agent to see the enclosing function in ordinary code; the character clamp
// below is what protects us from a minified file where that is the whole bundle.
export const DIAGNOSTIC_CONTEXT_LINES = 20;

export interface PositionLike {
  line: number;
  character: number;
}

// The subset of vscode.Diagnostic this feature reads. Declared structurally so
// every pure module here stays free of `vscode`. `severity` is VS Code's
// numbering: 0 Error, 1 Warning, 2 Information, 3 Hint.
export interface DiagnosticLike {
  message: string;
  severity: number;
  source?: string;
  code?: string | number;
  range: { start: PositionLike; end: PositionLike };
}

export interface DiagnosticContext {
  /** Redacted to a basename — never the directory. */
  fileName: string;
  languageId: string;
  message: string;
  severityLabel: "error" | "warning";
  /** "" when the diagnostic carries none. */
  source: string;
  /** "" when the diagnostic carries none. */
  code: string;
  /** 1-based, for display and for the egress manifest. */
  startLine: number;
  endLine: number;
  snippet: string;
  truncated: boolean;
  /** Character offsets into the FULL document, for splicing a fix back in. */
  offsets: { start: number; end: number };
}

// Offset each line starts at. Built by scanning for "\n", so a "\r" belongs to
// the end of its line and CRLF documents line up with vscode's offsetAt.
export function lineStartOffsets(text: string): readonly number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") starts.push(i + 1);
  }
  return starts;
}

function offsetOf(starts: readonly number[], pos: PositionLike, textLength: number): number {
  const line = Math.min(Math.max(pos.line, 0), starts.length - 1);
  const start = starts[line] ?? 0;
  return Math.min(start + Math.max(pos.character, 0), textLength);
}

export function buildDiagnosticContext(input: {
  fullText: string;
  fileName: string;
  languageId: string;
  diagnostic: DiagnosticLike;
}): DiagnosticContext {
  const { fullText, diagnostic } = input;
  const starts = lineStartOffsets(fullText);
  const lastLine = starts.length - 1;

  const first = Math.max(diagnostic.range.start.line - DIAGNOSTIC_CONTEXT_LINES, 0);
  const last = Math.min(diagnostic.range.end.line + DIAGNOSTIC_CONTEXT_LINES, lastLine);
  const from = starts[first] ?? 0;
  // Everything up to the start of the line after `last` — minus its newline.
  const to = last >= lastLine ? fullText.length : (starts[last + 1] ?? fullText.length) - 1;

  // The same helper and the same budget the SCM trio uses, rather than a second
  // differently-tuned number. At 41 lines this effectively never fires; it is a
  // backstop for a minified file, and reusing it keeps the wording uniform.
  const { code: snippet, truncated } = clampContext(
    fullText.slice(from, Math.max(to, from)),
    QUICK_ASK_MAX_CONTEXT_CHARS,
  );

  return {
    fileName: redactPath(input.fileName),
    languageId: input.languageId,
    message: diagnostic.message,
    severityLabel: diagnostic.severity === 0 ? "error" : "warning",
    source: diagnostic.source ?? "",
    code: diagnostic.code === undefined ? "" : String(diagnostic.code),
    startLine: diagnostic.range.start.line + 1,
    endLine: diagnostic.range.end.line + 1,
    snippet,
    truncated,
    offsets: {
      start: offsetOf(starts, diagnostic.range.start, fullText.length),
      end: offsetOf(starts, diagnostic.range.end, fullText.length),
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bunx vitest run test/unit/diagnostics-context.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Lint and typecheck**

Run: `bun run typecheck && bun run lint`

- [ ] **Step 6: Commit**

```bash
git add src/diagnostics/context.ts test/unit/diagnostics-context.test.ts
git commit -m "feat(diagnostics): build the payload context around a diagnostic"
```

---

### Task 3: Prompts for explain and fix

**Files:**
- Create: `src/diagnostics/prompts.ts`
- Test: `test/unit/diagnostics-prompts.test.ts`

**Interfaces:**
- Consumes: `DiagnosticContext` from `./context.js` (Task 2).
- Produces:
  - `function buildExplainPrompt(ctx: DiagnosticContext): string`
  - `function buildFixPrompt(ctx: DiagnosticContext): string`

- [ ] **Step 1: Write the failing test**

Create `test/unit/diagnostics-prompts.test.ts`:

```ts
import { describe, expect, test } from "vitest";

import type { DiagnosticContext } from "../../src/diagnostics/context.js";
import { buildExplainPrompt, buildFixPrompt } from "../../src/diagnostics/prompts.js";

const ctx: DiagnosticContext = {
  fileName: "a.ts",
  languageId: "typescript",
  message: "Object is possibly 'undefined'.",
  severityLabel: "error",
  source: "ts",
  code: "2532",
  startLine: 10,
  endLine: 10,
  snippet: "const x = maybe();\nx.go();",
  truncated: false,
  offsets: { start: 18, end: 24 },
};

describe("buildExplainPrompt", () => {
  test("states the diagnostic, where it is, and fences the snippet", () => {
    const p = buildExplainPrompt(ctx);
    expect(p).toContain("Object is possibly 'undefined'.");
    expect(p).toContain("ts 2532");
    expect(p).toContain("a.ts");
    expect(p).toContain("line 10");
    expect(p).toContain("```typescript\nconst x = maybe();\nx.go();\n```");
  });

  test("asks for an explanation, not a rewrite", () => {
    expect(buildExplainPrompt(ctx).toLowerCase()).toContain("explain");
  });

  test("names a line range when the diagnostic spans lines", () => {
    expect(buildExplainPrompt({ ...ctx, endLine: 14 })).toContain("lines 10-14");
  });

  test("marks a truncated snippet so the reply knows it saw part of the file", () => {
    expect(buildExplainPrompt({ ...ctx, truncated: true })).toContain("truncated");
  });

  test("omits the source/code clause when the diagnostic carries neither", () => {
    // Asserted on the header line, not the whole prompt: the fenced snippet
    // legitimately contains "maybe()", so a prompt-wide `not.toContain("()")`
    // tests the fixture rather than origin(). An exact header match is both
    // narrower and stronger — it pins the whole clause, not just its absence.
    const p = buildExplainPrompt({ ...ctx, source: "", code: "" });
    expect(p.split("\n")[0]).toBe("Explain this error reported at line 10 of a.ts:");
    expect(p).toContain("Object is possibly 'undefined'.");
  });
});

describe("buildFixPrompt", () => {
  test("asks for the replacement region only, in a fenced block", () => {
    const p = buildFixPrompt(ctx);
    expect(p).toContain("```typescript");
    expect(p.toLowerCase()).toContain("replacement");
  });

  test("tells the agent not to explain, so extractCode gets a clean block", () => {
    expect(buildFixPrompt(ctx).toLowerCase()).toContain("no prose");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bunx vitest run test/unit/diagnostics-prompts.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `src/diagnostics/prompts.ts`:

```ts
import type { DiagnosticContext } from "./context.js";

// "line 10" or "lines 10-14" — an agent reading the fenced snippet needs to know
// which part of it the diagnostic is actually about.
function where(ctx: DiagnosticContext): string {
  return ctx.startLine === ctx.endLine
    ? `line ${ctx.startLine}`
    : `lines ${ctx.startLine}-${ctx.endLine}`;
}

// "(ts 2532)" — omitted entirely when the diagnostic carries neither, so the
// prompt never contains an empty pair of brackets.
function origin(ctx: DiagnosticContext): string {
  const parts = [ctx.source, ctx.code].filter((p) => p.length > 0);
  return parts.length > 0 ? ` (${parts.join(" ")})` : "";
}

function block(ctx: DiagnosticContext): string {
  const suffix = ctx.truncated ? " (truncated)" : "";
  return `File: ${ctx.fileName} (${ctx.languageId})${suffix}\n\`\`\`${ctx.languageId}\n${ctx.snippet}\n\`\`\``;
}

export function buildExplainPrompt(ctx: DiagnosticContext): string {
  return [
    `Explain this ${ctx.severityLabel} reported at ${where(ctx)} of ${ctx.fileName}${origin(ctx)}:`,
    ctx.message,
    "",
    "Say what causes it and how it is usually resolved. Be concise.",
    "",
    block(ctx),
  ].join("\n");
}

export function buildFixPrompt(ctx: DiagnosticContext): string {
  return [
    `Fix this ${ctx.severityLabel} at ${where(ctx)} of ${ctx.fileName}${origin(ctx)}:`,
    ctx.message,
    "",
    // The reply is spliced back into the document at the diagnostic's range, so
    // it must be the replacement for THAT region and nothing else. "No prose"
    // keeps extractCode's job unambiguous.
    "Reply with the replacement for the flagged region only, as a single fenced code block. No prose, no explanation, no surrounding lines.",
    "",
    block(ctx),
  ].join("\n");
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bunx vitest run test/unit/diagnostics-prompts.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/diagnostics/prompts.ts test/unit/diagnostics-prompts.test.ts
git commit -m "feat(diagnostics): explain and fix prompt builders"
```

---

### Task 4: Decide which actions appear

**Files:**
- Create: `src/diagnostics/actions.ts`
- Test: `test/unit/diagnostics-actions.test.ts`

**Interfaces:**
- Consumes: `DiagnosticLike` from `./context.js`; `normalizeDiagnosticMessage`, `NORMALIZED_QUERY_MIN_CHARS` from `./normalize.js`.
- Produces:
  - `const DIAGNOSTIC_COMMANDS: { explain: "nimbus.diagnosticExplain"; fix: "nimbus.diagnosticFix"; priorOccurrences: "nimbus.diagnosticPriorOccurrences" }`
  - `type DiagnosticActionId = "explain" | "fix" | "priorOccurrences"`
  - `interface DiagnosticActionDescriptor { id: DiagnosticActionId; commandId: string; title: string; kind: string; isPreferred: false }`
  - `function selectDiagnostic(diagnostics: readonly DiagnosticLike[]): DiagnosticLike | undefined`
  - `function diagnosticActionsFor(input: { diagnostics: readonly DiagnosticLike[]; connected: boolean; enabled: boolean }): { diagnostic: DiagnosticLike; query: string; actions: readonly DiagnosticActionDescriptor[] } | undefined`

- [ ] **Step 1: Write the failing test**

Create `test/unit/diagnostics-actions.test.ts`:

```ts
import { describe, expect, test } from "vitest";

import type { DiagnosticLike } from "../../src/diagnostics/context.js";
import { diagnosticActionsFor, selectDiagnostic } from "../../src/diagnostics/actions.js";

const d = (over: Partial<DiagnosticLike> = {}): DiagnosticLike => ({
  message: "Argument of type 'string' is not assignable to parameter of type 'number'.",
  severity: 0,
  source: "ts",
  code: 2345,
  range: { start: { line: 4, character: 0 }, end: { line: 4, character: 10 } },
  ...over,
});

const offer = (over: Partial<Parameters<typeof diagnosticActionsFor>[0]> = {}) =>
  diagnosticActionsFor({ diagnostics: [d()], connected: true, enabled: true, ...over });

describe("selectDiagnostic", () => {
  test("prefers an error over a warning", () => {
    const warning = d({ severity: 1, code: "W" });
    const error = d({ severity: 0, code: "E" });
    expect(selectDiagnostic([warning, error])?.code).toBe("E");
  });

  test("breaks a severity tie on the smaller range", () => {
    const wide = d({ code: "WIDE", range: { start: { line: 4, character: 0 }, end: { line: 9, character: 0 } } });
    const tight = d({ code: "TIGHT" });
    expect(selectDiagnostic([wide, tight])?.code).toBe("TIGHT");
  });

  test("breaks a full tie on the order VS Code supplied", () => {
    expect(selectDiagnostic([d({ code: "FIRST" }), d({ code: "SECOND" })])?.code).toBe("FIRST");
  });

  test("returns the SAME OBJECT it was given, never a copy", () => {
    // real-provider.ts recovers the underlying vscode.Diagnostic by index
    // identity. If this ever returns a clone, indexOf yields -1 and the actions
    // silently stop being associated with their squiggle — a failure nothing
    // else would catch. This test is the contract.
    const first = d({ code: "FIRST" });
    const second = d({ code: "SECOND", severity: 1 });
    const input = [second, first];
    expect(selectDiagnostic(input)).toBe(first);
    expect(input.indexOf(first)).toBe(1);
  });

  test("ignores Information and Hint, where formatters and spell-checkers live", () => {
    expect(selectDiagnostic([d({ severity: 2 }), d({ severity: 3 })])).toBeUndefined();
  });

  test("returns undefined for an empty range", () => {
    expect(selectDiagnostic([])).toBeUndefined();
  });
});

describe("diagnosticActionsFor", () => {
  test("offers exactly three actions — never three per diagnostic", () => {
    const many = [d({ code: "A" }), d({ code: "B", severity: 1 }), d({ code: "C" })];
    const out = diagnosticActionsFor({ diagnostics: many, connected: true, enabled: true });
    expect(out?.actions).toHaveLength(3);
  });

  test("names the chosen diagnostic when the range held more than one", () => {
    const out = diagnosticActionsFor({
      diagnostics: [d({ code: 2345 }), d({ code: "no-unused-vars", severity: 1 })],
      connected: true,
      enabled: true,
    });
    expect(out?.actions[0]?.title).toBe("Nimbus: Explain this problem (2345)");
  });

  test("uses the plain title when there is only one diagnostic", () => {
    expect(offer()?.actions[0]?.title).toBe("Nimbus: Explain this problem");
  });

  test("uses the plain title when the chosen diagnostic has no code", () => {
    const out = diagnosticActionsFor({
      diagnostics: [d({ code: undefined }), d({ code: undefined, severity: 1 })],
      connected: true,
      enabled: true,
    });
    expect(out?.actions[0]?.title).toBe("Nimbus: Explain this problem");
  });

  test("namespaces every kind under quickfix so Ctrl+. reaches them", () => {
    expect(offer()?.actions.map((a) => a.kind)).toEqual([
      "quickfix.nimbus.explain",
      "quickfix.nimbus.fix",
      "quickfix.nimbus.priorOccurrences",
    ]);
  });

  test("NEVER marks an action preferred — Auto Fix must not fire a model call", () => {
    expect(offer()?.actions.every((a) => a.isPreferred === false)).toBe(true);
  });

  test("carries the command ids the manifest declares", () => {
    expect(offer()?.actions.map((a) => a.commandId)).toEqual([
      "nimbus.diagnosticExplain",
      "nimbus.diagnosticFix",
      "nimbus.diagnosticPriorOccurrences",
    ]);
  });

  test("offers nothing while disconnected — searchRanked is IPC over the same socket", () => {
    expect(offer({ connected: false })).toBeUndefined();
  });

  test("offers nothing when the setting is off", () => {
    expect(offer({ enabled: false })).toBeUndefined();
  });

  test("withholds prior-occurrences when the query normalizes to noise", () => {
    const out = diagnosticActionsFor({
      diagnostics: [d({ message: "bad :3:9", source: undefined, code: undefined })],
      connected: true,
      enabled: true,
    });
    expect(out?.actions.map((a) => a.id)).toEqual(["explain", "fix"]);
  });

  test("exposes the normalized query for the command to use", () => {
    expect(offer()?.query).toContain("2345");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bunx vitest run test/unit/diagnostics-actions.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `src/diagnostics/actions.ts`:

```ts
import type { DiagnosticLike } from "./context.js";
import { NORMALIZED_QUERY_MIN_CHARS, normalizeDiagnosticMessage } from "./normalize.js";

export const DIAGNOSTIC_COMMANDS = {
  explain: "nimbus.diagnosticExplain",
  fix: "nimbus.diagnosticFix",
  priorOccurrences: "nimbus.diagnosticPriorOccurrences",
} as const;

export type DiagnosticActionId = "explain" | "fix" | "priorOccurrences";

export interface DiagnosticActionDescriptor {
  id: DiagnosticActionId;
  commandId: string;
  title: string;
  /** Namespaced under `quickfix` so Ctrl+. reaches it; see the spec, Part 1. */
  kind: string;
  /**
   * Always false, and typed as the literal so it cannot drift. Auto Fix
   * (Shift+Alt+.) considers ONLY preferred actions, and a keystroke pressed to
   * tidy lint must never fire a gated model call.
   */
  isPreferred: false;
}

// Errors and warnings only. Information and Hint are where formatters and
// spell-checkers live; a lightbulb on every one of them would read as spam.
function isOffered(d: DiagnosticLike): boolean {
  return d.severity === 0 || d.severity === 1;
}

function rangeSpan(d: DiagnosticLike): number {
  const lines = d.range.end.line - d.range.start.line;
  return lines > 0 ? lines * 10_000 : d.range.end.character - d.range.start.character;
}

// A line commonly carries several diagnostics. Offering three actions for each
// would put six to nine Nimbus entries in one lightbulb, which is noise rather
// than offering — so exactly one diagnostic is chosen, by a total order that is
// stable across the repeated provideCodeActions calls VS Code makes.
//
// CONTRACT: returns one of the objects it was given, BY REFERENCE, never a
// copy. real-provider.ts recovers the underlying vscode.Diagnostic with
// `likes.indexOf(chosen)`; a clone would silently break the association between
// each action and its squiggle. Pinned by "returns the SAME OBJECT it was
// given" in test/unit/diagnostics-actions.test.ts.
export function selectDiagnostic(
  diagnostics: readonly DiagnosticLike[],
): DiagnosticLike | undefined {
  const offered = diagnostics.filter(isOffered);
  if (offered.length === 0) return undefined;
  return offered.reduce((best, next) => {
    if (next.severity !== best.severity) return next.severity < best.severity ? next : best;
    // Strictly less-than keeps the earlier one on a full tie, so the supplied
    // order is the last tie-break.
    return rangeSpan(next) < rangeSpan(best) ? next : best;
  });
}

const TITLES: Record<DiagnosticActionId, string> = {
  explain: "Nimbus: Explain this problem",
  fix: "Nimbus: Suggest a fix",
  priorOccurrences: "Nimbus: Find prior occurrences",
};

const KINDS: Record<DiagnosticActionId, string> = {
  explain: "quickfix.nimbus.explain",
  fix: "quickfix.nimbus.fix",
  priorOccurrences: "quickfix.nimbus.priorOccurrences",
};

export function diagnosticActionsFor(input: {
  diagnostics: readonly DiagnosticLike[];
  /** False while the Gateway socket is down — ALL three actions need it. */
  connected: boolean;
  /** nimbus.diagnostics.showCodeActions */
  enabled: boolean;
}): { diagnostic: DiagnosticLike; query: string; actions: readonly DiagnosticActionDescriptor[] } | undefined {
  if (!input.enabled || !input.connected) return undefined;
  const diagnostic = selectDiagnostic(input.diagnostics);
  if (diagnostic === undefined) return undefined;

  const query = normalizeDiagnosticMessage(diagnostic);
  const ids: DiagnosticActionId[] = ["explain", "fix"];
  // A query too short to be useful would return noise; withholding the entry
  // beats offering a reliable dud.
  if (query.length >= NORMALIZED_QUERY_MIN_CHARS) ids.push("priorOccurrences");

  // Only disambiguate when there was something to disambiguate from.
  const contested = input.diagnostics.filter(isOffered).length > 1;
  const code = diagnostic.code === undefined ? "" : String(diagnostic.code);
  const suffix = contested && code.length > 0 ? ` (${code})` : "";

  return {
    diagnostic,
    query,
    actions: ids.map((id) => ({
      id,
      commandId: DIAGNOSTIC_COMMANDS[id],
      title: `${TITLES[id]}${suffix}`,
      kind: KINDS[id],
      isPreferred: false,
    })),
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bunx vitest run test/unit/diagnostics-actions.test.ts`
Expected: PASS, 17 tests.

- [ ] **Step 5: Lint and typecheck**

Run: `bun run typecheck && bun run lint`

- [ ] **Step 6: Commit**

```bash
git add src/diagnostics/actions.ts test/unit/diagnostics-actions.test.ts
git commit -m "feat(diagnostics): decide which actions a diagnostic offers"
```

---

### Task 5: Add the `"diagnostic"` egress kind

**Files:**
- Modify: `src/egress/preflight.ts` (the `EgressKind` union, near line 5)
- Modify: `src/egress/skip-store.ts` (the `SkippableKind` union and `KEYS`)
- Modify: `src/egress/gate.ts` (`SKIP_LABEL` and `skippableKind()`)
- Test: `test/unit/egress-diagnostic-kind.test.ts`

**Interfaces:**
- Consumes: the existing gate modules.
- Produces: `"diagnostic"` as a valid `EgressKind` and `SkippableKind`; no new exported functions.

**Context for the implementer:** the extension chooses this payload (it assembles the snippet from the editor) rather than the user typing it, which is exactly why the briefs prompt. So `"diagnostic"` is a **prompting** kind. It gets **one** skip key covering both model actions — every existing kind is already coarser than one call site (`brief` covers six calls, `scm` three, `quickAsk` every preset).

- [ ] **Step 1: Write the failing test**

Create `test/unit/egress-diagnostic-kind.test.ts`:

```ts
import { describe, expect, test, vi } from "vitest";

import { createEgressGate, SKIP_LABEL } from "../../src/egress/gate.js";
import { createPreflightSkipStore } from "../../src/egress/skip-store.js";

const silentLog = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function memento() {
  const store = new Map<string, unknown>();
  return {
    get: <T>(key: string): T | undefined => store.get(key) as T | undefined,
    update: async (key: string, value: unknown): Promise<void> => {
      if (value === undefined) store.delete(key);
      else store.set(key, value);
    },
  };
}

const meta = { action: "Explain Problem", files: [], omissions: [] };

describe("the diagnostic egress kind", () => {
  test("has a skip label, so the gate's modal can name the surface", () => {
    expect(SKIP_LABEL.diagnostic).toBe("Diagnostic Actions");
  });

  test("round-trips its own skip key, independently of the other kinds", async () => {
    const skips = createPreflightSkipStore(memento());
    await skips.setSkipped("diagnostic");
    expect(skips.isSkipped("diagnostic")).toBe(true);
    expect(skips.isSkipped("brief")).toBe(false);
    await skips.clearAll();
    expect(skips.isSkipped("diagnostic")).toBe(false);
  });

  test("prompts rather than passing through", async () => {
    const showWarningMessage = vi.fn().mockResolvedValue("Send");
    const gate = createEgressGate({
      window: { showWarningMessage },
      openReadonly: vi.fn(),
      skips: createPreflightSkipStore(memento()),
      isTrusted: () => true,
      roots: () => [],
      log: silentLog,
    });
    expect(await gate.check("diagnostic", "the payload", meta)).toBe("send");
    expect(showWarningMessage).toHaveBeenCalled();
  });

  test("cancelling at the preview refuses the send", async () => {
    const gate = createEgressGate({
      window: { showWarningMessage: vi.fn().mockResolvedValue(undefined) },
      openReadonly: vi.fn(),
      skips: createPreflightSkipStore(memento()),
      isTrusted: () => true,
      roots: () => [],
      log: silentLog,
    });
    expect(await gate.check("diagnostic", "the payload", meta)).toBe("cancel");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bunx vitest run test/unit/egress-diagnostic-kind.test.ts`
Expected: FAIL — TypeScript rejects `"diagnostic"` as an `EgressKind`/`SkippableKind`, and `SKIP_LABEL.diagnostic` is `undefined`.

- [ ] **Step 3: Make the four edits**

In `src/egress/preflight.ts`, add to the union:

```ts
export type EgressKind =
  | "quickAsk"
  | "scm"
  | "ask"
  | "participant"
  | "lmTool"
  | "brief"
  | "workflow"
  | "diagnostic";
```

In `src/egress/skip-store.ts`, extend the union and the keys:

```ts
export type SkippableKind = "quickAsk" | "scm" | "brief" | "workflow" | "diagnostic";

const KEYS: Record<SkippableKind, string> = {
  quickAsk: "nimbus.preflight.skip.quickAsk",
  scm: "nimbus.preflight.skip.scm",
  brief: "nimbus.preflight.skip.brief",
  workflow: "nimbus.preflight.skip.workflow",
  diagnostic: "nimbus.preflight.skip.diagnostic",
};
```

In `src/egress/gate.ts`, extend the label map and the predicate:

```ts
export const SKIP_LABEL: Record<SkippableKind, string> = {
  quickAsk: "Quick Ask",
  scm: "Source Control",
  brief: "Agent Briefs",
  workflow: "Workflow Runs",
  diagnostic: "Diagnostic Actions",
};
```

```ts
function skippableKind(kind: EgressKind): SkippableKind | undefined {
  if (
    kind === "quickAsk" ||
    kind === "scm" ||
    kind === "brief" ||
    kind === "workflow" ||
    kind === "diagnostic"
  ) {
    return kind;
  }
  return undefined;
}
```

Also extend the comment above `skippableKind` with one clause: a diagnostic action prompts because the extension assembles the snippet from the editor, not from a user keystroke.

- [ ] **Step 4: Run the test to verify it passes**

Run: `bunx vitest run test/unit/egress-diagnostic-kind.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Run the whole suite — these files are widely depended on**

Run: `bun run test && bun run typecheck`
Expected: all green. A `Record<SkippableKind, …>` elsewhere that now misses a key will surface as a typecheck error; add the key rather than widening the type.

- [ ] **Step 6: Commit**

```bash
git add src/egress/preflight.ts src/egress/skip-store.ts src/egress/gate.ts test/unit/egress-diagnostic-kind.test.ts
git commit -m "feat(egress): add the diagnostic pre-flight kind"
```

---

### Task 6: The three commands

**Files:**
- Create: `src/diagnostics/commands.ts`
- Test: `test/unit/diagnostics-commands.test.ts`

**Interfaces:**
- Consumes: `DiagnosticContext` (Task 2); `buildExplainPrompt`/`buildFixPrompt` (Task 3); `extractCode`, `isWholeFileRewrite`, `spliceSelection` from `../scm/generate.js`; `extractReply` from `../quick-ask.js`; `isEgressCancelled` from `../egress/gated-client.js`; `EgressMeta` from `../egress/preflight.js`; `WindowApi` from `../vscode-shim.js`; `Logger` from `../logging.js`.
- Produces:
  - `interface DiagnosticActionArg { context: DiagnosticContext; fullText: string; query: string }`
  - `interface DiagnosticClientLike { agentInvoke(input: string, opts: { stream: boolean; agent?: string }, meta: EgressMeta, progressTitle?: string): Promise<unknown> }`
  - `interface DiagnosticCommandDeps { client(): DiagnosticClientLike | undefined; window: WindowApi; agent(): string; openReadonly(title: string, content: string): Promise<void>; openDiff(opts: { title: string; left: string; right: string; fileName: string }): Promise<void>; search(query: string): void; log: Logger }`
  - `function diagnosticMeta(ctx: DiagnosticContext, action: string): EgressMeta`
  - `function createDiagnosticCommands(deps: DiagnosticCommandDeps): { explain(arg: unknown): Promise<void>; fix(arg: unknown): Promise<void>; priorOccurrences(arg: unknown): Promise<void> }`

The handlers take `unknown` because VS Code hands back whatever the code action put in `command.arguments`; each one narrows before use.

- [ ] **Step 1: Write the failing test**

Create `test/unit/diagnostics-commands.test.ts`:

```ts
import { describe, expect, test, vi } from "vitest";

import type { DiagnosticContext } from "../../src/diagnostics/context.js";
import {
  type DiagnosticActionArg,
  createDiagnosticCommands,
  diagnosticMeta,
} from "../../src/diagnostics/commands.js";

const context: DiagnosticContext = {
  fileName: "a.ts",
  languageId: "typescript",
  message: "Object is possibly 'undefined'.",
  severityLabel: "error",
  source: "ts",
  code: "2532",
  startLine: 2,
  endLine: 2,
  snippet: "const x = maybe();\nx.go();",
  truncated: false,
  // 19 is the start of line 2 ("const x = maybe();\n" is 19 chars); 26 is its
  // end. The range MUST cover the trailing ";" — stopping at 25 splices in a
  // replacement that already ends in ";" and leaves the original's behind.
  offsets: { start: 19, end: 26 },
};

const fullText = "const x = maybe();\nx.go();\nmore();";
const arg: DiagnosticActionArg = { context, fullText, query: "2532 Object is possibly" };

function harness(over: Partial<Parameters<typeof createDiagnosticCommands>[0]> = {}) {
  const agentInvoke = vi.fn().mockResolvedValue({ reply: "```ts\nx?.go();\n```" });
  const deps = {
    client: () => ({ agentInvoke }),
    window: {
      showErrorMessage: vi.fn(),
      showInformationMessage: vi.fn(),
      showWarningMessage: vi.fn(),
    } as unknown as Parameters<typeof createDiagnosticCommands>[0]["window"],
    agent: () => "",
    openReadonly: vi.fn().mockResolvedValue(undefined),
    openDiff: vi.fn().mockResolvedValue(undefined),
    search: vi.fn(),
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ...over,
  };
  return { deps, agentInvoke, cmds: createDiagnosticCommands(deps) };
}

describe("diagnosticMeta", () => {
  test("names the redacted file and the line range, and nothing else", () => {
    const meta = diagnosticMeta(context, "Explain Problem");
    expect(meta.action).toBe("Explain Problem");
    expect(meta.files).toEqual([{ name: "a.ts", note: "lines 2-2 around the problem" }]);
    expect(meta.omissions[0]).toContain("rest of the file");
  });

  test("adds a truncation omission when the snippet hit its budget", () => {
    expect(diagnosticMeta({ ...context, truncated: true }, "Suggest Fix").omissions).toHaveLength(2);
  });
});

describe("explain", () => {
  test("sends the prompt through the seam and opens the reply read-only", async () => {
    const { cmds, deps, agentInvoke } = harness();
    await cmds.explain(arg);
    expect(agentInvoke).toHaveBeenCalledTimes(1);
    expect(agentInvoke.mock.calls[0]?.[0]).toContain("Object is possibly 'undefined'.");
    expect(deps.openReadonly).toHaveBeenCalledWith("Nimbus explanation.md", expect.any(String));
  });

  test("reports a disconnected Gateway instead of assembling a payload", async () => {
    const { cmds, deps, agentInvoke } = harness({ client: () => undefined });
    await cmds.explain(arg);
    expect(agentInvoke).not.toHaveBeenCalled();
    expect(deps.window.showErrorMessage).toHaveBeenCalledWith("Nimbus: not connected to Gateway.");
  });

  test("says so when the agent returns no reply", async () => {
    const agentInvoke = vi.fn().mockResolvedValue({ reply: "   " });
    const { cmds, deps } = harness({ client: () => ({ agentInvoke }) });
    await cmds.explain(arg);
    expect(deps.window.showInformationMessage).toHaveBeenCalled();
    expect(deps.openReadonly).not.toHaveBeenCalled();
  });

  test("stays silent when the user cancels at the pre-flight preview", async () => {
    const { EgressCancelled } = await import("../../src/egress/gated-client.js");
    const agentInvoke = vi.fn().mockRejectedValue(new EgressCancelled());
    const { cmds, deps } = harness({ client: () => ({ agentInvoke }) });
    await cmds.explain(arg);
    expect(deps.window.showErrorMessage).not.toHaveBeenCalled();
    expect(deps.openReadonly).not.toHaveBeenCalled();
  });

  test("reports a thrown failure once, without escaping as a rejection", async () => {
    const agentInvoke = vi.fn().mockRejectedValue(new Error("socket gone"));
    const { cmds, deps } = harness({ client: () => ({ agentInvoke }) });
    await expect(cmds.explain(arg)).resolves.toBeUndefined();
    expect(deps.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining("socket gone"),
    );
  });
});

describe("fix", () => {
  test("splices the replacement in and diffs against the real file", async () => {
    const { cmds, deps } = harness();
    await cmds.fix(arg);
    expect(deps.openDiff).toHaveBeenCalledWith({
      title: "a.ts ↔ Nimbus fix",
      left: fullText,
      right: "const x = maybe();\nx?.go();\nmore();",
      fileName: "a.ts",
    });
  });

  test("diffs whole-file rather than splicing when the reply is the whole file", async () => {
    const whole = "const x = maybe();\nx?.go();\nmore();";
    const agentInvoke = vi.fn().mockResolvedValue({ reply: `\`\`\`ts\n${whole}\n\`\`\`` });
    const { cmds, deps } = harness({ client: () => ({ agentInvoke }) });
    await cmds.fix(arg);
    expect(deps.openDiff).toHaveBeenCalledWith(expect.objectContaining({ right: whole }));
  });

  test("never applies an edit — the diff is the whole output", async () => {
    const { cmds, deps } = harness();
    await cmds.fix(arg);
    expect(Object.keys(deps)).not.toContain("applyEdit");
  });
});

describe("priorOccurrences", () => {
  test("seeds the search picker with the normalized query", async () => {
    const { cmds, deps, agentInvoke } = harness();
    await cmds.priorOccurrences(arg);
    expect(deps.search).toHaveBeenCalledWith("2532 Object is possibly");
    expect(agentInvoke).not.toHaveBeenCalled();
  });

  test("ignores a malformed argument rather than throwing", async () => {
    const { cmds, deps } = harness();
    await cmds.priorOccurrences({ nope: true });
    expect(deps.search).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bunx vitest run test/unit/diagnostics-commands.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `src/diagnostics/commands.ts`:

```ts
import { isEgressCancelled } from "../egress/gated-client.js";
import type { EgressMeta } from "../egress/preflight.js";
import { errMsg, type Logger } from "../logging.js";
import { extractReply } from "../quick-ask.js";
import { extractCode, isWholeFileRewrite, spliceSelection } from "../scm/generate.js";
import type { WindowApi } from "../vscode-shim.js";
import type { DiagnosticContext } from "./context.js";
import { buildExplainPrompt, buildFixPrompt } from "./prompts.js";

// What the code action hands back to the command. Built once in the provider,
// which is the only place holding the document.
export interface DiagnosticActionArg {
  context: DiagnosticContext;
  fullText: string;
  query: string;
}

// The third argument is the guardrail: the raw NimbusClient does not satisfy
// this shape, so only a wrapper from src/egress/gated-client.ts fits here.
export interface DiagnosticClientLike {
  agentInvoke(
    input: string,
    opts: { stream: boolean; agent?: string },
    meta: EgressMeta,
    progressTitle?: string,
  ): Promise<unknown>;
}

export interface DiagnosticCommandDeps {
  client(): DiagnosticClientLike | undefined; // undefined = disconnected
  window: WindowApi;
  agent(): string; // askAgent() setting; "" = omit
  openReadonly(title: string, content: string): Promise<void>;
  openDiff(opts: { title: string; left: string; right: string; fileName: string }): Promise<void>;
  /** Seeds the existing search Quick Pick. No model, no gate. */
  search(query: string): void;
  log: Logger;
}

// The manifest for a diagnostic action. The file name is already redacted by
// buildDiagnosticContext; the note states the range so "what leaves" is not
// vaguer than what is actually sent.
export function diagnosticMeta(ctx: DiagnosticContext, action: string): EgressMeta {
  const omissions = [`The rest of the file is not sent — only lines ${ctx.startLine}-${ctx.endLine} and their surrounding context.`];
  if (ctx.truncated) omissions.push("Context truncated at 50000 characters.");
  return {
    action,
    files: [{ name: ctx.fileName, note: `lines ${ctx.startLine}-${ctx.endLine} around the problem` }],
    omissions,
  };
}

// VS Code hands the command whatever the code action stored, so narrow before
// use rather than trusting the shape.
function asArg(value: unknown): DiagnosticActionArg | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const rec = value as Record<string, unknown>;
  const context = rec["context"];
  if (typeof context !== "object" || context === null) return undefined;
  if (typeof rec["fullText"] !== "string" || typeof rec["query"] !== "string") return undefined;
  return value as DiagnosticActionArg;
}

export function createDiagnosticCommands(deps: DiagnosticCommandDeps): {
  explain(arg: unknown): Promise<void>;
  fix(arg: unknown): Promise<void>;
  priorOccurrences(arg: unknown): Promise<void>;
} {
  // One shared try/catch, so a throw anywhere inside a handler is reported the
  // same way — and a pre-flight cancellation stays silent, exactly as dismissing
  // a Quick Pick does.
  const contain =
    (internalName: string, humanName: string, body: (arg: DiagnosticActionArg) => Promise<void>) =>
    async (raw: unknown): Promise<void> => {
      const arg = asArg(raw);
      if (arg === undefined) {
        deps.log.warn(`nimbus.${internalName} called without a diagnostic argument`);
        return;
      }
      try {
        await body(arg);
      } catch (e) {
        if (isEgressCancelled(e)) {
          deps.log.debug(`nimbus.${internalName} cancelled at the pre-flight preview`);
          return;
        }
        deps.log.error(`nimbus.${internalName} failed: ${errMsg(e)}`);
        void deps.window.showErrorMessage(`Nimbus ${humanName} failed: ${errMsg(e)}`);
      }
    };

  // Connection is checked before any payload is assembled, so a disconnected
  // Gateway costs nothing and reports the real problem.
  const requireClient = (): DiagnosticClientLike | undefined => {
    const client = deps.client();
    if (client === undefined) {
      void deps.window.showErrorMessage("Nimbus: not connected to Gateway.");
    }
    return client;
  };

  const invoke = async (
    client: DiagnosticClientLike,
    prompt: string,
    title: string,
    meta: EgressMeta,
  ): Promise<string | undefined> => {
    const agent = deps.agent();
    const options: { stream: boolean; agent?: string } = { stream: false };
    if (agent.length > 0) options.agent = agent;
    deps.log.debug(`diagnostics: sending ${prompt.length} chars to agentInvoke`);
    const reply = extractReply(await client.agentInvoke(prompt, options, meta, title));
    if (reply === undefined) {
      void deps.window.showInformationMessage("Nimbus: the agent returned no reply.", {});
    }
    return reply;
  };

  return {
    explain: contain("diagnosticExplain", "explain", async ({ context }) => {
      const client = requireClient();
      if (client === undefined) return;
      const reply = await invoke(
        client,
        buildExplainPrompt(context),
        "Nimbus: explaining…",
        diagnosticMeta(context, "Explain Problem"),
      );
      if (reply === undefined) return;
      await deps.openReadonly("Nimbus explanation.md", reply);
    }),

    fix: contain("diagnosticFix", "suggest a fix", async ({ context, fullText }) => {
      const client = requireClient();
      if (client === undefined) return;
      const reply = await invoke(
        client,
        buildFixPrompt(context),
        "Nimbus: suggesting a fix…",
        diagnosticMeta(context, "Suggest Fix"),
      );
      if (reply === undefined) return;
      const rewritten = extractCode(reply);
      const { start, end } = context.offsets;
      // A whole-file reply to a region prompt must not be spliced — that would
      // duplicate everything around the diagnostic. Diff whole-file instead,
      // which is what the reply actually is. Same rule as generateDocstrings.
      const spliceable = !isWholeFileRewrite(rewritten, fullText, start, end);
      if (!spliceable) {
        deps.log.debug("diagnostics: fix reply looks whole-file; diffing without splicing");
      }
      await deps.openDiff({
        title: `${context.fileName} ↔ Nimbus fix`,
        left: fullText,
        right: spliceable ? spliceSelection(fullText, start, end, rewritten) : rewritten,
        fileName: context.fileName,
      });
    }),

    // No model, no gate: searchRanked is a local-index read. It still needs the
    // Gateway socket, which actions.ts has already checked before offering this.
    priorOccurrences: contain("diagnosticPriorOccurrences", "find prior occurrences", async ({ query }) => {
      deps.search(query);
    }),
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bunx vitest run test/unit/diagnostics-commands.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Run the choke-point test — it must still hold**

Run: `bunx vitest run test/unit/egress-choke-point.test.ts`
Expected: PASS. `commands.ts` calls `client.agentInvoke(...)` on an *injected seam*, never a raw client, which is the allowlisted shape. If it fails, the test will name the offending file — do not edit the test.

- [ ] **Step 6: Lint, typecheck and commit**

```bash
bun run typecheck && bun run lint
git add src/diagnostics/commands.ts test/unit/diagnostics-commands.test.ts
git commit -m "feat(diagnostics): explain, fix and prior-occurrences commands"
```

---

### Task 7: Register the provider and wire it up

**Files:**
- Create: `src/diagnostics/real-provider.ts`
- Modify: `src/settings.ts` (add `showDiagnosticCodeActions()`)
- Modify: `src/extension.ts` (add `emptyText` to `runSearch`; wire the commands and register the provider)
- Modify: `package.json` (three commands, three `commandPalette` entries, `contributes.codeActions`, one configuration property)
- Modify: `docs/settings.md` (document the setting)
- Test: `test/unit/manifest-diagnostics.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–6.
- Produces: `function registerDiagnosticCodeActions(opts: { offer: (diagnostics: readonly DiagnosticLike[]) => ReturnType<typeof diagnosticActionsFor>; buildArg: (document: vscode.TextDocument, diagnostic: DiagnosticLike) => DiagnosticActionArg }): { dispose(): void }`

- [ ] **Step 1: Write the failing manifest test**

Create `test/unit/manifest-diagnostics.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { DIAGNOSTIC_COMMANDS } from "../../src/diagnostics/actions.js";

type Command = { command: string; title: string; category?: string };
type MenuEntry = { command: string; when?: string };

const manifest = JSON.parse(readFileSync(join(__dirname, "..", "..", "package.json"), "utf8")) as {
  contributes?: {
    commands?: Command[];
    menus?: { commandPalette?: MenuEntry[] };
    configuration?: { properties?: Record<string, { type?: string; default?: unknown; description?: string }> };
    codeActions?: unknown[];
  };
};

const commands = manifest.contributes?.commands ?? [];
const palette = manifest.contributes?.menus?.commandPalette ?? [];
const properties = manifest.contributes?.configuration?.properties ?? {};
const ids = Object.values(DIAGNOSTIC_COMMANDS);

describe("extension manifest: diagnostic actions", () => {
  test("declares all three commands the code actions reference", () => {
    for (const id of ids) {
      expect(commands.some((c) => c.command === id)).toBe(true);
    }
  });

  test("hides all three from the palette — each needs a diagnostic argument", () => {
    for (const id of ids) {
      expect(palette.some((m) => m.command === id && m.when === "false")).toBe(true);
    }
  });

  test("declares the setting, defaulting on", () => {
    const prop = properties["nimbus.diagnostics.showCodeActions"];
    expect(prop?.type).toBe("boolean");
    expect(prop?.default).toBe(true);
    expect(prop?.description).toBeTruthy();
  });

  test("declares codeActions metadata so the actions are discoverable in settings", () => {
    expect(Array.isArray(manifest.contributes?.codeActions)).toBe(true);
    expect(JSON.stringify(manifest.contributes?.codeActions)).toContain("quickfix.nimbus");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bunx vitest run test/unit/manifest-diagnostics.test.ts`
Expected: FAIL — all four assertions.

- [ ] **Step 3: Add the manifest entries**

In `package.json` → `contributes.commands`, append:

```json
{ "command": "nimbus.diagnosticExplain", "title": "Explain this problem", "category": "Nimbus" },
{ "command": "nimbus.diagnosticFix", "title": "Suggest a fix", "category": "Nimbus" },
{ "command": "nimbus.diagnosticPriorOccurrences", "title": "Find prior occurrences", "category": "Nimbus" }
```

In `contributes.menus.commandPalette`, append (creating the array if absent):

```json
{ "command": "nimbus.diagnosticExplain", "when": "false" },
{ "command": "nimbus.diagnosticFix", "when": "false" },
{ "command": "nimbus.diagnosticPriorOccurrences", "when": "false" }
```

Add a top-level `contributes.codeActions` entry:

```json
"codeActions": [
  {
    "languages": ["*"],
    "actions": [
      { "kind": "quickfix.nimbus.explain", "title": "Explain this problem", "description": "Ask Nimbus what this diagnostic means." },
      { "kind": "quickfix.nimbus.fix", "title": "Suggest a fix", "description": "Ask Nimbus for a fix, shown as a diff you apply yourself." },
      { "kind": "quickfix.nimbus.priorOccurrences", "title": "Find prior occurrences", "description": "Search the local Nimbus index for this error." }
    ]
  }
]
```

In `contributes.configuration.properties`, add:

```json
"nimbus.diagnostics.showCodeActions": {
  "type": "boolean",
  "default": true,
  "description": "Offer Nimbus actions (explain, suggest a fix, find prior occurrences) on the lightbulb for errors and warnings."
}
```

- [ ] **Step 4: Document the setting**

Add this section to `docs/settings.md`, after the `### nimbus.briefs.defaultNamespace` section (the file uses one `###` heading per setting, followed by a paragraph starting with the type and default):

```markdown
### `nimbus.diagnostics.showCodeActions`

`boolean` (default `true`). Puts three Nimbus actions on the lightbulb for an error or a warning: **Explain this problem**, **Suggest a fix** (shown as a diff you apply yourself — Nimbus never edits your code), and **Find prior occurrences** (a search of the local index for the same error, which reaches no model). `Information` and `Hint` diagnostics are never offered. Where a line carries several diagnostics, exactly one is chosen — highest severity first — so the lightbulb gains three entries, never three per diagnostic. The two model-bound actions route through the [pre-flight egress gate](#nimbusegressshowstatusbarbadge); all three need a connected Gateway. Set to `false` to turn the lightbulb entries off.
```

Run: `bun run check-settings-docs`
Expected: PASS.

- [ ] **Step 5: Add the settings accessor**

In `src/settings.ts`, add to the `Settings` interface and the returned object:

```ts
  showDiagnosticCodeActions(): boolean;
```

```ts
    showDiagnosticCodeActions: () => cfg().get<boolean>("diagnostics.showCodeActions", true),
```

- [ ] **Step 6: Run the manifest test**

Run: `bunx vitest run test/unit/manifest-diagnostics.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 7: Write the provider glue**

Create `src/diagnostics/real-provider.ts`:

```ts
import * as vscode from "vscode";

import type { diagnosticActionsFor } from "./actions.js";
import type { DiagnosticActionArg } from "./commands.js";
import type { DiagnosticLike } from "./context.js";

// Thin vscode-API glue — mirrors real-hover.ts and real-participant.ts. Every
// decision (which diagnostic, which actions, what to send) lives in the pure
// modules, which carry the tests.

// `file` only: an untitled buffer and a virtual document — our own read-only
// reply tabs included — have no place in a repo-grounded question.
const SELECTOR: vscode.DocumentSelector = { scheme: "file" };

// Declared so VS Code can advertise what this provider can produce.
const PROVIDED = [
  vscode.CodeActionKind.QuickFix.append("nimbus").append("explain"),
  vscode.CodeActionKind.QuickFix.append("nimbus").append("fix"),
  vscode.CodeActionKind.QuickFix.append("nimbus").append("priorOccurrences"),
];

// vscode.Diagnostic is NOT structurally a DiagnosticLike: its `code` may be a
// { value, target } object, and `exactOptionalPropertyTypes` forbids passing an
// explicit `undefined` for an optional field — hence the conditional spreads.
function toLike(d: vscode.Diagnostic): DiagnosticLike {
  const code = typeof d.code === "object" && d.code !== null ? d.code.value : d.code;
  return {
    message: d.message,
    severity: d.severity,
    ...(d.source === undefined ? {} : { source: d.source }),
    ...(code === undefined ? {} : { code }),
    range: {
      start: { line: d.range.start.line, character: d.range.start.character },
      end: { line: d.range.end.line, character: d.range.end.character },
    },
  };
}

export function registerDiagnosticCodeActions(opts: {
  offer: (diagnostics: readonly DiagnosticLike[]) => ReturnType<typeof diagnosticActionsFor>;
  buildArg: (document: vscode.TextDocument, diagnostic: DiagnosticLike) => DiagnosticActionArg;
}): { dispose(): void } {
  return vscode.languages.registerCodeActionsProvider(
    SELECTOR,
    {
      provideCodeActions: (document, _range, context) => {
        const likes = context.diagnostics.map(toLike);
        const offered = opts.offer(likes);
        if (offered === undefined) return undefined;
        const arg = opts.buildArg(document, offered.diagnostic);
        // selectDiagnostic returns one of the objects it was given, so index
        // identity recovers the real Diagnostic to attach below.
        const chosen = context.diagnostics[likes.indexOf(offered.diagnostic)];
        return offered.actions.map((descriptor) => {
          const action = new vscode.CodeAction(
            descriptor.title,
            vscode.CodeActionKind.Empty.append(descriptor.kind),
          );
          // A COMMAND, never an `edit`: selecting this must run something, not
          // apply a change. `isPreferred` is left unset — Auto Fix considers
          // only preferred actions, and must never fire a gated model call.
          action.command = {
            command: descriptor.commandId,
            title: descriptor.title,
            arguments: [arg],
          };
          // Associates the action with the squiggle that produced it.
          if (chosen !== undefined) action.diagnostics = [chosen];
          return action;
        });
      },
    },
    { providedCodeActionKinds: PROVIDED },
  );
}
```

- [ ] **Step 8: Wire it in `extension.ts`**

First, add the empty-state override to `runSearch` (around line 806). Its signature already is:

```ts
  const runSearch = (
    initialValue?: string,
    opts?: { placeholder?: string; exclude?: (r: RankedResult) => boolean },
  ): void => {
```

so `placeholder` needs nothing — `emptyText?: string` is the only addition to that `opts` type. Then change the empty branch:

```ts
          qp.items = picks.length > 0 ? picks : [statusPick(opts?.emptyText ?? "No matching index records")];
```

Then, next to the `registerWhyPeekHover` wiring (around line 753), add:

```ts
  const diagnosticCommands = createDiagnosticCommands({
    client: () => {
      const client = nimbus();
      return client === undefined
        ? undefined
        : { agentInvoke: gateRawAgentInvoke(client, egressGate, "diagnostic", runWithProgress) };
    },
    window: deps.window,
    agent: () => settings.askAgent(),
    openReadonly: openReadonlyJson,
    openDiff,
    search: (query) =>
      runSearch(query, {
        placeholder: "Prior occurrences of this error",
        emptyText: "Nimbus: nothing in the local index matches this error.",
      }),
    log,
  });

  register(DIAGNOSTIC_COMMANDS.explain, (arg) => diagnosticCommands.explain(arg));
  register(DIAGNOSTIC_COMMANDS.fix, (arg) => diagnosticCommands.fix(arg));
  register(DIAGNOSTIC_COMMANDS.priorOccurrences, (arg) =>
    diagnosticCommands.priorOccurrences(arg),
  );

  ctx.subscriptions.push(
    registerDiagnosticCodeActions({
      offer: (diagnostics) =>
        diagnosticActionsFor({
          diagnostics,
          connected: nimbus() !== undefined,
          enabled: settings.showDiagnosticCodeActions(),
        }),
      buildArg: (document, diagnostic) => {
        const fullText = document.getText();
        return {
          context: buildDiagnosticContext({
            fullText,
            fileName: document.fileName,
            languageId: document.languageId,
            diagnostic,
          }),
          fullText,
          query: normalizeDiagnosticMessage(diagnostic),
        };
      },
    }),
  );
```

Add the imports at the top of `extension.ts`:

```ts
import { DIAGNOSTIC_COMMANDS, diagnosticActionsFor } from "./diagnostics/actions.js";
import { createDiagnosticCommands } from "./diagnostics/commands.js";
import { buildDiagnosticContext } from "./diagnostics/context.js";
import { normalizeDiagnosticMessage } from "./diagnostics/normalize.js";
import { registerDiagnosticCodeActions } from "./diagnostics/real-provider.js";
```

`register` and `runSearch` are both defined above this point in `activate`; if the ordering complains, move the block below `runSearch`'s definition rather than hoisting anything.

- [ ] **Step 9: Run everything**

Run: `bun run test && bun run typecheck && bun run lint && bun run check-settings-docs`
Expected: all green, with the new tests included in the count.

- [ ] **Step 10: Build and check the bundle invariants**

Run: `bun run build && bun run check-bundle && bun run check-vsix-contents`
Expected: all pass — `vscode` remains the only external.

- [ ] **Step 11: Commit**

```bash
git add src/diagnostics/real-provider.ts src/extension.ts src/settings.ts package.json docs/settings.md test/unit/manifest-diagnostics.test.ts
git commit -m "feat(diagnostics): offer explain, fix and prior-occurrences on the lightbulb"
```

---

### Task 8: Verify in a real editor, then update the docs

**Files:**
- Modify: `docs/ROADMAP.md`
- Modify: `CLAUDE.md` (the *Surface today* paragraph)

Unit tests cannot prove a code action renders. This task is the F5 pass and the doc updates that depend on its outcome.

- [ ] **Step 1: Clear the outstanding verification debt first**

The Workflows view (#95) and the run/cancel surface (#96) shipped in `0.16.0` having never been driven in an Extension Development Host. Adding surface area on top of unverified surface area compounds the risk, so check those first. With a Gateway running and at least one saved workflow, confirm: the Run / Dry-Run context-menu items appear on a workflow row; the pre-flight modal renders the step list for kind `"workflow"`; and cancel shows the next-step-boundary wording.

Consider invoking the `verify-extension` skill, which drives this whole gate.

- [ ] **Step 2: Press F5 and check the lightbulb**

With a Gateway running, open a file with a real TypeScript error:

1. Exactly **three** Nimbus actions appear — not three per diagnostic. On a line carrying both a compiler error and an ESLint warning, still exactly three, labelled with the error's code.
2. No Nimbus action appears on a `Hint`-severity diagnostic.
3. `Ctrl+.` reaches all three (they are palette-hidden, so this is the only keyboard path).
4. `Shift+Alt+.` (Auto Fix) fires **none** of them.
5. Neither `nimbus.diagnosticExplain`, `nimbus.diagnosticFix`, nor `nimbus.diagnosticPriorOccurrences` appears in the command palette.

- [ ] **Step 3: Check each action end to end**

1. **Explain** — the pre-flight modal shows kind `Diagnostic Actions`, the redacted basename, and the line range; *Show full text* renders the exact bytes; *Always send here* persists across a reload of the same workspace and not into another.
2. **Fix** — the diff is scoped to the fix, not a whole-file mismatch; applying it is done by the user through the diff editor, and nothing is applied on selecting the action.
3. **Prior occurrences** — the Quick Pick opens seeded with the normalized query, and on a thin index shows *"Nimbus: nothing in the local index matches this error."*

- [ ] **Step 4: Record what the pass found**

If the lightbulb reads as noisy in practice, the spec names the two remedies (narrow to errors only, or fold explain and fix into one action) and Part 9 names `nimbus.diagnostics.ignoredSources` as the escape hatch to add on this evidence. Any of those is a follow-up commit in this branch, not a silent change of plan.

- [ ] **Step 5: Update the roadmap and CLAUDE.md**

In `docs/ROADMAP.md`:
- Add a row to **Already shipped** for the diagnostic actions, naming `agentInvoke` + `searchRanked`.
- Remove the Phase 3 row *"Ask Nimbus about this problem" code action on a diagnostic*.
- Amend the Phase 3 row *Quick-ask code-editing actions* to record that the diagnostic fix action delivers this pattern for diagnostics, with the rest still open.

In `CLAUDE.md`, extend the *Surface today* paragraph with the diagnostic actions, and add `"diagnostic"` to the list of gated kinds in the pre-flight description.

- [ ] **Step 6: Final gate and commit**

Run: `bun run test && bun run typecheck && bun run lint && bun run check-settings-docs && bun run build && bun run check-bundle && bun run check-vsix-contents`

```bash
git add docs/ROADMAP.md CLAUDE.md
git commit -m "docs: record the diagnostic actions surface"
```

- [ ] **Step 7: Open the PR**

Title (Release Please reads it): `feat(diagnostics): offer explain, fix and prior-occurrences on the lightbulb`

The body should state what was verified in the Extension Development Host and what the F5 pass changed, if anything.
