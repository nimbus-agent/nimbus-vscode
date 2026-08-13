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
  // Everything BUT `documentPath`: that one field is stamped below, from the
  // TextDocument this file already holds, so no wiring can forget it or supply
  // a path that is not the document's own.
  buildArg: (
    document: vscode.TextDocument,
    diagnostic: DiagnosticLike,
  ) => Omit<DiagnosticActionArg, "documentPath">;
}): { dispose(): void } {
  return vscode.languages.registerCodeActionsProvider(
    SELECTOR,
    {
      provideCodeActions: (document, _range, context) => {
        const likes = context.diagnostics.map(toLike);
        const offered = opts.offer(likes);
        if (offered === undefined) return undefined;
        // The un-redacted path rides along for ONE purpose: re-reading this
        // same document by path before the fix diff opens. `fileName` is
        // vscode's shorthand for `uri.fsPath`, which is what that lookup matches
        // on. It must never reach a prompt or the egress manifest — those use
        // the redacted basename buildDiagnosticContext produces.
        const arg: DiagnosticActionArg = {
          ...opts.buildArg(document, offered.diagnostic),
          documentPath: document.fileName,
        };
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
