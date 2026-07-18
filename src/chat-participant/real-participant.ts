import * as vscode from "vscode";
import { errMsg, type Logger } from "../logging.js";
import { runParticipantTurn } from "./participant.js";
import type {
  AttachedFile,
  ChatResponseSink,
  ParticipantCommand,
  ParticipantDeps,
  ParticipantRequest,
} from "./participant-types.js";
import { readPriorSessionId, toResultMetadata } from "./session.js";

// Thin vscode-API glue — mirrors real-chat-panel.ts. Excluded from coverage; the
// pure handler (participant.ts) carries the logic and the tests.

const PARTICIPANT_ID = "nimbus-agent.nimbus";

function normalizeCommand(c: string | undefined): ParticipantCommand | undefined {
  return c === "explain" || c === "fix" || c === "test" ? c : undefined;
}

function readActiveSelection(): AttachedFile | undefined {
  const editor = vscode.window.activeTextEditor;
  if (editor === undefined) return undefined;
  const doc = editor.document;
  const code = editor.selection.isEmpty ? doc.getText() : doc.getText(editor.selection);
  return { path: doc.fileName, languageId: doc.languageId, code };
}

function refToUri(value: unknown): vscode.Uri | undefined {
  if (value instanceof vscode.Uri) return value;
  if (value instanceof vscode.Location) return value.uri;
  return undefined;
}

async function resolveReferences(
  refs: ReadonlyArray<vscode.ChatPromptReference>,
  log: Logger,
): Promise<AttachedFile[]> {
  const out: AttachedFile[] = [];
  for (const ref of refs) {
    const uri = refToUri(ref.value);
    if (uri === undefined) continue;
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      out.push({ path: doc.fileName, languageId: doc.languageId, code: doc.getText() });
    } catch (e) {
      log.warn(`participant: could not read reference ${uri.toString()}: ${errMsg(e)}`);
    }
  }
  return out;
}

async function adaptRequest(
  request: vscode.ChatRequest,
  context: vscode.ChatContext,
  log: Logger,
): Promise<ParticipantRequest> {
  const command = normalizeCommand(request.command);
  const priorSessionId = readPriorSessionId(context.history);
  const req: ParticipantRequest = { prompt: request.prompt, attachments: [] };
  if (priorSessionId !== undefined) req.priorSessionId = priorSessionId;
  if (command !== undefined) {
    req.command = command;
    const sel = readActiveSelection();
    if (sel !== undefined) req.selection = sel;
  } else {
    // By design (spec decision #5): slash commands read the active selection; only
    // free-form turns pull in #file references. A slash command issued with #file
    // refs intentionally ignores them.
    req.attachments = await resolveReferences(request.references, log);
  }
  return req;
}

// canonicalUrl may be a scheme URL (https://…) or a bare local path.
function targetToUri(target: string): vscode.Uri {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(target)
    ? vscode.Uri.parse(target)
    : vscode.Uri.file(target);
}

function adaptSink(response: vscode.ChatResponseStream): ChatResponseSink {
  return {
    markdown: (t) => response.markdown(t),
    progress: (t) => response.progress(t),
    citation: (c) => response.anchor(targetToUri(c.target), c.label),
    button: (title, command, args) => response.button({ title, command, arguments: args ?? [] }),
  };
}

export function registerNimbusChatParticipant(opts: { deps: ParticipantDeps; log: Logger }): {
  dispose(): void;
} {
  const handler: vscode.ChatRequestHandler = async (request, context, response, token) => {
    try {
      const req = await adaptRequest(request, context, opts.log);
      const sink = adaptSink(response);
      const cancel = {
        get isCancelled(): boolean {
          return token.isCancellationRequested;
        },
        // Return the vscode.Disposable so runParticipantTurn can dispose it — the
        // token outlives a normally-completing turn, so an undisposed listener leaks.
        onCancelled: (cb: () => void): { dispose(): void } => token.onCancellationRequested(cb),
      };
      const result = await runParticipantTurn(req, opts.deps, sink, cancel);
      return { metadata: toResultMetadata(result.sessionId) };
    } catch (e) {
      opts.log.error(`participant: unhandled error handling request: ${errMsg(e)}`);
      response.markdown("Nimbus ran into an unexpected problem handling that request.");
      return { metadata: {} };
    }
  };
  return vscode.chat.createChatParticipant(PARTICIPANT_ID, handler);
}
