import { randomUUID } from "node:crypto";

import * as vscode from "vscode";
import { toRelativeRef } from "../briefs/params.js";
import { errMsg, type Logger } from "../logging.js";
import type { GitApiLike } from "../scm/git-types.js";
import { createDebouncer, DEBOUNCE_MS } from "./debounce.js";
import { offersFor } from "./offers.js";
import { validateInbound } from "./protocol.js";
import { SIGNAL_CATALOG } from "./signals.js";
import {
  buildSnapshot,
  type DiagnosticSummary,
  type GitSummary,
  SELECTION_MAX_CHARS,
} from "./snapshot.js";

// Thin vscode-API glue — mirrors real-provider.ts and real-chat-panel.ts. Every
// decision (what the context is, which briefs fit, what may be executed) lives
// in the pure modules beside this file, which carry the tests.
//
// PR 1 re-collects on every event, with no debounce and no cache: both signals
// here are local reads. PR 2 introduces controller.ts when the Gateway-backed
// signals arrive and cost per collection starts to matter.

const VIEW_ID = "nimbus.contextView";

export function registerContextView(deps: {
  log: Logger;
  // Async and possibly absent: this is the same accessor the SCM trio takes —
  // the built-in git extension may not have activated yet.
  git: () => Promise<GitApiLike | undefined>;
}): vscode.Disposable {
  let generation = 0;
  let view: vscode.WebviewView | undefined;

  const gitSummary = async (): Promise<GitSummary | undefined> => {
    const repo = (await deps.git())?.repositories()[0];
    if (repo === undefined) return undefined;
    // changedPaths stays UNREAD in PR 1: filling it means an async changedFiles
    // call per collection, which belongs with PR 2's controller. Undefined, not
    // [], so gitSection renders no count row rather than claiming zero.
    return { branch: repo.branch(), changedPaths: undefined };
  };

  // Bound the READ, not just the stored value. Ctrl+A on a large file makes
  // getText(selection) copy the whole document before buildSnapshot clamps it to
  // 300 chars. Five lines is far more than the clamp can consume, and the slice
  // covers the one-enormous-line case (a minified bundle).
  const SELECTION_READ_LINES = 5;
  const selectionText = (editor: vscode.TextEditor): string => {
    const sel = editor.selection;
    if (sel.isEmpty) return "";
    const lastLine = Math.min(sel.end.line, sel.start.line + SELECTION_READ_LINES);
    const end = lastLine === sel.end.line ? sel.end : editor.document.lineAt(lastLine).range.end;
    return editor.document
      .getText(new vscode.Range(sel.start, end))
      .slice(0, SELECTION_MAX_CHARS * 2);
  };

  const diagnosticsFor = (uri: vscode.Uri): DiagnosticSummary[] =>
    vscode.languages.getDiagnostics(uri).map((d) => ({
      message: d.message,
      severity: d.severity,
      line: d.range.start.line,
    }));

  const collect = async (): Promise<void> => {
    if (view === undefined || !view.visible) return;
    generation += 1;
    const mine = generation;
    const editor = vscode.window.activeTextEditor;
    const roots = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    const git = await gitSummary();
    // A minimal fence: the git lookup is awaited, so a later collection can
    // overtake this one. PR 2 generalises this across all four signals.
    if (mine !== generation || view === undefined) return;
    const snapshot = buildSnapshot({
      generation: mine,
      ...(editor === undefined
        ? {}
        : {
            editor: {
              // Relative, never absolute: an absolute path names the user's home
              // directory, and this value is rendered.
              path: toRelativeRef(editor.document.fileName, roots),
              scheme: editor.document.uri.scheme,
              languageId: editor.document.languageId,
              line: editor.selection.active.line,
              selection: selectionText(editor),
              isDirty: editor.document.isDirty,
            },
          }),
      ...(git === undefined ? {} : { git }),
      ...(editor === undefined ? {} : { diagnostics: diagnosticsFor(editor.document.uri) }),
    });
    void view.webview.postMessage({
      type: "render",
      generation: mine,
      sections: SIGNAL_CATALOG.map((spec) => spec.collect(snapshot)),
      offers: offersFor(snapshot),
      isDirty: snapshot.isDirty,
    });
  };

  const recollect = (): void => {
    void collect().catch((e: unknown) =>
      deps.log.warn(`context panel collect failed: ${errMsg(e)}`),
    );
  };

  // One debouncer per event source, at the spec's tiers. Becoming visible and
  // the webview's ready handshake collect immediately: both are single events
  // the user is waiting on, not bursts.
  const onSelection = createDebouncer(DEBOUNCE_MS.selection, recollect);
  const onEditor = createDebouncer(DEBOUNCE_MS.editor, recollect);
  const onDiagnostics = createDebouncer(DEBOUNCE_MS.diagnostics, recollect);

  const provider: vscode.WebviewViewProvider = {
    resolveWebviewView(webviewView) {
      view = webviewView;
      const mediaRoot = vscode.Uri.joinPath(vscode.Uri.file(__dirname), "..", "media");
      webviewView.webview.options = { enableScripts: true, localResourceRoots: [mediaRoot] };
      webviewView.webview.html = renderHtml(webviewView.webview, mediaRoot);
      webviewView.webview.onDidReceiveMessage((raw: unknown) => {
        const result = validateInbound(raw);
        if (result.kind === "rejected") {
          deps.log.warn(`context panel refused a message: ${result.reason}`);
          return;
        }
        if (result.kind === "ready") {
          recollect();
          return;
        }
        void vscode.commands
          .executeCommand(result.command, ...result.args)
          .then(undefined, (e: unknown) => {
            deps.log.error(`context panel command failed: ${errMsg(e)}`);
          });
      });
      // Collection is suspended entirely while the view is hidden; becoming
      // visible collects once for the current context.
      webviewView.onDidChangeVisibility(() => recollect());
    },
  };

  return vscode.Disposable.from(
    vscode.window.registerWebviewViewProvider(VIEW_ID, provider),
    vscode.window.onDidChangeActiveTextEditor(() => onEditor.trigger()),
    vscode.window.onDidChangeTextEditorSelection(() => onSelection.trigger()),
    vscode.languages.onDidChangeDiagnostics(() => onDiagnostics.trigger()),
    // Save is a deliberate single act, not a burst — collect straight away.
    vscode.workspace.onDidSaveTextDocument(() => recollect()),
    { dispose: () => onSelection.dispose() },
    { dispose: () => onEditor.dispose() },
    { dispose: () => onDiagnostics.dispose() },
  );
}

function renderHtml(webview: vscode.Webview, mediaRoot: vscode.Uri): string {
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, "context.js"));
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, "context.css"));
  const nonce = randomUUID().replaceAll("-", "");
  const csp =
    `default-src 'none'; ` +
    `style-src ${webview.cspSource} 'unsafe-inline'; ` +
    `font-src ${webview.cspSource}; ` +
    `script-src 'nonce-${nonce}';`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<title>Nimbus Context</title>
<link rel="stylesheet" href="${styleUri.toString()}" />
</head>
<body>
<main id="root" aria-live="polite"></main>
<script nonce="${nonce}" src="${scriptUri.toString()}"></script>
</body>
</html>`;
}
