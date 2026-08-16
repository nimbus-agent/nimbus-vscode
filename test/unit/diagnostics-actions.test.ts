import { describe, expect, test } from "vitest";
import { diagnosticActionsFor, selectDiagnostic } from "../../src/diagnostics/actions.js";
import type { DiagnosticLike } from "../../src/diagnostics/context.js";

// `over` allows explicit `undefined` for the optional fields (`source`,
// `code`) so a test can construct a diagnostic that carries NEITHER — under
// exactOptionalPropertyTypes, Partial<DiagnosticLike> alone can't express
// "unset this field". The merge below deletes any key that ends up
// undefined so the returned object matches DiagnosticLike exactly.
type DiagnosticOverride = Omit<Partial<DiagnosticLike>, "source" | "code"> & {
  source?: string | undefined;
  code?: string | number | undefined;
};

const d = (over: DiagnosticOverride = {}): DiagnosticLike => {
  const merged: Record<string, unknown> = {
    message: "Argument of type 'string' is not assignable to parameter of type 'number'.",
    severity: 0,
    source: "ts",
    code: 2345,
    range: { start: { line: 4, character: 0 }, end: { line: 4, character: 10 } },
    ...over,
  };
  for (const key of Object.keys(merged)) {
    if (merged[key] === undefined) delete merged[key];
  }
  return merged as unknown as DiagnosticLike;
};

const offer = (over: Partial<Parameters<typeof diagnosticActionsFor>[0]> = {}) =>
  diagnosticActionsFor({ diagnostics: [d()], connected: true, enabled: true, ...over });

describe("selectDiagnostic", () => {
  test("prefers an error over a warning", () => {
    const warning = d({ severity: 1, code: "W" });
    const error = d({ severity: 0, code: "E" });
    expect(selectDiagnostic([warning, error])?.code).toBe("E");
  });

  test("breaks a severity tie on the smaller range", () => {
    const wide = d({
      code: "WIDE",
      range: { start: { line: 4, character: 0 }, end: { line: 9, character: 0 } },
    });
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
