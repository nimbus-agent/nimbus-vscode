import * as vscode from "vscode";

import { type LmToolsDeps, runNimbusAskTool, runNimbusSearchTool } from "./lm-tools.js";

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
    invoke: async (options) => asToolResult(await runNimbusAskTool(opts.deps, options.input)),
  });
  return {
    dispose: (): void => {
      search.dispose();
      ask.dispose();
    },
  };
}
