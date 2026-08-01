import * as vscode from "vscode";

import {
  buildAskConfirmation,
  type LmToolsDeps,
  runNimbusAskTool,
  runNimbusSearchTool,
} from "./lm-tools.js";

// Thin vscode-API glue — mirrors real-participant.ts. Excluded from coverage;
// the pure handlers (lm-tools.ts) carry the logic and the tests.

function asToolResult(text: string): vscode.LanguageModelToolResult {
  return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
}

// Registers the two LM tools declared in package.json contributes.languageModelTools.
// Registration is unconditional at activation: the pure handlers answer with a
// "gateway not connected" explanation when the client is absent, which reads far
// better to the calling model than an unregistered-tool error.
export function registerNimbusLmTools(opts: { deps: LmToolsDeps }): { dispose(): void } {
  const search = vscode.lm.registerTool("nimbus_search", {
    invoke: async (options) => asToolResult(await runNimbusSearchTool(opts.deps, options.input)),
  });
  const ask = vscode.lm.registerTool("nimbus_ask", {
    // The inline Continue/Cancel card in the CALLING chat — no modal, no focus
    // steal, and VS Code remembers the choice for the session. The message is
    // ours, built by the same renderer the Nimbus-owned surfaces use, so the
    // leak check runs on this path too.
    prepareInvocation: (options) => {
      const messages = buildAskConfirmation(opts.deps, options.input);
      return messages === undefined
        ? { invocationMessage: "Asking Nimbus…" }
        : { invocationMessage: "Asking Nimbus…", confirmationMessages: messages };
    },
    invoke: async (options) => asToolResult(await runNimbusAskTool(opts.deps, options.input)),
  });
  return {
    dispose: (): void => {
      search.dispose();
      ask.dispose();
    },
  };
}
