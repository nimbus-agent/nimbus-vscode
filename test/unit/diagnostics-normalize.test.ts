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
      normalizeDiagnosticMessage({
        message: "Failed reading C:\\Users\\dev\\repo\\src\\a.ts here",
      }),
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
    ).toBe("2345 Argument of type 'string' is not assignable to parameter of type 'number'.");
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

  test("keeps a separator-ful token whose dot-extension is not the last segment", () => {
    // `a.ts/b` has a separator and a dot, but nothing file-shaped after the last
    // separator — so the path rule leaves it alone.
    expect(normalizeDiagnosticMessage({ message: "Type 'a.ts/b' is not assignable." })).toBe(
      "Type 'a.ts/b' is not assignable.",
    );
  });

  test("stays linear on separator-heavy input with no extension", () => {
    // This runs synchronously inside provideCodeActions, which VS Code calls on
    // every cursor move, and the clamp to NORMALIZED_QUERY_MAX_CHARS happens
    // AFTER these rules — so the input is the raw, unbounded diagnostic message.
    // The previous path pattern backtracked cubically on exactly this shape:
    // ~9 ms at 500 characters, ~500 ms at 2 000, ~31 s at 8 000. A message that
    // long would have frozen the lightbulb.
    const message = `${"a/".repeat(6000)}!`;
    expect(message.length).toBeGreaterThanOrEqual(8000);
    const started = performance.now();
    normalizeDiagnosticMessage({ message });
    expect(performance.now() - started).toBeLessThan(100);
  });

  test("stays linear on a long whitespace run", () => {
    // HONEST NOTE ON WHAT THIS DOES AND DOES NOT PROVE: it does NOT discriminate
    // the punctuation-tidy pattern this was added alongside. That step used to be
    // `\s+([.,;:])`, which is quadratic on a whitespace run not followed by
    // punctuation (20 000 spaces 98 ms, 40 000 spaces 396 ms measured standalone) —
    // but the collapse immediately before it reduces every run to one space, so the
    // quadratic was unreachable through this function and this test passes against
    // both the old and the new pattern. It is a forward guard on the whole
    // pipeline's linearity, not a red-proof of that change.
    //
    // It has teeth for a different reason: it is the test that fails if anyone
    // reorders the collapse, or reintroduces an unbounded whitespace quantifier
    // followed by another element anywhere in the chain.
    const message = `${" ".repeat(40000)}x`;
    const started = performance.now();
    normalizeDiagnosticMessage({ message });
    expect(performance.now() - started).toBeLessThan(100);
  });
});
