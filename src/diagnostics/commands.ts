import { isEgressCancelled } from "../egress/gated-client.js";
import type { EgressMeta } from "../egress/preflight.js";
import { errMsg, type Logger } from "../logging.js";
import { extractReply, QUICK_ASK_MAX_CONTEXT_CHARS, redactPath } from "../quick-ask.js";
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

// The third argument documents intent — only a wrapper from
// src/egress/gated-client.ts has an EgressMeta to pass — and makes an ungated
// wiring obvious to a reviewer. It is NOT a type-level guarantee: TypeScript
// assigns a function with fewer parameters to one with more, so the raw
// NimbusClient's `agentInvoke(input, opts?)` satisfies this shape unchanged.
// The real enforcement is test/unit/egress-choke-point.test.ts, which asserts
// extension.ts — the one place holding a real client — never names the raw
// member; this module's place on that test's ALLOWED list is honour-system.
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
  const omissions = [
    `The rest of the file is not sent — only lines ${ctx.startLine}-${ctx.endLine} and their surrounding context.`,
  ];
  // Interpolated, not spelled out: context.ts clamps with this same constant,
  // and every other surface words it this way. A literal would drift silently
  // the day the budget changes.
  if (ctx.truncated) {
    omissions.push(`Context truncated at ${QUICK_ASK_MAX_CONTEXT_CHARS} characters.`);
  }
  return {
    action,
    files: [
      { name: ctx.fileName, note: `lines ${ctx.startLine}-${ctx.endLine} around the problem` },
    ],
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

  // The live text of the document the diagnostic came from, or undefined when
  // we cannot tell it is the same document — no editor is focused, or the user
  // moved to another file while the request was in flight. Undefined is
  // "unknown", not "changed": the fix path proceeds on its snapshot rather than
  // refusing on a guess. The comparison is on the redacted basename because that
  // is all DiagnosticContext carries; a same-named file in another directory is
  // the residual false positive, and it errs toward not opening a diff.
  const liveText = (ctx: DiagnosticContext): string | undefined => {
    const doc = deps.window.activeTextEditor?.document;
    if (doc === undefined) return undefined;
    return redactPath(doc.fileName) === ctx.fileName ? doc.getText() : undefined;
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
      // fullText was captured when the code action was CREATED — before the
      // request went out. If the user edited the file while it was in flight,
      // both sides of the diff are stale: the left no longer matches the buffer,
      // and the splice offsets point at lines that have moved. Say so rather
      // than opening a diff that misrepresents the change.
      const live = liveText(context);
      if (live !== undefined && live !== fullText) {
        deps.log.debug("diagnostics: file changed while the fix was in flight; not diffing");
        void deps.window.showWarningMessage(
          `Nimbus: ${context.fileName} changed while the fix was being generated, so the diff would be misleading. Re-run the action.`,
        );
        return;
      }
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
    priorOccurrences: contain(
      "diagnosticPriorOccurrences",
      "find prior occurrences",
      async ({ query }) => {
        deps.search(query);
      },
    ),
  };
}
