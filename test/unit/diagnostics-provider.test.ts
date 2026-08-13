import { beforeEach, describe, expect, test } from "vitest";

import { DIAGNOSTIC_COMMANDS, diagnosticActionsFor } from "../../src/diagnostics/actions.js";
import { buildDiagnosticContext } from "../../src/diagnostics/context.js";
import { normalizeDiagnosticMessage } from "../../src/diagnostics/normalize.js";
import { registerDiagnosticCodeActions } from "../../src/diagnostics/real-provider.js";
import { languages } from "./vscode-stub.js";

// real-provider.ts is thin glue, but two of its guarantees are the ABSENCE of an
// assignment — no `edit`, never `isPreferred` — and an absence is exactly what
// review misses and a rewrite reintroduces. Both are non-negotiables: an `edit`
// would be applied the moment the user picked the action (never an applied
// edit), and `isPreferred` would let Auto Fix fire a gated model call from a
// keystroke pressed to tidy lint.

const fullText = "const x = maybe();\nx.go();\nmore();";

const document = {
  fileName: "/home/dev/repo/src/a.ts",
  languageId: "typescript",
  getText: () => fullText,
};

// A vscode.Diagnostic-shaped object: `code` as an object, as a real language
// server may send it, so toLike's unwrapping is exercised too.
const diagnostic = {
  message: "Object is possibly 'undefined'.",
  severity: 0,
  source: "ts",
  code: { value: "2532", target: { toString: () => "https://ts/2532" } },
  range: {
    start: { line: 1, character: 0 },
    end: { line: 1, character: 1 },
  },
};

function drive(diagnostics: readonly unknown[]) {
  registerDiagnosticCodeActions({
    offer: (likes) => diagnosticActionsFor({ diagnostics: likes, connected: true, enabled: true }),
    buildArg: (doc, like) => ({
      context: buildDiagnosticContext({
        fullText: doc.getText(),
        fileName: doc.fileName,
        languageId: doc.languageId,
        diagnostic: like,
      }),
      fullText: doc.getText(),
      query: normalizeDiagnosticMessage(like),
    }),
  });
  const provider = languages.lastCodeActionsProvider;
  expect(provider).toBeDefined();
  return provider?.provideCodeActions(document, undefined, { diagnostics });
}

describe("registerDiagnosticCodeActions", () => {
  beforeEach(() => {
    languages.lastCodeActionsProvider = undefined;
  });

  test("offers a command per action and NEVER an edit or a preferred action", () => {
    const actions = drive([diagnostic]) ?? [];
    expect(actions).toHaveLength(3);
    for (const action of actions) {
      // Never an applied edit: selecting one runs a Nimbus command that SHOWS
      // something. The user applies it with the diff editor's own controls.
      expect(action.edit).toBeUndefined();
      // Auto Fix (Shift+Alt+.) considers only preferred actions.
      expect(action.isPreferred).toBeUndefined();
      expect(action.command).toBeDefined();
    }
    expect(actions.map((a) => a.command?.command)).toEqual([
      DIAGNOSTIC_COMMANDS.explain,
      DIAGNOSTIC_COMMANDS.fix,
      DIAGNOSTIC_COMMANDS.priorOccurrences,
    ]);
    expect(actions.map((a) => a.kind?.value)).toEqual([
      "quickfix.nimbus.explain",
      "quickfix.nimbus.fix",
      "quickfix.nimbus.priorOccurrences",
    ]);
  });

  test("attaches the SAME diagnostic object it was given, not a copy", () => {
    // selectDiagnostic returns one of the objects it was handed, so the provider
    // recovers the real vscode.Diagnostic by index. A clone anywhere along that
    // path would silently unhook every action from its squiggle.
    const other = {
      message: "'handleFoo' is defined but never used.",
      severity: 1,
      source: "eslint",
      code: "no-unused-vars",
      range: { start: { line: 1, character: 0 }, end: { line: 1, character: 9 } },
    };
    const actions = drive([other, diagnostic]) ?? [];
    expect(actions.length).toBeGreaterThan(0);
    for (const action of actions) {
      // The error outranks the warning, so it is the error's squiggle.
      expect(action.diagnostics?.[0]).toBe(diagnostic);
    }
  });

  test("passes the command the argument built from the chosen diagnostic", () => {
    const actions = drive([diagnostic]) ?? [];
    const arg = actions[0]?.command?.arguments?.[0] as {
      context: { fileName: string; offsets: { start: number; end: number } };
      fullText: string;
    };
    // Redacted to a basename, and spliceable over whole lines — line 2 of the
    // fixture runs from offset 19 to its "\n" at 26.
    expect(arg.context.fileName).toBe("a.ts");
    expect(arg.context.offsets).toEqual({ start: 19, end: 26 });
    expect(arg.fullText).toBe(fullText);
  });

  test("offers nothing on a hint, so the lightbulb stays quiet", () => {
    expect(drive([{ ...diagnostic, severity: 3 }])).toBeUndefined();
  });
});
